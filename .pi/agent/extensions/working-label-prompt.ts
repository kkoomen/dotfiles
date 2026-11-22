/**
 * Working-label prompt extension
 *
 * Replaces the working row's "Working" label with the message you just sent, so
 * the streaming row reads as a reminder of the task instead of a generic word:
 *
 *     ⠋ fix the footer overlap bug, then check the narrow-terminal case… (esc to interrupt)  12s
 *
 * - The label comes from the `input` event (the text you actually typed, not
 *   the skill/template-expanded payload), and falls back to the newest user
 *   message in the session on start, so resumed sessions keep it.
 * - Only the first line of the input is used (the first non-blank one, so a
 *   leading blank line cannot blank the label), whatever its length, and that
 *   line is clipped to MAX_LABEL_CHARS characters with an ellipsis. The loader
 *   itself renders the spinner, the elapsed time, and the interrupt hint.
 * - `/working-label` toggles the swap; `/working-label <text>` pins a label.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Longest label shown in the working row, ellipsis included. */
const MAX_LABEL_CHARS = 200;
/** Cap on the stored first line so a huge paste never costs more than this. */
const MAX_PROMPT_CHARS = 600;

let prompt = "";
let enabled = true;

/**
 * First non-blank line of the input, with tabs and runs of spaces squeezed.
 * Everything after the first line is dropped, however long that line is.
 */
function firstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, " ").replace(/ {2,}/g, " ").trim();
    if (line.length > 0) return line;
  }
  return "";
}

/** Clip to a single-line label, appending an ellipsis when text was dropped. */
function clip(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_LABEL_CHARS) return text;
  return `${chars.slice(0, MAX_LABEL_CHARS - 1).join("").trimEnd()}…`;
}

function setLabel(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  if (!enabled || !prompt) {
    ctx.ui.setWorkingMessage(); // restore the default "Working"
    return;
  }
  ctx.ui.setWorkingMessage(clip(prompt));
}

/** Text of the newest user message in the session, used on start/resume. */
function lastUserMessageText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string") return content;
    const texts = content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text);
    if (texts.length > 0) return texts.join(" ");
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  // Capture the typed message as it is sent.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const text = firstLine(event.text ?? "");
    if (text && !text.startsWith("/")) {
      prompt = text.slice(0, MAX_PROMPT_CHARS);
      setLabel(ctx);
    }
    return { action: "continue" as const };
  });

  // Seed from history on start/resume so a continued session keeps its label.
  pi.on("session_start", async (_event, ctx) => {
    prompt = firstLine(lastUserMessageText(ctx)).slice(0, MAX_PROMPT_CHARS);
    setLabel(ctx);
  });

  pi.registerCommand("working-label", {
    description: "Toggle using your last message as the working label, or pin a label",
    handler: async (args, ctx) => {
      const text = firstLine(args ?? "");
      if (text) {
        enabled = true;
        prompt = text.slice(0, MAX_PROMPT_CHARS);
        setLabel(ctx);
        ctx.ui.notify(`Working label: ${clip(prompt)}`, "info");
        return;
      }
      enabled = !enabled;
      setLabel(ctx);
      ctx.ui.notify(`Working label ${enabled ? "shows your message" : "restored to default"}`, "info");
    },
  });
}
