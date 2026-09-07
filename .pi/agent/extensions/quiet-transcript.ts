import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
 * Tool call arguments and tool output are hidden from the transcript. The full
 * output is still available on demand by expanding the tool row (default
 * keybinding: alt+e / app.tools.expand) — the renderer then shows the raw
 * content. Execution is 100% delegated to the built-in implementations, so
 * behavior and session history are unchanged.
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
        // Streaming: show a spinner-ish line.
        if (options.isPartial) {
          return new Text(theme.fg("dim", `… ${name}`), 0, 0);
        }

        // Expanded (keybinding app.tools.expand): show the raw output.
        if (options.expanded) {
          const text = resultText(result.content);
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
