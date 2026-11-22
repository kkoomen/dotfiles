/**
 * Memory — the injection half of the self-learning loop.
 *
 * The loop is: mine the run corpus (`bin/memory-mine`), let `/retro` turn one task's failures into
 * candidates, gate them through `bin/memory-promote`, and then inject a small, selective subset at
 * the start of a turn so the next route does not re-learn the same lesson at full price.
 *
 * Three properties are non-negotiable, because this runs inside the agent loop:
 *
 * 1. It never throws into the loop. Every handler is wrapped, and a missing, unreadable, or malformed
 *    memory file degrades to "inject nothing". `bin/memory-lint` is what reports a broken file; a
 *    broken file must not break a turn.
 * 2. It never exceeds the budget. At most 5 entries and 1200 characters of rendered text
 *    (`selectEntries` in `bin/lib/memory.mjs` enforces both), and when nothing matches, no message is
 *    added at all — a memory banner on every prompt is noise that trains the model to ignore it.
 * 3. It is selective. An entry is a candidate only when its scope glob matches the cwd or a file the
 *    prompt actually names, which is also what stops global memory from being injected into every
 *    unrelated project. Global entries get no exception.
 *
 * Two tools let the model record and retract a lesson without a route:
 *
 *   memory_add     append one entry to `<repo>/.pi/memory.md` or, with explicit user confirmation,
 *                  `~/.pi/agent/memory/global.md`
 *   memory_forget  remove one entry by id or claim from either file
 *
 * Both resolve their target through `classifyMemoryPath`, so a hallucinated path is refused rather
 * than written. That is the whole confinement rule: two files, no others.
 *
 * The other half of the loop runs at `agent_settled`: a finished task that produced a failing record
 * teaches the project's memory by itself, with no `/retro` and no approval step. Why that event and
 * why the task id is assembled the way it is:
 *
 * 1. **`agent_settled`, not `agent_end`.** `agent_end` closes one low-level run and can still be
 *    followed by retries, compaction recovery, and queued continuations; `agent_settled` is the
 *    first point where no further automatic work is coming, so it is the first point at which "this
 *    task is over and its records are final" is true. It is notification-only, which suits this: the
 *    handler reads local files and writes a memory entry, and never asks the loop for anything.
 * 2. **The task id is not handed to the extension at settle.** The launcher's contract lives in the
 *    child process, and `runs/*\/record.json` carries `contract.taskId` but no index points at it.
 *    So the handler collects the `RUN_RECORD:` paths the subagent tool results name during the run
 *    (`tool_result`), reads each record's `contract.taskId`, and — when no dispatch happened in this
 *    session — falls back to the route ledger `<repo>/.pi/state/*.json`, whose `taskId` field is the
 *    only other place the id is written down. `bin/lib/memory-learn.mjs` then reads the task's
 *    failing records from its ledger and the records just observed.
 * 3. **Nothing here can affect the loop.** Every read is bounded, every branch is wrapped, and a
 *    failure returns without a message, without a retry, and without an error. `memory-learn` is
 *    also idempotent per task under `~/.pi/agent/memory/auto/<taskId>.json`, so a resumed or replayed
 *    settle cannot learn the same task twice.
 *
 * No model call and no network happen anywhere in that path.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import {
  INJECT_LIMIT,
  INJECT_MAX_CHARS,
  MAX_LINES,
  appendEntry,
  atomicWrite,
  classifyMemoryPath,
  entryId,
  findSecrets,
  memoryFileForTarget,
  memoryPaths,
  normalizeClaim,
  promptFiles,
  readAllEntries,
  readMemoryFile,
  recordUsage,
  requiresConfirmation,
  scopeErrors,
  selectEntries,
} from "../bin/lib/memory.mjs";
import { settleLearning } from "../bin/lib/memory-learn.mjs";

/** The message the injected block carries. `display: false` keeps it out of the transcript. */
const CUSTOM_TYPE = "memory";

/**
 * Stage record paths this session's dispatches reported, collected from `RUN_RECORD:` lines and from
 * the truncation note the subagent tool adds when a preview is cut. Both name the same file, and that
 * file is where `contract.taskId` — and therefore the finished task — is written down.
 */
const STAGE_RECORD = /(\/[^\s"'`]*\/runs\/stage-[A-Za-z0-9_-]+\/record\.json)/g;
const MAX_OBSERVED_RECORDS = 60;

/**
 * True for a subagent child process: an RPC child with one of the session flags the subagent
 * extension always passes. Kept in step with `extensions/notify.ts`, which owns the same predicate
 * for its chime. A child settles too, and must not mark a task learned before the parent can see the
 * rest of that route's records.
 */
const isSubagentChild = (argv: readonly string[]): boolean => {
  let rpcMode = false;
  let childSession = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode=rpc") rpcMode = true;
    else if (arg === "--mode" && argv[index + 1] === "rpc") rpcMode = true;
    else if (arg === "--no-session") childSession = true;
    else if (arg.startsWith("--session-dir") || arg.startsWith("--session-id")) childSession = true;
  }
  return rpcMode && childSession;
};

/** The working directory the turn runs in; a context without one falls back to the process cwd. */
const workingDirectory = (ctx: ExtensionContext | undefined): string => {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd) return ctx.cwd;
  return process.cwd();
};

/** Usable evidence: every path a model passed must resolve, relative to the repo. */
const resolveEvidence = (values: string[], cwd: string) => {
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const value of values) {
    const absolute = value.startsWith("/") ? value : `${cwd}/${value}`;
    try {
      // A cited source file is as good as a cited record: the claim still points somewhere real.
      if (statSync(absolute).isFile()) resolved.push(absolute);
      else missing.push(value);
    } catch {
      missing.push(value);
    }
  }
  return { resolved, missing };
};

export default function memoryExtension(pi: ExtensionAPI) {
  const observedRecords: string[] = [];

  // The run's own records are only reachable through what its dispatches printed, so collect the
  // paths as they pass; reading each record can wait until settle.
  pi.on("tool_result", (event) => {
    try {
      const parts: string[] = [];
      const content = (event as { content?: unknown }).content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          const text = block && typeof block === "object" ? (block as { text?: unknown }).text : null;
          if (typeof text === "string") parts.push(text);
        }
      }
      for (const part of parts) {
        for (const match of part.matchAll(STAGE_RECORD)) {
          if (observedRecords.length >= MAX_OBSERVED_RECORDS) return undefined;
          if (!observedRecords.includes(match[1])) observedRecords.push(match[1]);
        }
      }
    } catch {
      /* a result that cannot be scanned names no record */
    }
    return undefined;
  });

  /**
   * The automatic learning pass, at the first point where no further automatic work is coming. A
   * child process settles too and skips: the parent, not the child, can see the whole route. Every
   * branch is wrapped, because a bookkeeping miss must never become a failed turn.
   */
  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (isSubagentChild(process.argv)) return undefined;
      const cwd = workingDirectory(ctx);
      const recordPaths = [...observedRecords];
      observedRecords.length = 0;
      try {
        // `settleLearning` is idempotent per task under ~/.pi/agent/memory/auto/<taskId>.json, so a
        // repeated or replayed settle costs a marker read and learns nothing twice.
        settleLearning({ cwd, recordPaths });
      } catch {
        /* learning is an optimisation: it must never fail a turn */
      }
    } catch {
      /* silent by design */
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // A run started by a custom message has no prompt to match against.
      if (event.messageType && event.messageType !== "user") return undefined;
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      if (!prompt.trim()) return undefined;

      const cwd = workingDirectory(ctx);
      const files = promptFiles(prompt, cwd);
      const paths = memoryPaths({ repo: cwd });
      const entries = readAllEntries({ repo: cwd, home: paths.home });
      if (!entries.length) return undefined;

      const selection = selectEntries({
        entries,
        cwd,
        repo: cwd,
        prompt,
        files,
        limit: INJECT_LIMIT,
        maxChars: INJECT_MAX_CHARS,
      });
      if (!selection.selected.length || !selection.text) return undefined;
      if (selection.text.length > INJECT_MAX_CHARS) return undefined;

      // Usage bookkeeping is best-effort and must never fail a turn or exceed the budget.
      try {
        recordUsage(paths.indexPath, selection.selected.map((candidate) => candidate.entry));
      } catch {
        /* prune falls back to `created` when usage was never recorded */
      }

      return {
        message: {
          customType: CUSTOM_TYPE,
          content: selection.text,
          display: false,
        },
      };
    } catch {
      return undefined;
    }
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description:
      "Append one durable, evidence-cited lesson to this project's memory file (.pi/memory.md), or to the global memory file with user confirmation. Refused when the evidence does not resolve, the claim already exists, or the file is at its line cap.",
    promptSnippet: "Record a durable lesson with cited evidence in the memory file",
    promptGuidelines: [
      "Use memory_add only for a lesson that will change a future task's behavior, never for task status or narration.",
      "Use memory_add with evidence set to the run-record or source-file paths that prove the claim; a claim without a resolving citation is refused.",
    ],
    parameters: Type.Object({
      claim: Type.String({ description: "One imperative sentence; what to do or avoid next time." }),
      evidence: Type.String({ description: "Comma-separated paths that prove the claim (run record or source file)." }),
      scope: Type.String({ description: "Comma-separated glob list, e.g. **/OverlayController.kt or apps/web/**." }),
      target: Type.Optional(Type.String({ description: "project (default) or global. Global requires a user confirmation." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        const cwd = workingDirectory(ctx);
        const paths = memoryPaths({ repo: cwd });
        const target = params.target === "global" ? "global" : "project";
        const claim = String(params.claim ?? "").replace(/\s+/g, " ").trim();
        const scope = String(params.scope ?? "").trim();
        const evidence = String(params.evidence ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

        const refuse = (reason: string) => ({
          content: [{ type: "text" as const, text: `memory_add refused: ${reason}` }],
          details: { ok: false, reason },
        });

        if (!claim) return refuse("a claim is required");
        if (!scope) return refuse("a scope glob is required; without one the entry could never be selected");
        if (!evidence.length) return refuse("evidence is required; an uncited claim is a rumour");
        const secret = findSecrets(`${claim} ${scope}`);
        if (secret.length) return refuse(`the claim or scope looks like it carries a secret (${secret.join(", ")})`);
        const globs = scopeErrors(scope);
        if (globs.length) return refuse(`invalid scope glob: ${globs.map((entry: { glob: string; error: string }) => `${entry.glob} (${entry.error})`).join(", ")}`);

        const { resolved, missing } = resolveEvidence(evidence, cwd);
        if (missing.length) return refuse(`evidence does not resolve: ${missing.join(", ")}`);

        const file = memoryFileForTarget(target, { repo: cwd });
        if (!file) return refuse(`unknown target ${String(params.target)}`);
        const located = classifyMemoryPath(file, { repo: cwd });
        if (!located) return refuse(`refusing to write outside the two memory files (${file})`);

        if (requiresConfirmation(located.kind)) {
          const confirmed = await ctx.ui.confirm(
            "Add this to global memory?",
            `${claim}\n\nGlobal memory is injected into every project.`,
          );
          if (!confirmed) {
            return {
              content: [{ type: "text" as const, text: "memory_add cancelled: global memory requires confirmation." }],
              details: { ok: false, reason: "not confirmed" },
            };
          }
        }

        const existing = readMemoryFile(file, { origin: target, repo: cwd });
        const seen = existing.entries.find((entry: { claim: string }) => normalizeClaim(entry.claim) === normalizeClaim(claim));
        if (seen) return refuse(`${file} already carries this claim at line ${seen.line}`);

        const created = new Date().toISOString().slice(0, 10);
        const entry = { claim, evidence: resolved, scope, created, hits: 1 };
        const appended = appendEntry(existing.text, entry, { maxLines: MAX_LINES });
        if (appended.error) return refuse(`${file}: ${appended.error}`);

        atomicWrite(file, appended.text);
        return {
          content: [{ type: "text" as const, text: `Added ${entryId(entry)} to ${file} (${existing.lines + 1}/${MAX_LINES} lines).` }],
          details: { ok: true, id: entryId(entry), file, entries: existing.entries.length + 1 },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `memory_add failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { ok: false },
        };
      }
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Remove one memory entry, by id or by claim, from this project's memory file or the global memory file. Refuses any path outside those two files.",
    promptSnippet: "Remove a memory entry that is wrong or obsolete",
    promptGuidelines: ["Use memory_forget when a memory entry is wrong, obsolete, or was injected and caused a bad decision."],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Entry id (12 hex chars) as printed by memory_add or memory-lint --explain." })),
      claim: Type.Optional(Type.String({ description: "Exact or normalized claim text, when the id is unknown." })),
      target: Type.Optional(Type.String({ description: "project (default) or global." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        const cwd = workingDirectory(ctx);
        const paths = memoryPaths({ repo: cwd });
        const target = params.target === "global" ? "global" : params.target === "project" ? "project" : null;
        const id = params.id ? String(params.id).trim() : "";
        const claim = params.claim ? normalizeClaim(String(params.claim)) : "";
        const refuse = (reason: string) => ({
          content: [{ type: "text" as const, text: `memory_forget refused: ${reason}` }],
          details: { ok: false, reason },
        });
        if (!id && !claim) return refuse("pass an id or a claim; nothing is removed implicitly");

        const candidates = target
          ? [memoryFileForTarget(target, { repo: cwd })]
          : [paths.projectFile, paths.globalFile];

        for (const candidate of candidates) {
          if (!candidate) continue;
          const located = classifyMemoryPath(candidate, { repo: cwd });
          if (!located) return refuse(`refusing to touch a path outside the two memory files (${candidate})`);
          const existing = readMemoryFile(candidate, { origin: located.kind, repo: cwd });
          const match = existing.entries.find(
            (entry: { id: string; claim: string }) => (id && entry.id === id) || (claim && normalizeClaim(entry.claim) === claim),
          );
          if (!match) continue;

          // A removal is a write: the global file is injected into every project, so retracting an
          // entry from it needs the same explicit confirmation as adding one. A declined
          // confirmation is a refusal, never a silent success.
          if (requiresConfirmation(located.kind)) {
            const confirmed = await ctx.ui.confirm(
              "Remove this from global memory?",
              `${match.claim}\n\nGlobal memory is injected into every project.`,
            );
            if (!confirmed) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `memory_forget cancelled: ${match.id} is in global memory and removal requires confirmation.`,
                  },
                ],
                details: { ok: false, reason: "not confirmed", id: match.id, file: candidate, kind: located.kind },
              };
            }
          }

          const lines = existing.text.split("\n");
          const kept = lines.filter((_line: string, index: number) => index + 1 !== match.line);
          const next = kept.join("\n");
          atomicWrite(candidate, next.endsWith("\n") || !next ? next : `${next}\n`);
          return {
            content: [{ type: "text" as const, text: `Removed ${match.id} from ${candidate}: ${match.claim}` }],
            details: { ok: true, id: match.id, file: candidate, entries: existing.entries.length - 1 },
          };
        }

        return refuse(id ? `no entry with id ${id}` : `no entry with that claim`);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `memory_forget failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { ok: false },
        };
      }
    },
  });
}
