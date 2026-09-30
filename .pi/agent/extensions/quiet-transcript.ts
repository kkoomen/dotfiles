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
import { Text } from "@earendil-works/pi-tui";

/**
 * Quiet transcript — display-only. Does NOT change what the model does or says.
 *
 * Replaces the built-in rendering of every tool (bash, read, edit, write, grep,
 * find, ls) with one-line bullets:
 *
 *     ▸ bash $ sed -n '1,20p' src/main.ts
 *     ✓ bash
 *
 * Tool call arguments and tool output are hidden from the transcript. The
 * output of the most recent tool call — the one currently running, or the
 * last one that ran — can be shown/hidden with ctrl+h. Only that single row
 * toggles; previously generated rows stay collapsed forever. While a tool is
 * still streaming, expanding it shows its live partial output.
 *
 * On startup/resume, the output of the last tool call in the restored
 * transcript is revealed automatically so the session picks up where it left
 * off; ctrl+h still collapses it again. Execution is 100% delegated to the
 * built-in implementations, so behavior and session history are unchanged.
 */

const CWD = process.cwd();

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/** One-line summary of a tool call's arguments. */
function summarizeCall(name: string, args: any): string {
  switch (name) {
    case "bash":
      return `$ ${truncate(args?.command ?? "", 60)}`;
    case "read":
      return truncate(args?.path ?? "", 70);
    case "edit": {
      const n = args?.edits?.length ?? 0;
      return `${truncate(args?.path ?? "", 50)} (${n} edit${n === 1 ? "" : "s"})`;
    }
    case "write":
      return truncate(args?.path ?? "", 70);
    case "grep": {
      let s = truncate(args?.pattern ?? "", 40);
      if (args?.path) s += ` in ${truncate(args.path, 30)}`;
      return s;
    }
    case "find": {
      let s = truncate(args?.pattern ?? "", 40);
      if (args?.path) s += ` in ${truncate(args.path, 30)}`;
      return s;
    }
    case "ls":
      return truncate(args?.path ?? ".", 70);
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
  // The most recent tool call is the only one ctrl+h affects.
  let activeCallId: string | null = null;
  let activeExpanded = false;
  let activeInvalidate: (() => void) | null = null;

  // Set on startup/resume until the last restored tool row has been revealed.
  let pendingStartupToolCallId: string | null = null;
  // Invalidators for already-rendered tool rows, so a reveal can force a re-render.
  const renderedInvalidates = new Map<string, () => void>();
  const MAX_RENDERED_INVALIDATES = 500;

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
    activeExpanded = false;
    activeInvalidate = null;
    pendingStartupToolCallId = event.reason === "new" ? null : findLastToolResultId(ctx);
    if (!pendingStartupToolCallId) return;

    // If the restored row already rendered before this event, re-render it expanded.
    const id = pendingStartupToolCallId;
    setTimeout(() => {
      if (pendingStartupToolCallId !== id) return;
      const invalidate = renderedInvalidates.get(id);
      if (!invalidate) return;
      pendingStartupToolCallId = null;
      activeCallId = id;
      activeExpanded = true;
      activeInvalidate = invalidate;
      invalidate();
    }, 0);
  });

  pi.registerShortcut("ctrl+h", {
    description: "Show/hide the current tool call's output",
    handler: () => {
      if (!activeCallId) return;
      activeExpanded = !activeExpanded;
      activeInvalidate?.();
    },
  });

  pi.on("tool_execution_start", (event) => {
    // A new call becomes the active one; collapse the previous row if it was
    // showing output so only the current command is ever expanded.
    const collapsePrevious = activeExpanded ? activeInvalidate : null;
    activeCallId = event.toolCallId;
    activeExpanded = false;
    activeInvalidate = null;
    collapsePrevious?.();
  });

  for (const tool of builtinDefinitions) {
    const name = tool.name;

    pi.registerTool({
      // Delegate everything to the built-in: params, prompt snippet, execute,
      // result shape, session details — identical behavior.
      ...tool,

      renderCall(args, theme, context) {
        const summary = summarizeCall(name, args);
        const label = theme.fg("muted", `▸ ${name}`);
        const detail = summary ? " " + theme.fg("dim", summary) : "";
        return new Text(label + detail, 0, 0);
      },

      renderResult(result, options, theme, context) {
        if (!options.isPartial) {
          if (renderedInvalidates.size >= MAX_RENDERED_INVALIDATES) {
            const oldest = renderedInvalidates.keys().next().value;
            if (oldest !== undefined) renderedInvalidates.delete(oldest);
          }
          renderedInvalidates.set(context.toolCallId, context.invalidate);

          // Reveal the last restored tool row once it renders on startup/resume.
          if (context.toolCallId === pendingStartupToolCallId) {
            pendingStartupToolCallId = null;
            activeCallId = context.toolCallId;
            activeExpanded = true;
          }
        }

        const isActive = context.toolCallId === activeCallId;
        if (isActive) {
          activeInvalidate = context.invalidate;
        }
        const expanded = isActive && activeExpanded;
        const text = expanded ? resultText(result.content) : "";

        // Streaming: show the live partial output when the current call is expanded.
        if (options.isPartial) {
          const line = theme.fg("dim", `… ${name}`);
          return new Text(expanded && text ? `${line}\n${text}` : line, 0, 0);
        }

        // Expanded (ctrl+h): show the raw output of the active call.
        if (expanded) {
          const head = theme.fg(context.isError ? "error" : "success", `${context.isError ? "✗" : "✓"} ${name}`);
          return new Text(text ? `${head}\n${text}` : head, 0, 0);
        }

        // Collapsed default: one status bullet, no output.
        const color = context.isError ? "error" : "success";
        return new Text(theme.fg(color, `${context.isError ? "✗" : "✓"} ${name}`), 0, 0);
      },
    });
  }
}
