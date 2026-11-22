/**
 * Notifications — plays a sound and posts a macOS notification when Pi needs the
 * user and when a task is done. Display/notification only: it never changes what
 * the agent does.
 *
 *   ~/.pi/pi-task-done.mp3    every completed task (agent_settled, not aborted)
 *   ~/.pi/pi-need-input.mp3   Pi forwards a request for input or approval:
 *                             - final assistant message opens with one of the
 *                               AWAITING ... status tokens, or
 *                             - a blocking extension UI prompt opens.
 *
 * Every sound is paired with one macOS notification, so a run that chimes while
 * the terminal is behind another window still says what happened:
 *
 *   title    identifier
 *   body     "Plan needs approval" | "Waiting for input" | "Implementation done"
 *
 * The banner is posted by ~/.pi/agent/bin/Pi.app, a tiny local notifier bundle,
 * because macOS shows the icon and name of the app that posts a notification:
 * that bundle carries the Pi icon, so the banner reads "Pi". Rebuild it with
 * ~/.pi/checks/notify/build-notifier.sh. When the bundle is missing the code
 * falls back to osascript, which posts without the Pi icon.
 *
 * The identifier names the task being worked on, never the absolute path:
 *
 *   orchestrator run   the name of the route worktree the agent works in
 *                      (default `<repo>/.pi/worktrees/<taskId>`), else PI_TASK_ID
 *   anything else      the name of the directory Pi is currently working in
 *
 * so a routed stage reads as its task id and a plain session reads as `my-app`.
 *
 * The two channels are exclusive per settle: a settle that forwards a request
 * plays only the need-input clip and banner, and a settle that completes plays
 * only the task-done clip and banner. Need-input wins: a settle whose final text
 * asks the user for something never also plays task-done. A need-input already
 * announced by a blocking prompt in the same turn is neither repeated nor
 * followed by task-done — the run stays silent unless it did more work after the
 * prompt, which cancels the claim and lets the task-done clip play.
 *
 * Need-input is suppressed when the most recent real user instruction asks Pi to
 * act without checking back ("act on my behalf", "don't wait for me", "decide
 * for me", "no need to ask"). The task-done sound and notification still fire.
 * Runs where the user opted out are therefore silent on the need-input channel.
 *
 * That state is per session: `session_start` (startup, reload, new, resume,
 * fork) re-initialises the remembered instruction and the debounce window.
 * The factory is re-created per session, so no earlier session's state
 * carries over.
 *
 * `agent_settled` is the trigger for both sounds because it is the only point
 * where Pi is guaranteed to stop; `agent_end` can still be followed by an
 * auto-retry, a compaction retry, or queued follow-ups.
 *
 * Subagent children (`pi --mode rpc`) load global extensions and settle too, so
 * they stay silent: exactly one task-done per top-level task, never one per
 * stage cell. A child is recognised primarily by the `PI_SUBAGENT_CHILD=1`
 * marker the subagent launcher puts in its environment — authoritative, cheap,
 * and independent of how the child's argv happens to be shaped today. The argv
 * test remains as a fallback for children spawned by an older launcher or by
 * hand: rpc mode plus one of the session flags the launcher passes
 * (`--no-session` for a cold dispatch, `--session-dir`/`--session-id` for a warm
 * stage session). A bare `pi --mode rpc` client is not a child. Aborted runs are
 * silent.
 *
 * Task-done also fires at most once per user turn: a settled run that already
 * announced completion in this turn stays silent, so retries, steered
 * continuations and other extra settles of the same turn cannot stack chimes.
 * A new real user instruction re-arms it. Playback is a detached `/usr/bin/afplay`; the
 * notification is a detached `/usr/bin/open` on the Pi notifier bundle, so
 * macOS attributes the banner to Pi and never blocks the agent loop. A missing
 * asset, missing player, or non-zero exit is a silent skip. This file runs in
 * every project, so it is tiny, dependency-free, and every handler is guarded.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Env marker the subagent launcher sets on every stage child it spawns. Kept in
 * sync with `extensions/subagent/index.ts`.
 */
const CHILD_ENV_MARKER = "PI_SUBAGENT_CHILD";
/** Env marker a command stage runs under; a pi started inside one is a stage too. */
const STAGE_ENV_MARKER = "PI_STAGE_AGENT";

const NEED_INPUT_SOUND = "pi-need-input.mp3";
const TASK_DONE_SOUND = "pi-task-done.mp3";
const PLAYER = "/usr/bin/afplay";
const NOTIFIER = "/usr/bin/osascript";
const OPENER = "/usr/bin/open";
/** Local notifier bundle that posts banners with the Pi icon. */
const NOTIFIER_APP = path.join(os.homedir(), ".pi", "agent", "bin", "Pi.app");
/** A prompt opening plus the settle that follows it must not double-fire. */
const NEED_INPUT_DEBOUNCE_MS = 750;

/** Parent directory that holds route worktrees (`<repo>/.pi/worktrees/<taskId>`). */
const WORKTREE_PARENT = "worktrees";

const BODY_NEEDS_APPROVAL = "Plan needs approval";
const BODY_NEEDS_MERGE_APPROVAL = "Merge needs approval";
const BODY_NEEDS_INPUT = "Waiting for input";
const BODY_DONE = "Implementation done";

const AWAITING_PREFIXES = [
  "AWAITING PLAN APPROVAL",
  "AWAITING INTERVIEW ANSWER",
  "AWAITING MERGE APPROVAL",
  "AWAITING DECISION",
];

const ACT_ON_BEHALF_PHRASES = [
  "act on my behalf",
  "don't wait for me",
  "decide for me",
  "no need to ask",
];

/** Leading whitespace plus markdown decoration that can precede a status token. */
const LEADING_DECORATION = /^[\s*_`#>~-]+/;

/** Trim, then strip one leading run of whitespace/markdown decoration. */
export function normalizeFinalText(text: string): string {
  return text.trim().replace(LEADING_DECORATION, "");
}

/**
 * True when the final assistant text forwards a request to the user. Case
 * sensitive prefix test: a status token quoted mid-message is not a request.
 */
export function shouldPlayNeedInput(finalText: string): boolean {
  const normalized = normalizeFinalText(finalText);
  return AWAITING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Notification body for an awaiting settle: a plan approval reads differently
 * from a general decision/question, both distinct from plain completion.
 */
export function awaitingBody(finalText: string): string {
  const normalized = normalizeFinalText(finalText);
  if (normalized.startsWith("AWAITING PLAN APPROVAL")) return BODY_NEEDS_APPROVAL;
  if (normalized.startsWith("AWAITING MERGE APPROVAL")) return BODY_NEEDS_MERGE_APPROVAL;
  return BODY_NEEDS_INPUT;
}

/**
 * What a settle plays. Need-input wins over task-done: a run that forwards a
 * request plays only the need-input clip and banner, and a run that already
 * announced a blocking prompt in this turn plays nothing more. Only a settle
 * that asks for nothing and announced nothing completes with task-done.
 */
export type SettleAction = "need-input" | "task-done" | "silent";

export function settleAction(finalText: string, needInputAnnounced: boolean): SettleAction {
  if (shouldPlayNeedInput(finalText)) return "need-input";
  if (needInputAnnounced) return "silent";
  return "task-done";
}

/** True when the user asked Pi to proceed without checking back. */
export function hasActOnBehalfOptOut(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const lower = text.toLowerCase();
  return ACT_ON_BEHALF_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * True for a subagent child: `--mode rpc` (or `--mode=rpc`) plus one of the
 * session flags the subagent extension always passes — `--no-session` for a
 * cold dispatch, `--session-dir`/`--session-id` for a warm stage session. The
 * old test only accepted `--no-session`, so every resumed stage session (now the
 * normal case) counted as top-level and chimed. Evaluated per handler, never at
 * module load.
 */
export function isSubagentChild(argv: readonly string[]): boolean {
  let rpcMode = false;
  let childSession = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode=rpc") rpcMode = true;
    else if (arg === "--mode" && argv[i + 1] === "rpc") rpcMode = true;
    else if (arg === "--no-session") childSession = true;
    else if (arg.startsWith("--session-dir") || arg.startsWith("--session-id")) childSession = true;
  }
  return rpcMode && childSession;
}

/**
 * True when this process is a stage/subagent child, which must never notify.
 * The launcher's env marker is authoritative and argv-shape independent; the
 * argv test is the fallback for a child started by an older launcher or by hand.
 * Evaluated per handler with the live environment, never at module load.
 */
export function isStageChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[CHILD_ENV_MARKER] === "1") return true;
  if (nonEmpty(env[STAGE_ENV_MARKER])) return true;
  return isSubagentChild(argv);
}

/** Text of a message content value: plain string or text blocks only. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === "text" && typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

type AnyEntry = { type?: unknown; message?: { role?: unknown; content?: unknown } };

function messageEntry(entry: AnyEntry, role: "assistant" | "user"): string | undefined {
  if (entry.type !== "message") return undefined;
  if (entry.message?.role !== role) return undefined;
  return extractText(entry.message.content);
}

/** Text of the most recent assistant turn that had any text, or "". */
export function lastAssistantText(entries: readonly AnyEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = messageEntry(entries[i], "assistant");
    if (text && text.trim()) return text;
  }
  return "";
}

/** Text of the most recent user message, or "" (custom/compaction entries skipped). */
export function lastUserText(entries: readonly AnyEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = messageEntry(entries[i], "user");
    if (text && text.trim()) return text;
  }
  return "";
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A git worktree carries a `.git` file, not a `.git` directory. */
function isWorktreeRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/**
 * Directory name of the worktree the agent works in, or undefined outside one.
 * Walks up from the cwd so a stage running in a worktree subdirectory is still
 * identified, and accepts any parent directory using the route layout.
 */
export function worktreeName(cwd: string): string | undefined {
  let dir: string;
  try {
    dir = fs.realpathSync(cwd);
  } catch {
    dir = path.resolve(cwd);
  }

  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    if (path.basename(parent) === WORKTREE_PARENT) {
      if (!isWorktreeRoot(dir)) return undefined;
      return nonEmpty(path.basename(dir));
    }
    dir = parent;
  }
}

/**
 * What the notification title identifies, best effort, never empty:
 * worktree name (orchestrator runs) -> PI_TASK_ID -> cwd basename -> "pi".
 * Only the directory name is used, never an absolute or relative path.
 */
export function notificationIdentifier(ctx: ExtensionContext): string {
  const cwd = ctx.cwd || process.cwd();

  const worktree = worktreeName(cwd);
  if (worktree) return worktree;

  const taskId = nonEmpty(process.env.PI_TASK_ID);
  if (taskId) return taskId;

  const dirName = nonEmpty(path.basename(cwd));
  return dirName ?? "pi";
}

/** The notification title: whatever identifies this run. */
export function notificationTitle(identifier: string): string {
  return identifier;
}

/** Detached, fire-and-forget playback. Missing file or player is a silent skip. */
function playSound(fileName: string): void {
  try {
    const file = path.join(os.homedir(), ".pi", fileName);
    if (!fs.existsSync(file)) return;
    const child = spawn(PLAYER, [file], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Notification is best effort; never break the agent loop.
  }
}

/**
 * Posts through the Pi notifier bundle when it exists (Pi icon, Pi name).
 * Falls back to osascript so a missing bundle still notifies. Title and body
 * travel as argv, never as script source, so quotes in them are harmless.
 */
function sendNotification(title: string, body: string): void {
  try {
    const appBundle = fs.existsSync(NOTIFIER_APP);
    const command = appBundle ? OPENER : NOTIFIER;
    const args = appBundle
      ? ["-g", "-n", "-a", NOTIFIER_APP, "--args", title, body]
      : [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          body,
        ];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Notification is best effort; never break the agent loop.
  }
}

export default function notify(pi: ExtensionAPI): void {
  /** Last real (non-extension) user input seen in this session. */
  let lastUserInstruction: string | undefined;
  let lastNeedInputAt = 0;
  /** True once need-input has been announced for the current turn. */
  let needInputAnnounced = false;
  /** True once task-done has been announced for the current turn. */
  let taskDoneAnnounced = false;

  const optedOut = (ctx: ExtensionContext): boolean => {
    if (lastUserInstruction !== undefined) {
      return hasActOnBehalfOptOut(lastUserInstruction);
    }
    // Resumed session: no input event yet, so fall back to the transcript.
    try {
      return hasActOnBehalfOptOut(lastUserText(ctx.sessionManager.buildContextEntries()));
    } catch {
      return false;
    }
  };

  /** Claims the need-input window; false when a prompt just fired. */
  const claimNeedInput = (): boolean => {
    const now = Date.now();
    if (now - lastNeedInputAt < NEED_INPUT_DEBOUNCE_MS) return false;
    lastNeedInputAt = now;
    return true;
  };

  /** Plays need-input at most once per turn, and never alongside task-done. */
  const sayNeedsInput = (ctx: ExtensionContext, body: string): void => {
    if (needInputAnnounced) return;
    if (!claimNeedInput()) return;
    needInputAnnounced = true;
    playSound(NEED_INPUT_SOUND);
    sendNotification(notificationTitle(notificationIdentifier(ctx)), body);
  };

  const sayDone = (ctx: ExtensionContext, body: string): void => {
    playSound(TASK_DONE_SOUND);
    sendNotification(notificationTitle(notificationIdentifier(ctx)), body);
  };

  // Session boundary (startup, reload, new, resume, fork): re-initialise the
  // two closure locals. The factory is re-created per session, so they are
  // already fresh; this is explicit, cheap re-initialisation, not a leak fix.
  pi.on("session_start", () => {
    lastUserInstruction = undefined;
    lastNeedInputAt = 0;
    needInputAnnounced = false;
    taskDoneAnnounced = false;
  });

  // Records the user's most recent instruction; never transforms or handles it.
  pi.on("input", (event) => {
    if (event.source !== "extension" && typeof event.text === "string") {
      lastUserInstruction = event.text;
      needInputAnnounced = false;
      // A new instruction starts a new run: it may chime once more when it ends.
      taskDoneAnnounced = false;
    }
  });

  // The run did something after a need-input announcement (the answer to the
  // prompt led to more work), so the claim no longer stands: a settle that asks
  // for nothing may still play task-done.
  pi.on("tool_execution_start", () => {
    needInputAnnounced = false;
  });

  pi.on("message_start", (event) => {
    const role = (event.message as { role?: unknown } | undefined)?.role;
    if (role === "assistant") needInputAnnounced = false;
  });

  // Blocking prompt half of "Pi needs input".
  pi.on("ui_prompt_start", (event, ctx) => {
    try {
      if (isStageChild(process.argv)) return;
      if (optedOut(ctx)) return;
      sayNeedsInput(ctx, BODY_NEEDS_INPUT);
    } catch {
      // silent
    }
  });

  // Explicit no-op: the clip has already started; cutting it is worse.
  pi.on("ui_prompt_end", () => {});

  pi.on("agent_settled", (event, ctx) => {
    try {
      if (isStageChild(process.argv)) return;
      if (event.aborted === true) return;
      let finalText = "";
      if (!optedOut(ctx)) {
        try {
          finalText = lastAssistantText(ctx.sessionManager.buildContextEntries());
        } catch {
          finalText = "";
        }
      }
      // Requesting input and finishing are exclusive: announce the request and
      // stop, so the done clip/banner never overlaps the need-input one.
      switch (settleAction(finalText, needInputAnnounced)) {
        case "need-input":
          sayNeedsInput(ctx, awaitingBody(finalText));
          return;
        case "silent":
          return;
        default:
          // One completion notice per turn: a turn that already announced its
          // end never chimes again, whatever extra settles it produces.
          if (taskDoneAnnounced) return;
          taskDoneAnnounced = true;
          sayDone(ctx, BODY_DONE);
      }
    } catch {
      // silent
    }
  });
}
