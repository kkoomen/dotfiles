import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

/**
 * Quiet transcript — display-only. Does NOT change what the model does or says.
 *
 * Replaces the built-in rendering of every tool (bash, read, edit, write, grep,
 * find, ls) with one row per call:
 *
 *     ⠸ bash $ sed -n '1,20p' src/main.ts
 *     ✓ bash $ sed -n '1,20p' src/main.ts
 *
 * The marker walks the run-timer spinner while the tool runs and settles on a
 * green check when it succeeds or a red cross when it errors (non-zero exit
 * code, tool failure, cancellation). The preview after the tool name is always
 * exactly one line: newlines, tabs and runs of whitespace collapse to single
 * spaces, and the whole row is truncated to the terminal width, so a multi-line
 * command can never break the row.
 *
 * Clicking a row expands it: the whole command on one or more wrapped lines,
 * untruncated, then that command's output below it. A command that produced no
 * output says so in italic muted text instead of leaving a blank gap. Clicking
 * again collapses it; ctrl+h does the same for the most recent call. While a
 * tool is still streaming, expanding it shows its live partial output.
 *
 * On startup/resume, the last tool call in the restored transcript is revealed
 * automatically so the session picks up where it left off.
 *
 * Execution is 100% delegated to the built-in implementations, so behavior and
 * session history are unchanged.
 */

const CWD = process.cwd();

/** Longest argument preview kept, before width truncation. */
const PREVIEW_MAX = 72;

/**
 * Spinner frames and cadence: the same dot spinner and 100ms tick the subagent
 * extension's run timer uses, so every animated row in the session matches.
 */
const SPINNER_FRAMES = ["⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸"];
const SPINNER_INTERVAL_MS = 100;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Collapse any text to a single line: every run of whitespace (newlines, tabs,
 * CR, indentation) becomes one space. Keeps a multi-line bash command or a path
 * with odd whitespace from ever adding a line to the row.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Current spinner frame, derived from the clock so parallel rows stay in sync. */
function spinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
}

/** One-line summary of a tool call's arguments. */
function summarizeCall(name: string, args: any): string {
  switch (name) {
    case "bash":
      return args?.command ? `$ ${args.command}` : "";
    case "read":
      return args?.path ?? "";
    case "edit": {
      const n = args?.edits?.length ?? 0;
      return `${args?.path ?? ""} (${n} edit${n === 1 ? "" : "s"})`;
    }
    case "write":
      return args?.path ?? "";
    case "grep": {
      let s = args?.pattern ?? "";
      if (args?.path) s += ` in ${args.path}`;
      return s;
    }
    case "find": {
      let s = args?.pattern ?? "";
      if (args?.path) s += ` in ${args.path}`;
      return s;
    }
    case "ls":
      return args?.path ?? ".";
    default:
      return "";
  }
}

/** All text content of a tool result, for the expanded view. */
function resultText(content: any): string {
  return (content ?? [])
    .map((c: any) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * One tool row: a header that is a single visual line when collapsed and wraps
 * when expanded, plus the body lines of the expanded view.
 */
class ToolRow implements Component {
  constructor(
    private readonly head: string,
    private readonly body: string[],
    private readonly wrapHead: boolean,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.wrapHead
      ? wrapTextWithAnsi(this.head, safeWidth)
      : [truncateToWidth(this.head, safeWidth, "…")];
    for (const line of this.body) {
      lines.push(...wrapTextWithAnsi(line, safeWidth));
    }
    return lines;
  }

  invalidate(): void {
    // Nothing cached: the row is built from scratch on every render.
  }
}

const builtinDefinitions: ToolDefinition<any, any, any>[] = [
  createBashToolDefinition(CWD),
  createReadToolDefinition(CWD),
  createEditToolDefinition(CWD),
  createWriteToolDefinition(CWD),
  createGrepToolDefinition(CWD),
  createFindToolDefinition(CWD),
  createLsToolDefinition(CWD),
];

export default function (pi: ExtensionAPI): void {
  /** Most recent tool call, targeted by ctrl+h. */
  let activeCallId: string | null = null;

  /** Tool calls whose output is currently shown. */
  const expanded = new Set<string>();

  // Set on startup/resume until the last restored tool row has been revealed.
  let pendingStartupToolCallId: string | null = null;

  /** Per-row invalidators, so a click or reveal can force a re-render. */
  const rowInvalidates = new Map<string, () => void>();
  const MAX_TRACKED_ROWS = 500;

  /** Rows still streaming; the ticker repaints them so their spinner animates. */
  const runningRows = new Set<string>();
  let ticker: ReturnType<typeof setInterval> | null = null;

  /** Start/stop the shared spinner ticker as running rows come and go. */
  function syncTicker(): void {
    if (runningRows.size > 0) {
      if (ticker) return;
      ticker = setInterval(() => {
        for (const id of runningRows) rowInvalidates.get(id)?.();
      }, SPINNER_INTERVAL_MS);
      return;
    }
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function toggleExpanded(toolCallId: string): void {
    if (expanded.has(toolCallId)) expanded.delete(toolCallId);
    else expanded.add(toolCallId);
    rowInvalidates.get(toolCallId)?.();
  }

  /** Last tool result in the restored transcript, if any. */
  function findLastToolResultId(ctx: ExtensionContext): string | null {
    const entries = ctx.sessionManager.buildContextEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = (entries[i] as any)?.message;
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        return message.toolCallId;
      }
    }
    return null;
  }

  pi.on("session_start", (event, ctx) => {
    activeCallId = null;
    expanded.clear();
    rowInvalidates.clear();
    runningRows.clear();
    syncTicker();
    pendingStartupToolCallId = event.reason === "new" ? null : findLastToolResultId(ctx);
    if (!pendingStartupToolCallId) return;

    // If the restored row already rendered before this event, re-render it expanded.
    const id = pendingStartupToolCallId;
    setTimeout(() => {
      if (pendingStartupToolCallId !== id) return;
      const invalidate = rowInvalidates.get(id);
      if (!invalidate) return;
      pendingStartupToolCallId = null;
      expanded.add(id);
      invalidate();
    }, 0);
  });

  pi.on("session_shutdown", () => {
    runningRows.clear();
    syncTicker();
  });

  pi.registerShortcut("ctrl+h", {
    description: "Show/hide the current tool call's output",
    handler: () => {
      if (!activeCallId) return;
      toggleExpanded(activeCallId);
    },
  });

  pi.on("tool_execution_start", (event) => {
    activeCallId = event.toolCallId;
  });

  // Safety net: a call that ends without a final (non-partial) render must not
  // keep the ticker alive forever.
  pi.on("tool_execution_end", (event) => {
    runningRows.delete(event.toolCallId);
    syncTicker();
  });

  for (const tool of builtinDefinitions) {
    const name = tool.name;

    pi.registerTool({
      // Delegate everything to the built-in: params, prompt snippet, execute,
      // result shape, session details — identical behavior.
      ...tool,

      // The whole row is rendered by renderResult (spinner → check, preview,
      // output), so the call slot stays empty: one visible line per call.
      renderCall() {
        return new Container();
      },

      renderResult(result, options, theme, context) {
        const id = context.toolCallId;

        // Untracked rows are pruned oldest-first; never drop a row that is
        // still streaming, or its spinner would freeze.
        if (rowInvalidates.size >= MAX_TRACKED_ROWS && !rowInvalidates.has(id)) {
          for (const key of rowInvalidates.keys()) {
            if (!runningRows.has(key)) {
              rowInvalidates.delete(key);
              break;
            }
          }
        }
        rowInvalidates.set(id, context.invalidate);

        if (options.isPartial) {
          runningRows.add(id);
        } else {
          runningRows.delete(id);

          // Reveal the last restored tool row once it renders on startup/resume.
          if (id === pendingStartupToolCallId) {
            pendingStartupToolCallId = null;
            expanded.add(id);
          }
        }
        syncTicker();

        const isExpanded = expanded.has(id);
        // Collapsed: one clipped line. Expanded: the command exactly as it was
        // given, newlines and all, so nothing is hidden by truncation.
        const raw = summarizeCall(name, context.args);
        const summary = isExpanded ? raw.replace(/\s+$/, "") : truncate(oneLine(raw), PREVIEW_MAX);
        const marker = options.isPartial
          ? theme.fg("accent", spinnerFrame())
          : theme.fg(context.isError ? "error" : "success", context.isError ? "✗" : "✓");
        const label = summary
          ? `${marker} ${theme.fg("muted", name)} ${theme.fg("dim", summary)}`
          : `${marker} ${theme.fg("muted", name)}`;

        const body: string[] = [];
        if (isExpanded) {
          const output = resultText(result.content).replace(/\s+$/, "");
          if (output) body.push(...output.split("\n"));
          // Say so explicitly rather than leaving an empty gap under the command.
          // Withheld while streaming: the output may simply not have arrived yet.
          else if (!options.isPartial) body.push(theme.italic(theme.fg("dim", "no output")));
        }
        const row = new ToolRow(label, body, isExpanded);

        // Click toggles this row's output. Handled here so Pi's own row-wide
        // expand toggle does not also fire and fight this state.
        return new MouseRegion(row, (event) => {
          if (event.type !== "click" || event.button !== "left") return undefined;
          toggleExpanded(id);
          return { handled: true };
        });
      },
    });
  }
}
