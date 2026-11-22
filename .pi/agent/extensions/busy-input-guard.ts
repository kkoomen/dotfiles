/**
 * Busy Input Guard — keeps typed input in the editor while the agent is running.
 *
 * Pi submits whatever the editor holds, and during a run that submission is
 * treated as a steering message for the live turn. A stray Enter on a
 * half-written prompt therefore interrupts the agent's work with partial text.
 *
 * This extension installs an editor that swallows a plain Enter while the agent
 * is busy. The swallow happens before the editor's submit path runs, so the
 * typed text, the cursor, undo history, and paste markers all stay exactly as
 * they were.
 *
 * A blocked Enter is never silent: the extension swaps the working indicator's
 * message (the line right next to the elapsed time above the editor) to
 *
 *   "Wait for the model to finish executing, or use either /steer or /queue commands."
 *
 * for a few seconds, then restores the default message. The hint is also always
 * cleared when the run settles.
 *
 * The /steer and /queue commands the hint names are NOT registered here. They
 * come from the loaded subagent extension (extensions/subagent/index.ts), which
 * owns both names, and they are what the hint text refers to. Registering them
 * again in this extension would make Pi disambiguate the duplicate names into
 * "steer:1"/"steer:2" and "queue:1"/"queue:2", leaving no plain /steer or
 * /queue for the hint to point at, so this file registers no commands at all.
 *
 * Still allowed while busy:
 *   - input while the autocomplete menu is open (the open menu may claim Enter
 *     to accept the selected completion)
 *   - "/" slash commands
 *   - "!" and "!!" bash input
 *   - the "\" + Enter newline workaround, which inserts a newline and never
 *     submits
 *
 * When the agent is idle the guard is inert: the editor behaves exactly like
 * Pi's built-in one.
 *
 * Scope of this extension
 * -----------------------
 * Input guarding only. The run timer, its snake spinner, and the elapsed-time
 * display above the editor belong to the subagent extension
 * (extensions/subagent/index.ts), which owns the `run-status` widget. This file
 * installs no working indicator, no spinner frames, and no footer run-time
 * status. Its only touch on the working indicator is the temporary hint above,
 * which is restored to Pi's default as described.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

/** True while Pi is processing a run, retry, auto-compaction, or queued continuation. */
let agentBusy = false;

/** Exact hint text shown on the working indicator when Enter is blocked. */
const HINT_TEXT = "Wait for the model to finish executing, or use either /steer or /queue commands.";

/** How long the hint stays on the working indicator before the default returns. */
const HINT_VISIBLE_MS = 5500;

/** UI context captured from the most recent event, used to reach the working indicator. */
let ui: ExtensionUIContext | undefined;

/**
 * True while the working-indicator message is ours. Restoring the default is a
 * best-effort hand-off: `setWorkingMessage` cannot be read back, so another
 * extension that set its own message inside the hint window loses it when the
 * hint expires. Keeping the window short and only ever reacting to a blocked
 * Enter is the practical mitigation available through the public API.
 */
let hintOwned = false;

/** Generation counter so a superseded timer callback never clears a newer hint. */
let hintGeneration = 0;

let hintTimer: ReturnType<typeof setTimeout> | undefined;

/** Show the hint next to the elapsed time, restarting its lifetime on repeat. */
function showBlockedHint(): void {
	const target = ui;
	if (!target) return;
	try {
		target.setWorkingMessage(HINT_TEXT);
	} catch {
		// No working indicator (e.g. headless mode) — the guard itself still works.
		return;
	}
	hintOwned = true;
	const generation = ++hintGeneration;
	if (hintTimer !== undefined) clearTimeout(hintTimer);
	hintTimer = setTimeout(() => {
		if (generation !== hintGeneration) return;
		hintTimer = undefined;
		clearBlockedHint();
	}, HINT_VISIBLE_MS);
}

/** Restore the default working message, but only when the hint is still ours. */
function clearBlockedHint(): void {
	hintGeneration += 1;
	if (hintTimer !== undefined) {
		clearTimeout(hintTimer);
		hintTimer = undefined;
	}
	if (!hintOwned) return;
	hintOwned = false;
	try {
		ui?.setWorkingMessage(undefined);
	} catch {
		// Indicator already gone; nothing to restore.
	}
}

/** Slash commands and bash input stay usable while the agent works. */
function isCommandText(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("/") || trimmed.startsWith("!");
}

class BusyInputGuardEditor extends CustomEditor {
	/**
	 * Enter is swallowed only when it would submit ordinary prompt text while
	 * the agent is busy. Everything else falls through untouched.
	 */
	handleInput(data: string): void {
		if (
			agentBusy &&
			matchesKey(data, "enter") &&
			!this.isShowingAutocomplete() &&
			!isCommandText(this.getText()) &&
			!this.isNewlineContinuation()
		) {
			if (this.getText().trim().length > 0) showBlockedHint();
			return;
		}
		super.handleInput(data);
	}

	/** A trailing "\" turns Enter into a newline inside the editor, never a submit. */
	private isNewlineContinuation(): boolean {
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		return col > 0 && currentLine[col - 1] === "\\";
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// A session can start (or restart) while a run is already in flight.
		agentBusy = !ctx.isIdle();
		ui = ctx.ui;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BusyInputGuardEditor(tui, theme, keybindings));
	});

	pi.on("agent_start", (_event, ctx) => {
		agentBusy = true;
		ui = ctx.ui;
	});

	// agent_end is not final: retries, auto-compaction, and queued continuations
	// keep Pi busy. agent_settled is the last notification for a run.
	pi.on("agent_settled", (_event, ctx) => {
		agentBusy = !ctx.isIdle();
		ui = ctx.ui;
		clearBlockedHint();
	});

	pi.on("session_shutdown", () => {
		clearBlockedHint();
		ui = undefined;
	});
}
