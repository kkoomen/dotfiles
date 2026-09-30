/**
 * Context Guard — automated token/context economiser for agentic sessions.
 *
 * Tuned for large monorepos by default (e.g. a furemu-sized repo). Thresholds
 * are deliberately generous: they stop runaway whole-repo reads and full-file
 * re-emissions, not normal work on big files. Lower them per project if wanted.
 *
 * Three structural rules, enforced mechanically (not by model discipline):
 *
 * 1. Read clamp: a `read` call may not pull more than `readMaxLines` lines in
 *    one shot. Oversized limits are clamped in place and the model is told to
 *    continue from the next offset.
 *
 * 2. Write guard: `write` (a full overwrite) is blocked for existing files
 *    larger than `writeExistingMaxLines` lines, redirecting to `edit`.
 *
 * 3. Subagent result cap: stage reports injected back into the parent context
 *    are capped at `subagentMaxBytes` while preserving the `RUN_RECORD` pointer.
 *    When the report is JSON, the cap is *structure-preserving*: findings,
 *    unresolved items, requirement states, and files are always kept, and only
 *    verbose `evidence` / `checks[].log` / `summary` text is shortened. Full
 *    text is always on disk at `RUN_RECORD`.
 *
 * It also acts as a per-stage budget watchdog: after every `subagent` call it
 * reads the run record's `usage`, totals the session, and appends an explicit
 * over-budget warning the orchestrator cannot miss.
 *
 * Configuration, in increasing precedence:
 *   1. DEFAULTS below (large-monorepo profile)
 *   2. `~/.pi/agent/context-guard.json`            (global)
 *   3. `<project>/.pi/context-guard.json`          (per project)
 *   4. `PI_GUARD_*` environment variables          (session only, never saved)
 *
 * Use `/context-guard` to inspect the resolved config and session totals;
 * `/context-guard on|off|reset` edits the global file. Set `enabled: false`
 * (or `PI_GUARD_ENABLED=0`) to disable for a project.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface GuardConfig {
  enabled: boolean;
  readMaxLines: number;
  writeExistingMaxLines: number;
  subagentMaxBytes: number;
  stageTokenBudget: number;
  stageTurnBudget: number;
  warnOnly: boolean;
}

interface ClampedRead {
  path: string;
  requested: number | "default";
  applied: number;
}

interface StageUse {
  agent: string;
  taskId?: string;
  tokens: number;
  turns: number;
  cost: number;
  recordPath?: string;
  at: number;
  overBudget: boolean;
}

/**
 * Large-monorepo profile. Budgets sit above the observed healthy averages for
 * the heaviest stages on a furemu-sized repo (build ~7M/54 turns, test
 * ~2.7M/36, orchestrator ~3.6M/41), so a normal stage passes and only a
 * runaway is called out.
 */
const DEFAULTS: GuardConfig = {
  enabled: true,
  readMaxLines: 600,
  writeExistingMaxLines: 1200,
  subagentMaxBytes: 32 * 1024,
  stageTokenBudget: 15_000_000,
  stageTurnBudget: 80,
  // warnOnly=true never blocks (the write guard becomes advisory); false enforces.
  warnOnly: false,
};

const GLOBAL_CONFIG_PATH = join(getAgentDir(), "context-guard.json");

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|on|yes)$/i.test(v.trim());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function readFileConfig(path: string): Partial<GuardConfig> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GuardConfig>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Env overrides are session-only and win over every file. */
function applyEnv(config: GuardConfig): GuardConfig {
  return {
    enabled: envBool("PI_GUARD_ENABLED", config.enabled),
    readMaxLines: envInt("PI_GUARD_READ_MAX_LINES", config.readMaxLines),
    writeExistingMaxLines: envInt(
      "PI_GUARD_WRITE_EXISTING_MAX_LINES",
      config.writeExistingMaxLines,
    ),
    subagentMaxBytes: envInt("PI_GUARD_SUBAGENT_MAX_BYTES", config.subagentMaxBytes),
    stageTokenBudget: envInt("PI_GUARD_STAGE_TOKEN_BUDGET", config.stageTokenBudget),
    stageTurnBudget: envInt("PI_GUARD_STAGE_TURN_BUDGET", config.stageTurnBudget),
    warnOnly: envBool("PI_GUARD_WARN_ONLY", config.warnOnly),
  };
}

function countLines(path: string): number | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    if (text.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
    return lines;
  } catch {
    return undefined;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function extractText(content: ToolResultEvent["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

const RUN_RECORD_RE = /^RUN_RECORD: (.+)$/m;

function readRecordUsage(recordPath: string): StageUse | undefined {
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      agent?: string;
      contract?: { taskId?: string };
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: number;
        turns?: number;
      };
    };
    const u = record.usage ?? {};
    const tokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    return {
      agent: record.agent ?? "unknown",
      taskId: record.contract?.taskId,
      tokens,
      turns: u.turns ?? 0,
      cost: u.cost ?? 0,
      recordPath,
      at: Date.now(),
      overBudget: false,
    };
  } catch {
    return undefined;
  }
}

function trimStr(value: unknown, max: number): unknown {
  return typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : value;
}

interface ParsedReport {
  value: Record<string, unknown>;
  fenced: boolean;
}

function parseJsonReport(text: string): ParsedReport | undefined {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const jsonText = (match ? match[1] : trimmed).trim();
  if (!jsonText.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(jsonText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return { value: value as Record<string, unknown>, fenced: Boolean(match) };
  } catch {
    return undefined;
  }
}

/**
 * Shorten a JSON stage report without dropping its actionable content.
 *
 * Findings, `unresolved`, requirement `state`s, `files`, and statuses are kept
 * intact; only verbose `evidence`, `checks[].log`, `summary`, and (as a last
 * resort) long finding prose are trimmed. Returns undefined when the body is
 * not JSON, or when shedding would not actually shrink it.
 */
function shedReport(body: string, maxBytes: number): string | undefined {
  const parsed = parseJsonReport(body);
  if (!parsed) return undefined;
  const report = parsed.value;
  const requirements = Array.isArray(report.requirements)
    ? (report.requirements as Record<string, unknown>[])
    : [];
  const checks = Array.isArray(report.checks) ? (report.checks as Record<string, unknown>[]) : [];
  const findings = Array.isArray(report.findings)
    ? (report.findings as Record<string, unknown>[])
    : [];

  const pass = (limits: { evidence: number; log: number; summary: number; finding: number }) => {
    if (typeof report.summary === "string" && report.summary.length > limits.summary) {
      report.summary = trimStr(report.summary, limits.summary);
    }
    for (const requirement of requirements) {
      if (Array.isArray(requirement.evidence)) {
        requirement.evidence = requirement.evidence.map((entry) =>
          typeof entry === "string" ? trimStr(entry, limits.evidence) : entry,
        );
      }
    }
    for (const check of checks) {
      if (typeof check.log === "string" && check.log.length > limits.log) {
        check.log = trimStr(check.log, limits.log);
      }
    }
    for (const finding of findings) {
      for (const key of ["message", "failureScenario", "failure", "detail", "correction", "fix"]) {
        if (typeof finding[key] === "string" && (finding[key] as string).length > limits.finding) {
          finding[key] = trimStr(finding[key], limits.finding);
        }
      }
    }
  };

  const serialize = (): string => {
    const json = JSON.stringify(report);
    return parsed.fenced ? "```json\n" + json + "\n```" : json;
  };

  // Pass 1: trim only verbose evidence/log/summary; findings untouched.
  pass({ evidence: 300, log: 300, summary: 2000, finding: Number.MAX_SAFE_INTEGER });
  let out = serialize();

  // Pass 2: trim harder, now including long finding prose.
  if (byteLength(out) > maxBytes) {
    pass({ evidence: 150, log: 150, summary: 800, finding: 500 });
    out = serialize();
  }

  // Pass 3: keep every requirement/check/finding entry, but drop evidence bulk
  // and shorten log tails. Actionable fields (states, findings, unresolved,
  // files) are still preserved.
  if (byteLength(out) > maxBytes) {
    for (const requirement of requirements) {
      if (Array.isArray(requirement.evidence)) requirement.evidence = requirement.evidence.slice(0, 2);
    }
    for (const check of checks) {
      if (typeof check.log === "string") check.log = trimStr(check.log, 100);
    }
    out = serialize();
  }

  if (byteLength(out) >= byteLength(body)) return undefined;
  return out;
}

export default function (pi: ExtensionAPI) {
  const configCache = new Map<string, GuardConfig>();
  const clamped = new Map<string, ClampedRead>();
  const sessionStages: StageUse[] = [];

  function configFor(cwd: string): GuardConfig {
    const cached = configCache.get(cwd);
    if (cached) return cached;
    const global = readFileConfig(GLOBAL_CONFIG_PATH);
    const project = readFileConfig(join(cwd, ".pi", "context-guard.json"));
    const merged = applyEnv({ ...DEFAULTS, ...global, ...project });
    configCache.set(cwd, merged);
    return merged;
  }

  pi.on("session_start", async () => {
    configCache.clear(); // re-read files in case they changed between sessions
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const config = configFor(ctx.cwd);
    if (!config.enabled) return undefined;

    if (event.toolName === "read") {
      const input = event.input as { path?: string; offset?: number; limit?: number };
      const requested = typeof input.limit === "number" ? input.limit : "default";
      if (requested === "default" || requested > config.readMaxLines) {
        input.limit = config.readMaxLines;
        clamped.set(event.toolCallId, {
          path: input.path ?? "(unknown)",
          requested,
          applied: config.readMaxLines,
        });
      }
      return undefined;
    }

    if (event.toolName === "write" && config.writeExistingMaxLines > 0) {
      const input = event.input as { path?: string };
      if (!input.path) return undefined;
      const absolute = resolve(ctx.cwd, input.path);
      if (!existsSync(absolute)) return undefined; // new file: allowed
      const lines = countLines(absolute);
      if (lines !== undefined && lines > config.writeExistingMaxLines) {
        const reason =
          `context-guard: refusing a full overwrite of ${input.path} (${lines} lines; ` +
          `limit ${config.writeExistingMaxLines}). Split the change into targeted ` +
          `\`edit\` operations instead of re-emitting the whole file. A genuine ` +
          `large rewrite requires PI_GUARD_WRITE_EXISTING_MAX_LINES raised (or 0).`;
        if (config.warnOnly) {
          if (ctx.hasUI) ctx.ui.notify(reason, "warning");
          return undefined;
        }
        return { block: true, reason };
      }
    }

    return undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const config = configFor(ctx.cwd);
    if (!config.enabled) return undefined;

    if (event.toolName === "read") {
      const note = clamped.get(event.toolCallId);
      if (!note) return undefined;
      clamped.delete(event.toolCallId);
      const text = extractText(event.content);
      const suffix =
        `\n\n[context-guard: limit clamped to ${note.applied} lines (requested ${note.requested}) ` +
        `for ${note.path}. Continue with a higher offset if you need more.]`;
      return { content: [{ type: "text" as const, text: `${text}${suffix}` }] };
    }

    if (event.toolName !== "subagent") return undefined;

    const text = extractText(event.content);
    if (!text) return undefined;

    const recordMatch = RUN_RECORD_RE.exec(text);
    const recordPath = recordMatch?.[1]?.trim();
    const recordLine = recordMatch ? `\nRUN_RECORD: ${recordPath}` : "";
    const body = recordLine ? text.slice(0, text.length - recordLine.length).trimEnd() : text;

    let out = body;
    let capNote = "";
    if (byteLength(out) > config.subagentMaxBytes) {
      const shed = shedReport(out, config.subagentMaxBytes);
      if (shed) {
        out = shed;
        const capLabel =
          config.subagentMaxBytes >= 1024
            ? `${(config.subagentMaxBytes / 1024).toFixed(config.subagentMaxBytes % 1024 === 0 ? 0 : 1)} KB`
            : `${config.subagentMaxBytes} B`;
        capNote =
          `\n\n[context-guard: report condensed to ${capLabel} ` +
          `— findings, unresolved items, requirement states, and files are preserved; verbose ` +
          `evidence/logs were shortened. Full report: ${recordPath ?? "RUN_RECORD above"}.]`;
      } else {
        let cut = config.subagentMaxBytes;
        while (cut > 0 && byteLength(out.slice(0, cut)) > config.subagentMaxBytes) cut--;
        const omitted = byteLength(out) - byteLength(out.slice(0, cut));
        out = out.slice(0, cut);
        capNote =
          `\n\n[context-guard: ${omitted} bytes omitted. Read the full stage report: ` +
          `${recordPath ?? "RUN_RECORD above"}. Do not infer completeness from this preview.]`;
      }
    }

    const usage = recordPath ? readRecordUsage(recordPath) : undefined;
    let budgetNote = "";
    if (usage) {
      usage.overBudget =
        usage.tokens > config.stageTokenBudget || usage.turns > config.stageTurnBudget;
      sessionStages.push(usage);
      if (usage.overBudget) {
        budgetNote =
          `\n⚠ context-guard: stage ${usage.agent} used ${usage.tokens.toLocaleString()} tokens ` +
          `across ${usage.turns} turns (budget ${config.stageTokenBudget.toLocaleString()} tokens / ` +
          `${config.stageTurnBudget} turns). Before the next stage: prefer offsets over full reads, ` +
          `pass the diff + record paths instead of pasting reports, and /compact if context is high.`;
      }
    }

    if (!capNote && !budgetNote) return undefined;

    const result: { content: { type: "text"; text: string }[]; structuredContent?: unknown } = {
      content: [{ type: "text", text: `${out}${recordLine}${capNote}${budgetNote}` }],
    };
    if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
    return result;
  });

  pi.registerCommand("context-guard", {
    description: "Show context-guard settings, per-stage budget status, and session totals",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off" || sub === "reset") {
        const global = readFileConfig(GLOBAL_CONFIG_PATH);
        const next: Partial<GuardConfig> =
          sub === "reset" ? { ...DEFAULTS } : { ...global, enabled: sub === "on" };
        writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        configCache.clear();
        const project = join(ctx.cwd, ".pi", "context-guard.json");
        const override = existsSync(project)
          ? `\nNote: ${project} exists and takes precedence over the global file.`
          : "";
        ctx.ui.notify(`context-guard global config set: ${sub}.${override}`, "info");
        return;
      }

      const config = configFor(ctx.cwd);
      const totalTokens = sessionStages.reduce((n, s) => n + s.tokens, 0);
      const totalCost = sessionStages.reduce((n, s) => n + s.cost, 0);
      const totalTurns = sessionStages.reduce((n, s) => n + s.turns, 0);
      const over = sessionStages.filter((s) => s.overBudget);
      const projectPath = join(ctx.cwd, ".pi", "context-guard.json");
      const lines = [
        `context-guard: ${config.enabled ? "enabled" : "disabled"} (large-monorepo profile)`,
        `  readMaxLines=${config.readMaxLines}  writeExistingMaxLines=${config.writeExistingMaxLines}  warnOnly=${config.warnOnly}`,
        `  subagentMaxBytes=${config.subagentMaxBytes}  stageTokenBudget=${config.stageTokenBudget.toLocaleString()}  stageTurnBudget=${config.stageTurnBudget}`,
        `  global: ${GLOBAL_CONFIG_PATH}${existsSync(GLOBAL_CONFIG_PATH) ? "" : " (absent)"}`,
        `  project: ${projectPath}${existsSync(projectPath) ? "" : " (absent)"}`,
        `  env overrides apply last; see PI_GUARD_*`,
        "",
        `This session: ${sessionStages.length} stages, ${totalTokens.toLocaleString()} tokens, ${totalTurns} turns, $${totalCost.toFixed(4)}`,
      ];
      if (over.length > 0) {
        lines.push(`  over budget: ${over.length}`);
        for (const s of over) {
          lines.push(`    ${s.agent}: ${s.tokens.toLocaleString()} tokens / ${s.turns} turns`);
        }
      }
      ctx.ui.notify(lines.join("\n"), over.length > 0 ? "warning" : "info");
    },
  });
}
