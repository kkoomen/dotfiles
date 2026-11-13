/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Runs each child in RPC mode: it streams the same session events but keeps
 * stdin open, so a user's steering message can be forwarded into the running
 * subagent instead of waiting for the whole `subagent` tool call to finish.
 *
 * Extras (personal customizations):
 *   - Run timer widget: while the agent works on your prompt, a braille dot
 *     spinner plus the elapsed m:ss time is shown above the editor, animated
 *     at 10 fps (agent_start/agent_end). When the run ends the spinner goes
 *     away and the row keeps only the final m:ss time; there is no checkmark
 *     and no completion glyph.
 *   - Subagent timings: every subagent result shows how long the agent
 *     took (⏱ mm:ss), and while it is still running a live braille frame
 *     plus the elapsed mm:ss, repainted every second (Ctrl+O expands to
 *     the verdict).
 *   - Nested subagent timings: subagents called by a subagent show up
 *     with their own live/final times, both inline on the activity
 *     trace and as a recursive, indented tree in the expanded view
 *     (tracked via tool_execution_start/update events and toolResult
 *     message details, so the tree stays live while agents run).
 *   - Collapsed view of a delegating run: instead of the plumbing between the
 *     stages it dispatched (`cd`, plan writes, gates), the run lists the stages
 *     themselves — `→ ✓ 1:50 document-agent $0.0265` — and the stage that is
 *     still running is followed by the last four things it did
 *     (`Edited file2.md`, `$ npm run format (exit code 1)`), indented under a
 *     ├/└ branch line. A command line carries its exit code, so a retry loop
 *     reads as `exit code 1` repeated and then `0`. A finished stage is only its
 *     marker, time and name. A run that works directly keeps its ordinary trace.
 *   - Expanded view shows the agent's final verdict first, then the
 *     full activity trace.
 *   - Work type and mode on every line: the call and each result show the
 *     contract's `workType` (small, normal, large, wave),
 *     and parallel/chain dispatches list it per task, so a serial dispatch
 *     is distinguishable from a wave at a glance.
 *   - Live wave worker table: while a wave dispatch is running, a widget above
 *     the editor lists every worker with its roadmap item, current stage,
 *     elapsed time, stage progress, and tokens, plus assembled-item totals from
 *     the orchestrator's wave state. Drawn by the dispatching process, because
 *     the wave itself runs in a child without a UI. When the dispatch ends the
 *     table stops ticking and every row is terminal: `interrupted` (`!`) marks a
 *     worker that never reported a result. Display only.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Writable } from "node:stream";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { HANDOFF_SCHEMA_VERSION, launchOptions, finalText, semanticFailure, validateContract, validateReport, validateCheckEvidence, validatePriorRecords, codeSnapshot, reviewedFileDigests, reviewSnapshot, handoffRepairReason } from "./workflow.mjs";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 8;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** How many targets a `read N files` line names before it counts the rest. */
const READ_SWEEP_TARGETS = 4;

/** How many stage lines the expanded view lists before it folds the rest. */
const STAGE_EXPANDED_COUNT = 20;

/**
 * Collapsed view of a delegating run: one line per stage it dispatched. A stage
 * still running shows the last four things it did under it, so a retry loop
 * (`exit code 1` three times, then `0`) is visible while it happens; a stage
 * that finished is just `✓ 2:03 build-agent`, its trace left to Ctrl+O.
 */
const STAGE_ACTION_COUNT = 4;
const STAGE_INDENT = "    ";

/** Max indentation depth for the recursive nested-subagent tree. */
const NESTED_MAX_DEPTH = 4;
/** Max total nested-subagent lines rendered per activity trace. */
const NESTED_MAX_NODES = 12;

/**
 * Spend accounting only — this is a ledger, not a limit.
 *
 * Nothing is refused or interrupted because of it. It exists so the month-to-date total is
 * visible in `/context-guard` and in `runs/.spend.json`, which is what makes cost claims
 * checkable. There is deliberately no ceiling here.
 */
const spendLedgerPath = () => path.join(getAgentDir(), "runs", ".spend.json");
const currentMonth = () => new Date().toISOString().slice(0, 7);

function readSpendLedger(): Record<string, number> {
	try {
		const raw = JSON.parse(fs.readFileSync(spendLedgerPath(), "utf8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

function recordSpend(cost: number): void {
	if (!Number.isFinite(cost) || cost <= 0) return;
	try {
		const ledger = readSpendLedger();
		const month = currentMonth();
		ledger[month] = Math.round(((ledger[month] ?? 0) + cost) * 1e6) / 1e6;
		fs.mkdirSync(path.dirname(spendLedgerPath()), { recursive: true, mode: 0o700 });
		fs.writeFileSync(spendLedgerPath(), JSON.stringify(ledger, null, 2), { mode: 0o600 });
	} catch {
		/* a ledger write must never fail a stage */
	}
}

/**
 * Session continuity for a stage.
 *
 * Every dispatch used to be `--no-session`, so a repair round spawned a cold process that
 * rebuilt its whole context from the plan and the tree. That is the single largest source
 * of wasted spend: 60% of observed cost was 2nd-and-later runs of the same stage in the
 * same task. `--session-id` opens the existing session for that id or creates it, which
 * makes a repair dispatch a warm continuation instead of a cold restart.
 */
function stageSessionId(agentName: string, contract?: HandoffContract): string | null {
	if (!contract?.taskId) return null;
	const scope = [contract.taskId, agentName, contract.itemId ?? ""].join("|");
	return `stage-${createHash("sha256").update(scope).digest("hex").slice(0, 24)}`;
}

/** Stage sessions live with the run records, not in the user's normal session list. */
const stageSessionDir = () => process.env.PI_SUBAGENT_SESSION_DIR || path.join(getAgentDir(), "runs", "stage-sessions");

/**
 * Whether this stage already has a session on disk, i.e. this dispatch is a continuation.
 *
 * A resumed session already holds the agent's system prompt, so re-appending it would send
 * the whole role definition twice on every repair round. Pi stores sessions as
 * `<timestamp>_<id>.jsonl`, so the id is the discriminator.
 */
function stageSessionExists(sessionId: string): boolean {
	try {
		return fs.readdirSync(stageSessionDir()).some((name) => name.endsWith(`_${sessionId}.jsonl`));
	} catch {
		return false;
	}
}

/**
 * Drop stage sessions nobody will resume again. Warm repair only reaches back to the current
 * task, so a session untouched for two weeks is dead weight; without this the directory grows
 * with every dispatch forever.
 */
const STAGE_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
let prunedStageSessions = false;
function pruneStageSessions(): void {
	if (prunedStageSessions) return;
	prunedStageSessions = true;
	try {
		const dir = stageSessionDir();
		const cutoff = Date.now() - STAGE_SESSION_TTL_MS;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const file = path.join(dir, entry.name);
			try {
				if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
			} catch {
				/* a session removed mid-scan is not a failure */
			}
		}
	} catch {
		/* no session directory yet */
	}
}

/** Live re-render tick for the wave worker table (1 Hz). */
const LIVE_TICK_MS = 1000;

/**
 * Animation tick for the run timer's dot spinner (10 fps).
 *
 * Deliberately faster than `LIVE_TICK_MS`: the spinner has to walk its frames to read as
 * motion, while the elapsed text it sits next to only changes once a second. Only the run
 * timer uses this interval; the wave table keeps its 1 Hz tick.
 */
const RUN_SPINNER_INTERVAL_MS = 100;

/**
 * Braille dot frames for the run timer: the same classic sequence Pi's own "Working..."
 * indicator walks, rotated to start at `⠼`. Ordered so the dots step around the cell, which
 * is what reads as a terminal-native loader at `RUN_SPINNER_INTERVAL_MS` per frame.
 */
const RUN_SPINNER_FRAMES = ["⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸"];

/**
 * Lines Pi renders for one widget key before it cuts the rest.
 *
 * `setExtensionWidget` wraps a string array in a container built from
 * `content.slice(0, InteractiveMode.MAX_WIDGET_LINES)` and appends a muted
 * "... (widget truncated)" line once `content.length > MAX_WIDGET_LINES`
 * (dist/modes/interactive/interactive-mode.js:1958-1961, with
 * `static MAX_WIDGET_LINES = 10` at :2014). The slice takes from the front, so every line past
 * the cap is dropped.
 */
const PI_MAX_WIDGET_LINES = 10;

/**
 * Widget key for every above-editor strip this extension draws.
 *
 * One key, not one per strip. Pi's `setExtensionWidget` disposes and removes the existing key
 * and then re-inserts it at the end of the placement's map
 * (dist/modes/interactive/interactive-mode.js:1938-1962: `removeExisting(map)` →
 * `map.delete(key)` → `targetMap.set(key, component)`), and the widget container is built by
 * appending `map.values()` in insertion order, so the last-written key renders lowest,
 * closest to the editor. Two keys under one placement therefore swap vertical order on
 * whichever tick wrote last. Writing both strips through one key makes the order a plain
 * array order instead: compare `paintRunStatus` (`waveLines` then `runTimerLines`).
 */
const RUN_STATUS_WIDGET = "run-status";

/**
 * Run timer text: last in the widget, so it sits directly above the editor.
 *
 * One line while running (`<spinner frame> m:ss`) and one line once the run ends
 * (`m:ss` only, no spinner and no completion glyph).
 */
let runTimerLines: string[] | undefined;
/** Wave table text: first in the widget, so it stays above the run timer. */
let waveLines: string[] | undefined;
/** UI handle the shared widget was last painted through (Pi's stable session UI context). */
let runStatusUI: ExtensionContext["ui"] | undefined;

/**
 * Repaint the shared above-editor widget: wave table first, run timer last.
 *
 * The vertical order is fixed here by array order, so no tick can displace the other strip,
 * and a strip that is absent simply contributes no lines.
 *
 * Pi slices one widget's array to its first `PI_MAX_WIDGET_LINES` lines and the run timer is
 * the last entry, so the table is capped to whatever the timer leaves inside that budget. The
 * reservation is what keeps the timer line from ever being sliced off: a normal 8-worker table
 * already fills the budget on its own. Only how many table lines fit changes here -- the table
 * itself is still drawn by `formatWaveWidget`, unchanged. With no timer present the budget is
 * the whole cap, so an oversized table is cut here instead of by Pi.
 */
function paintRunStatus(ui?: ExtensionContext["ui"]): void {
	if (ui) runStatusUI = ui;
	if (!runStatusUI) return;
	const timer = runTimerLines ?? [];
	// Derived from the timer rather than hardcoding one line, so a taller timer keeps its space.
	const waveBudget = Math.max(0, PI_MAX_WIDGET_LINES - timer.length);
	const lines = [...(waveLines ?? []).slice(0, waveBudget), ...timer];
	try {
		runStatusUI.setWidget(RUN_STATUS_WIDGET, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
	} catch {
		/* TUI may be gone; ignore */
	}
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Global run timer: shows how long the current prompt has been running
 * (agent_start → agent_end) as a live widget above the editor.
 *
 * While running the row is a terminal dot spinner followed by the elapsed m:ss time. The
 * spinner advances on every `RUN_SPINNER_INTERVAL_MS` tick; the text it sits next to only
 * changes as the displayed second changes. When the run ends the spinner is dropped and the
 * row keeps only the final m:ss time — no checkmark, no square, no status glyph.
 */
let runTimerStart = 0;
let runTimerInterval: ReturnType<typeof setInterval> | null = null;
let runTimerUI: ExtensionContext["ui"] | undefined;
/** Index of the last spinner frame painted, so each tick advances exactly one frame. */
let runTimerFrame = 0;

/** Color a spinner frame with the live theme accent; plain text when no theme is reachable. */
function paintSpinnerFrame(ui: ExtensionContext["ui"], frame: string): string {
	try {
		return ui.theme.fg("accent", frame);
	} catch {
		// No theme (headless/print); the frame still reads as a spinner uncolored.
		return frame;
	}
}

export function tickRunTimer() {
	if (!runTimerUI || !runTimerStart) return;
	const frame = RUN_SPINNER_FRAMES[runTimerFrame % RUN_SPINNER_FRAMES.length]!;
	runTimerFrame += 1;
	runTimerLines = [`${paintSpinnerFrame(runTimerUI, frame)} ${formatDuration(Date.now() - runTimerStart)}`];
	paintRunStatus(runTimerUI);
}

export function startRunTimer(ui: ExtensionContext["ui"]) {
	runTimerStart = Date.now();
	runTimerUI = ui;
	runTimerFrame = 0;
	if (runTimerInterval) clearInterval(runTimerInterval);
	tickRunTimer();
	runTimerInterval = setInterval(tickRunTimer, RUN_SPINNER_INTERVAL_MS);
}

export function stopRunTimer() {
	if (runTimerInterval) {
		clearInterval(runTimerInterval);
		runTimerInterval = null;
	}
	if (runTimerUI && runTimerStart) {
		// Final state: the elapsed time alone. The spinner is gone and nothing replaces it.
		runTimerLines = [formatDuration(Date.now() - runTimerStart)];
		paintRunStatus(runTimerUI);
	}
	runTimerStart = 0;
}

/**
 * Live wave worker table.
 *
 * A wave's `parallel` call runs inside a headless child process, so `ui.setWidget` there
 * reaches no screen. The table is drawn instead by the process that dispatched that child:
 * nested subagent events already carry the child's live dispatch details upward, and this
 * block flattens them into one row per roadmap item. Display only — it never writes state,
 * never reorders a dispatch, and has no effect on validation.
 *
 * Rows are terminal once the dispatch that published them ends; `interrupted` means the
 * worker produced no result before the call finished, so its elapsed time stops there.
 *
 * The table is one part of the shared `RUN_STATUS_WIDGET` widget, painted above the run timer
 * by `paintRunStatus`, so a wave tick and a timer tick can never swap places.
 */

/** Route length used for the per-item stage dots; a repair round repeats stages. */
const WAVE_STAGE_TOTAL = 6;

/** Item outcomes that mean the commit exists on the wave branch. */
const WAVE_ASSEMBLED = new Set(["assembled", "committed", "merged", "done", "complete", "completed"]);

export type WaveRowState = "queued" | "running" | "waiting" | "done" | "failed" | "interrupted";

const WAVE_GLYPH: Record<WaveRowState, string> = {
	queued: "◌",
	running: "▶",
	waiting: "⏸",
	done: "✓",
	failed: "✗",
	interrupted: "!",
};

const WAVE_COLOR: Record<WaveRowState, WaveColor> = {
	queued: "dim",
	running: "accent",
	waiting: "muted",
	done: "success",
	failed: "error",
	interrupted: "warning",
};

export interface WaveRow {
	itemId: string;
	state: WaveRowState;
	stage?: string;
	elapsedMs: number;
	stagesDone: number;
	retries: number;
	tokens: number;
}

export interface WaveView {
	waveId?: string;
	rows: WaveRow[];
	startedAt: number;
	cost: number;
	active: boolean;
}

interface WaveTotals {
	assembled: number;
	total: number;
}

type WaveTheme = ExtensionContext["ui"]["theme"];
/** Exactly the theme token union, so a renamed or invented colour fails the typecheck. */
type WaveColor = Parameters<WaveTheme["fg"]>[0];

/** A parallel dispatch is a wave when two or more of its tasks carry `workType: wave`. */
export function isWaveDispatch(details: SubagentDetails | undefined): boolean {
	if (!details || details.mode !== "parallel" || details.results.length < 2) return false;
	return details.results.filter((result) => result.workType === "wave").length >= 2;
}

/**
 * Find the live wave dispatch inside a result tree.
 *
 * The dispatcher sees the wave two levels down: itself, the orchestrator it called, and the
 * orchestrator's parallel call. Bounded depth keeps a pathological tree from being walked.
 * A nested run's final `details` win over its `liveDetails`: streaming only fills liveDetails,
 * so reading live first would keep a stale snapshot after the terminal toolResult arrived.
 */
export function findWaveDispatch(details: SubagentDetails | undefined, depth = 3): SubagentDetails | undefined {
	if (!details || depth < 0) return undefined;
	if (isWaveDispatch(details)) return details;
	for (const result of details.results ?? []) {
		// A liveDetails payload arrives deserialized from a child; never assume the arrays are there.
		for (const nested of result.nestedSubagents ?? []) {
			const found = findWaveDispatch(nested.details, depth - 1) ?? findWaveDispatch(nested.liveDetails, depth - 1);
			if (found) return found;
		}
	}
	return undefined;
}

function shortStage(agent: string): string {
	return agent.endsWith("-agent") ? agent.slice(0, -6) : agent;
}

function clipRight(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep the distinguishing tail of an item id: `server/07-handler-guards` loses its namespace first. */
function clipLeft(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…";
	return `…${text.slice(text.length - (max - 1))}`;
}

function padRight(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

/** Duration in the table's own units: `0m41s`, `42m12s`, `1h04m`. Never wider than six cells. */
function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec >= 3600) {
		return `${Math.floor(totalSec / 3600)}h${String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")}m`;
	}
	return `${Math.floor(totalSec / 60)}m${String(totalSec % 60).padStart(2, "0")}s`;
}

function padLeft(text: string, width: number): string {
	return text.length >= width ? text.slice(text.length - width) : " ".repeat(width - text.length) + text;
}

function tokensOf(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): number {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * Flatten the live wave dispatch into rows.
 *
 * `waiting` is the state the table exists to expose: the round is a barrier, so an item that
 * returned early is idle until the slowest item finishes.
 *
 * `endedAt` is the instant the dispatch was learned to be over. It makes the view terminal:
 * nothing is `active`, so finished rows read `done` instead of `waiting`, and a started row
 * that never reported a result becomes `interrupted` with its elapsed time frozen there.
 */
export function waveViewFrom(details: SubagentDetails | undefined, now: number, endedAt?: number): WaveView | undefined {
	const wave = findWaveDispatch(details);
	if (!wave) return undefined;
	const active = endedAt === undefined && wave.results.some((result) => result.startedAt > 0 && result.finishedAt === undefined);
	const rows: WaveRow[] = [];
	let startedAt = now;
	let cost = 0;
	for (const result of wave.results) {
		cost += result.usage?.cost ?? 0;
		const stages = result.nestedSubagents ?? [];
		const current = stages.at(-1);
		const stagesDone = stages.filter((stage) => stage.finishedAt !== undefined).length;
		const retries = Math.max(0, stages.filter((stage) => stage.agent === "build-agent").length - 1);
		const failed = result.finishedAt !== undefined && isFailedResult(result);
		let state: WaveRowState = "queued";
		let elapsedMs = 0;
		if (result.startedAt > 0) {
			startedAt = Math.min(startedAt, result.startedAt);
			if (failed) {
				state = "failed";
				elapsedMs = (result.finishedAt ?? now) - result.startedAt;
			} else if (result.finishedAt === undefined) {
				const stageStart = current && current.finishedAt === undefined ? current.startedAt : result.startedAt;
				if (endedAt === undefined) {
					state = "running";
					elapsedMs = now - stageStart;
				} else {
					state = "interrupted";
					elapsedMs = endedAt - stageStart;
				}
			} else if (active) {
				state = "waiting";
				elapsedMs = now - result.finishedAt;
			} else {
				state = "done";
				elapsedMs = result.finishedAt - result.startedAt;
			}
		}
		rows.push({
			itemId: result.itemId ?? clipRight(result.task.replace(/\s+/g, " ").trim(), 44),
			state,
			stage: current ? shortStage(current.agent) : undefined,
			elapsedMs,
			stagesDone,
			retries,
			tokens: tokensOf(result.usage),
		});
	}
	return {
		waveId: wave.results.find((result) => result.waveId)?.waveId,
		rows,
		startedAt,
		cost,
		active,
	};
}

const waveTotalsCache = new Map<string, { mtimeMs: number; at: number; value?: WaveTotals }>();

/**
 * Assembled-item totals from the orchestrator's wave state.
 *
 * The state file is coordination notes written by an agent, not a fixed schema, so this
 * reader accepts several shapes and returns nothing rather than guessing. The table then
 * drops the progress bar instead of showing a wrong number.
 */
function waveTotalsFromState(state: unknown): WaveTotals | undefined {
	if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
	const data = state as Record<string, any>;
	const ids = new Set<string>();
	let assembled = 0;
	const count = (items: unknown[], idOf: (item: any) => unknown, doneOf: (item: any) => boolean) => {
		for (const item of items) {
			const id = idOf(item);
			if (typeof id === "string" && id) ids.add(id);
			if (doneOf(item)) assembled++;
		}
	};
	if (Array.isArray(data.rounds)) {
		for (const round of data.rounds) {
			const items = Array.isArray(round?.items) ? round.items : Array.isArray(round) ? round : [];
			count(
				items,
				(item) => (typeof item === "string" ? item : item?.itemId ?? item?.id),
				(item) =>
					typeof item === "object" &&
					item !== null &&
					(Boolean(item.commit) || WAVE_ASSEMBLED.has(String(item.outcome ?? item.status ?? item.state ?? "").toLowerCase())),
			);
		}
	}
	if (Array.isArray(data.items)) {
		count(
			data.items,
			(item) => item?.itemId ?? item?.id,
			(item) => Boolean(item?.commit) || WAVE_ASSEMBLED.has(String(item?.status ?? item?.state ?? "").toLowerCase()),
		);
	}
	const declared = Number(
		data.total ?? data.itemCount ?? data.assembledTotal ?? data.scope?.count ?? data.scope?.items ?? 0,
	);
	const total = Math.max(ids.size, Number.isFinite(declared) ? declared : 0);
	if (!total) return undefined;
	const declaredDone = Number(data.assembled ?? data.completed ?? data.done ?? 0);
	return { assembled: Math.min(total, Math.max(assembled, Number.isFinite(declaredDone) ? declaredDone : 0)), total };
}

function readWaveTotals(waveId: string | undefined, cwd: string): WaveTotals | undefined {
	if (!waveId) return undefined;
	const file = path.join(cwd, ".pi", "state", `${waveId}.json`);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return undefined;
	}
	const cached = waveTotalsCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.at < 5000) return cached.value;
	let value: WaveTotals | undefined;
	try {
		value = waveTotalsFromState(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		value = undefined;
	}
	waveTotalsCache.set(file, { mtimeMs: stat.mtimeMs, at: Date.now(), value });
	return value;
}

/** A row cell with its own colour, so padding is computed on visible text only. */
interface WaveSeg {
	text: string;
	color?: WaveColor;
}

function segLength(segs: WaveSeg[]): number {
	return segs.reduce((total, seg) => total + seg.text.length, 0);
}

/**
 * Render the table as a bordered block.
 *
 * Columns are dropped right to left as the terminal narrows; the item id is never dropped,
 * because it is the only column that says which work is at risk.
 */
export function formatWaveWidget(
	view: WaveView,
	totals: WaveTotals | undefined,
	width: number,
	theme: WaveTheme,
	now: number,
): string[] {
	const cols = Math.max(20, width);
	const border = (text: string) => theme.fg("borderMuted", text);
	const colorOf = (text: string, color?: WaveColor) => (color ? theme.fg(color, text) : text);

	let showTokens = true;
	let showDots = true;
	let showStage = true;
	const inner = Math.min(cols, 84) - 2;
	// The id column absorbs the slack; below 14 cells it stops being readable, so shed a column.
	const fixed = () => 13 + (showStage ? 18 : 0) + (showDots ? 8 : 0) + (showTokens ? 11 : 0);
	while (inner - fixed() < 14 && (showTokens || showDots || showStage)) {
		if (showTokens) showTokens = false;
		else if (showDots) showDots = false;
		else showStage = false;
	}
	const idWidth = Math.max(10, inner - fixed());
	const cell = (text: string, width: number) => padRight(clipRight(text, width), width);

	const lines: string[] = [];

	// Title sits in the top border, so no separate heading line is needed.
	const title = clipRight(view.waveId ?? "wave", Math.max(8, inner - 8));
	// `┌ ` + title + ` ` + fill + `┐` must equal inner + 2, the same width as every other line.
	lines.push(
		border("\u250c ") +
			theme.fg("accent", title) +
			border(` ${"\u2500".repeat(Math.max(0, inner - title.length - 2))}\u2510`),
	);

	// Summary line: assembled count and bar outrank elapsed and cost when space is short.
	const buildStat = (barCells: number, withElapsed: boolean, withCost: boolean): WaveSeg[] => {
		const segs: WaveSeg[] = [];
		if (totals && totals.total > 0) {
			segs.push({ text: `${totals.assembled}/${totals.total} assembled` }, { text: "   " });
			if (barCells > 0) {
				const filled = Math.max(0, Math.min(barCells, Math.round((totals.assembled / totals.total) * barCells)));
				segs.push(
					{ text: "\u2588".repeat(filled), color: "success" },
					{ text: "\u2591".repeat(barCells - filled), color: "dim" },
					{ text: "  " },
				);
			}
		}
		segs.push({ text: `${view.rows.length} workers` });
		if (withElapsed) segs.push({ text: "   " }, { text: formatElapsed(now - view.startedAt), color: "dim" });
		if (withCost && view.cost > 0) segs.push({ text: "   " }, { text: `$${view.cost.toFixed(2)}`, color: "dim" });
		return segs;
	};
	let stat = buildStat(24, true, true);
	if (segLength(stat) > inner - 2) stat = buildStat(24, true, false);
	if (segLength(stat) > inner - 2) {
		const room = inner - 2 - segLength(buildStat(0, true, false)) - 2;
		stat = buildStat(Math.max(0, room), true, false);
	}
	if (segLength(stat) > inner - 2) stat = buildStat(0, true, false);
	if (segLength(stat) > inner - 2) stat = buildStat(0, false, false);
	// The summary segments exclude the surrounding borders, which already consume two cells.
	const statPad = Math.max(0, inner - 2 - segLength(stat));
	lines.push(border("\u2502 ") + stat.map((seg) => colorOf(seg.text, seg.color)).join("") + " ".repeat(statPad) + border(" \u2502"));
	lines.push(border(`\u251c${"\u2500".repeat(inner)}\u2524`));

	for (const row of view.rows) {
		// A repair in progress shows the retry glyph, so a slow row is distinguishable from a stuck one.
		const retrying = row.state === "running" && row.retries > 0;
		const glyph = retrying ? "\u21bb" : WAVE_GLYPH[row.state];
		const glyphColor: WaveColor = retrying ? "warning" : WAVE_COLOR[row.state];

		const stageText =
			row.state === "waiting"
				? "\u2014 waiting"
				: row.state === "queued"
					? "\u2014"
					: row.state === "interrupted"
						? "\u2014 interrupted"
						: retrying
							? `${row.stage ?? "\u2014"}(retry ${row.retries + 1})`
							: (row.stage ?? "\u2014");
		const stageColor: WaveColor =
			row.state === "failed"
				? "error"
				: row.state === "running" || row.state === "interrupted"
					? "warning"
					: "dim";
		const elapsedText = row.state === "queued" ? "\u2014" : formatElapsed(row.elapsedMs);
		const tokenText = row.tokens >= 1000 ? `${Math.round(row.tokens / 1000)}k tok` : `${row.tokens} tok`;
		const done = Math.max(0, Math.min(WAVE_STAGE_TOTAL, row.stagesDone));

		const segs: WaveSeg[] = [
			{ text: "\u2502 ", color: "borderMuted" },
			{ text: glyph, color: glyphColor },
			{ text: " " },
			{
				text: cell(row.itemId, idWidth),
				color: row.state === "done" ? "muted" : row.state === "queued" ? "dim" : undefined,
			},
		];
		if (showStage) segs.push({ text: "   " }, { text: cell(stageText, 15), color: stageColor });
		segs.push({ text: " " }, { text: padLeft(elapsedText, 6), color: "dim" });
		if (showDots) {
			segs.push(
				{ text: "  " },
				{ text: "\u25b8".repeat(done), color: row.state === "failed" ? "error" : "accent" },
				{ text: "\u00b7".repeat(WAVE_STAGE_TOTAL - done), color: "dim" },
			);
		}
		if (showTokens) segs.push({ text: "   " }, { text: padLeft(tokenText, 8), color: "dim" });
		const pad = Math.max(0, inner - segLength(segs));
		segs.push({ text: " ".repeat(pad) }, { text: " \u2502", color: "borderMuted" });
		lines.push(segs.map((seg) => colorOf(seg.text, seg.color)).join(""));
	}

	lines.push(border(`\u2514${"\u2500".repeat(inner)}\u2518`));
	return lines;
}

let waveDetails: SubagentDetails | undefined;
let waveCtx: ExtensionContext | undefined;
let waveInterval: ReturnType<typeof setInterval> | null = null;
/** Tool-call id that owns the current table, so another call cannot settle it. */
let waveToolCallId: string | undefined;
/**
 * Runner UI context the table was published through. This is the session handle, not the
 * `ExtensionContext` wrapper: Pi builds a fresh wrapper for every emission, so comparing
 * wrappers would never match the call that published.
 */
let waveUI: unknown;
/** Instant the owning call was learned to be over; present = the table is frozen. */
let waveEndedAt: number | undefined;

function tickWave(): void {
	if (!waveCtx || !waveDetails) return;
	const ctx = waveCtx;
	const now = waveEndedAt ?? Date.now();
	const view = waveViewFrom(waveDetails, now, waveEndedAt);
	if (!view) {
		// Nothing to draw any more: drop the widget instead of leaving the last one behind.
		clearWave();
		return;
	}
	const width = process.stdout.columns ?? 100;
	waveLines = formatWaveWidget(view, readWaveTotals(view.waveId, ctx.cwd), width, ctx.ui.theme, now);
	paintRunStatus(ctx.ui);
}

/**
 * The stable session handle behind an `ExtensionContext`.
 *
 * `ExtensionRunner.createContext()` returns a new object literal per call and `emit()` builds
 * one per event, so two contexts for the same session are never the same object
 * (dist/core/extensions/runner.js:613-621 + :813-814). What is stable is the runner's
 * `uiContext`: `get ui()` returns `runner.uiContext`, which only `setUIContext()` replaces at
 * bind/reload time (:355-356, :402). Comparing it identifies the session without depending on
 * wrapper identity. Guarded because the getter calls `assertActive()` and throws once the
 * runner is stale.
 */
function waveUIOf(ctx: ExtensionContext | undefined): unknown {
	try {
		return ctx?.ui;
	} catch {
		return undefined;
	}
}

/** Publish a dispatch's details for the live table. Cheap and idempotent; safe to call per update. */
export function publishWave(details: SubagentDetails | undefined, ctx: ExtensionContext, toolCallId?: string): void {
	if (!ctx.hasUI || !details || !findWaveDispatch(details)) return;
	waveDetails = details;
	waveCtx = ctx;
	waveUI = waveUIOf(ctx);
	waveToolCallId = toolCallId;
	// A resumed stream un-freezes the table: new data means the call is still alive.
	waveEndedAt = undefined;
	if (!waveInterval) waveInterval = setInterval(tickWave, LIVE_TICK_MS);
	tickWave();
}

/**
 * The owning call ended: freeze the table in place and stop ticking.
 *
 * Final `details` are adopted when they carry the wave (a clean end shows real rows);
 * otherwise the last streamed snapshot is rendered with `interrupted` rows, because the
 * workers that never reported are exactly what the table exists to show. The widget stays
 * on screen until the next `agent_start` clears it.
 */
export function settleWave(ctx: ExtensionContext, toolCallId: string | undefined, details?: SubagentDetails): void {
	// Same session, not same wrapper object: the ctx Pi hands to this handler is a fresh one.
	if (!waveDetails || !waveCtx || !waveUI || waveUI !== waveUIOf(ctx)) return;
	if (waveToolCallId !== toolCallId) return;
	if (details && findWaveDispatch(details)) waveDetails = details;
	waveEndedAt ??= Date.now();
	if (waveInterval) {
		clearInterval(waveInterval);
		waveInterval = null;
	}
	tickWave();
}

/** Leave the final table on screen and stop ticking. */
function freezeWave(): void {
	if (waveInterval) {
		clearInterval(waveInterval);
		waveInterval = null;
	}
	// Freeze at settlement time when it is known, so the frozen rows agree with the last render.
	if (waveDetails) waveEndedAt ??= Date.now();
	tickWave();
	waveDetails = undefined;
	waveCtx = undefined;
	waveUI = undefined;
	waveToolCallId = undefined;
	waveEndedAt = undefined;
}

export function clearWave(): void {
	if (waveInterval) {
		clearInterval(waveInterval);
		waveInterval = null;
	}
	// The table shares one widget with the run timer, so dropping it is a repaint without its
	// lines, not a removal: the timer strip must survive the table going away.
	const hadCtx = waveCtx !== undefined;
	waveLines = undefined;
	waveDetails = undefined;
	waveCtx = undefined;
	waveUI = undefined;
	waveToolCallId = undefined;
	waveEndedAt = undefined;
	if (hadCtx) paintRunStatus();
}

/**
 * Live re-render registry: while a subagent result is still streaming,
 * re-render its tool component every second so the running braille frame and
 * its elapsed timer update even when no new messages are arriving. Components are
 * keyed by their renderer state object, which is stable per component.
 */
const liveRenderers = new Map<object, () => void>();
let liveInterval: ReturnType<typeof setInterval> | null = null;

function registerLiveRenderer(key: object, invalidate: () => void) {
	liveRenderers.set(key, invalidate);
	if (!liveInterval) {
		liveInterval = setInterval(() => {
			for (const invalidate of liveRenderers.values()) {
				try {
					invalidate();
				} catch {
					/* component gone */
				}
			}
		}, LIVE_TICK_MS);
	}
}

function unregisterLiveRenderer(key: object) {
	liveRenderers.delete(key);
	if (liveRenderers.size === 0 && liveInterval) {
		clearInterval(liveInterval);
		liveInterval = null;
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * A one-line usage summary. `totalCost`, when given, is the result's own spend
 * plus everything it dispatched, and is what the figure reports; the own share
 * follows in parentheses. Without it the figure is the result's own spend, which
 * is all a run that dispatched nothing has anyway.
 */
export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	totalCost?: number,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	// The parent's usage never includes a child's, so a run that delegated has to be
	// totalled from the tree, or the bottom line reads smaller than its own stages.
	const dispatched = totalCost === undefined ? 0 : totalCost - usage.cost;
	if (dispatched > 0.0000005) parts.push(`$${totalCost!.toFixed(4)} (own $${usage.cost.toFixed(4)})`);
	else if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	timingLabel?: string | null,
): string {
	switch (toolName) {
		case "bash": {
			const command = oneLine(stripCdPrefix((args.command as string) || "..."));
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "subagent": {
			let text: string;
			if (Array.isArray(args.tasks)) {
				text =
					themeFg("accent", "subagent") +
					themeFg("dim", ` parallel (${args.tasks.length} tasks)`);
			} else if (Array.isArray(args.chain)) {
				text =
					themeFg("accent", "subagent") +
					themeFg("dim", ` chain (${args.chain.length} steps)`);
			} else {
				const agent = (args.agent || "...") as string;
				const task = (args.task || "") as string;
				const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
				text = themeFg("accent", agent) + themeFg("dim", ` · ${preview}`);
			}
			return timingLabel ? themeFg("dim", `${timingLabel} · `) + text : text;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Path for display: relative to `base`, then `~`-shortened, never absolute. */
export function shortenPath(value: unknown, base: string = process.cwd()): string {
	const raw = typeof value === "string" && value ? value : "...";
	const dir = base.endsWith(path.sep) ? base.slice(0, -1) : base;
	if (dir && raw === dir) return ".";
	if (dir && raw.startsWith(`${dir}${path.sep}`)) return raw.slice(dir.length + 1);
	const home = os.homedir();
	if (raw === home) return "~";
	return raw.startsWith(`${home}${path.sep}`) ? `~${raw.slice(home.length)}` : raw;
}

/**
 * A command as the reader needs it. A leading `cd <dir> &&` only restates the
 * directory the agent already works in, and it eats the start of the line
 * before the part that says what the command does. A command that only changes
 * directory strips to the empty string, which is the signal to drop the call
 * from every trace rather than print a line that says nothing.
 */
export function stripCdPrefix(command: string): string {
	let result = command.trim();
	for (;;) {
		const next = result.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^&;|\n]+?)\s*(?:&&|;|\n)\s*/, "");
		if (next === result) break;
		result = next;
	}
	// A newline separates statements as surely as `;` does, so it counts here too.
	return /^cd(?:\s|$)/.test(result) && !/[&;|\n]/.test(result) ? "" : result;
}

/**
 * A command collapsed onto one line. A heredoc or a multi-statement `&&` chain
 * would otherwise wrap inside the trace and push every following row down the
 * terminal; the line is a label, not the script.
 */
export function oneLine(command: string): string {
	return command
		.replace(/\s*\n\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** `file.js:85-204` — the part of a read that says what it looked at. */
export function readTarget(args: Record<string, any>): string {
	const target = shortenPath(args.file_path ?? args.path);
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	if (offset === undefined && limit === undefined) return target;
	const start = offset ?? 1;
	const end = limit !== undefined ? start + limit - 1 : "";
	return `${target}:${start}${end ? `-${end}` : ""}`;
}

/**
 * Exit code reported by a command's tool result, or null when the result is
 * missing or not a completed run (aborted, timed out).
 *
 * The transcript keeps no numeric exit-code field: a non-zero exit is reported
 * by the bash tool as an appended `Command exited with code N` in the result
 * text, and a zero exit is the absence of that line. Anchored to the end of the
 * text, because that is where the tool appends it — a command whose own output
 * happens to contain the phrase keeps the real status last.
 */
export function exitCodeOf(result: { isError?: boolean; content?: unknown } | undefined): number | null {
	if (!result) return null;
	const text = Array.isArray(result.content)
		? result.content
				.map((block) => (block && typeof block === "object" && (block as any).type === "text" ? String((block as any).text) : ""))
				.join("")
		: "";
	const reported = /Command exited with code (-?\d+)\s*$/.exec(text.trimEnd());
	if (reported) return Number(reported[1]);
	// A failure without that line is a timeout or an abort, not an exit code.
	return result.isError === true ? null : 0;
}

/**
 * One short line for what an agent did: a file operation reads as the verb it
 * is ("Edited x"), a shell command keeps the `$` form the activity trace uses.
 * A command carries its exit code, so a retried command is visible as such.
 */
export function formatStageAction(
	toolName: string,
	args: Record<string, any>,
	themeFg: (color: any, text: string) => string,
	exitCode: number | null = null,
): string {
	const code = typeof exitCode === "number" ? themeFg(exitCode === 0 ? "dim" : "error", ` (exit code ${exitCode})`) : "";
	switch (toolName) {
		case "edit":
			return themeFg("muted", "Edited ") + themeFg("accent", shortenPath(args.file_path ?? args.path));
		case "write":
			return themeFg("muted", "Created ") + themeFg("accent", shortenPath(args.file_path ?? args.path));
		case "read":
			return themeFg("muted", "Read ") + themeFg("accent", readTarget(args));
		case "bash": {
			const command = oneLine(stripCdPrefix(typeof args.command === "string" ? args.command : "..."));
			// A bare `rm <file>` is the removal it performs, not a shell invocation.
			const removed = /^\s*rm\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)\s*$/.exec(command);
			if (removed) return themeFg("muted", "Removed ") + themeFg("accent", shortenPath(removed[1])) + code;
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview) + code;
		}
		case "grep":
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${args.pattern ?? ""}/`) +
				themeFg("dim", ` in ${shortenPath(args.path ?? ".")}`)
			);
		case "find":
			return (
				themeFg("muted", "find ") +
				themeFg("accent", `${args.pattern ?? "*"}`) +
				themeFg("dim", ` in ${shortenPath(args.path ?? ".")}`)
			);
		case "ls":
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(args.path ?? "."));
		case "subagent":
			return themeFg("muted", "→ ") + themeFg("accent", subagentCallLabel(args).agent);
		default:
			return themeFg("accent", toolName);
	}
}

/**
 * True when the run dispatched other agents. Such a run's own items are the
 * plumbing that connects the stages (`cd ...`, plan writes, gates), so its
 * collapsed view lists the stages instead of that trace.
 */
export function isDelegatingRun(items: DisplayItem[]): boolean {
	return items.some((item) => item.type === "toolCall" && item.name === "subagent");
}

/** The stage dispatches of a run, newest last, windowed like any collapsed list. */
export function stageItems(
	items: DisplayItem[],
	limit: number,
): { items: ToolCallDisplayItem[]; skipped: number } {
	const stages = items.filter((i): i is ToolCallDisplayItem => i.type === "toolCall" && i.name === "subagent");
	const shown = limit > 0 ? stages.slice(-limit) : stages;
	return { items: shown, skipped: stages.length - shown.length };
}

/**
 * Whether a stage line carries its action tail. Only a stage that is still
 * working does: a finished (or failed) stage is fully described by its marker,
 * time and name, and its command list lives in the expanded trace.
 */
export function stageShowsActions(
	timing: StageTiming | null,
	mode: "collapsed" | "expanded" = "collapsed",
): boolean {
	if (mode === "expanded") return true;
	return timing === null || timing.running;
}

/**
 * Everything a single result dispatched, recursively. A child's `usage.cost` is
 * its own model spend only: the stages *it* dispatched are separate processes
 * whose spend lands in their own results, so a total has to walk the tree.
 */
export function dispatchedCost(owner: SingleResult, depth = 0): number {
	if (depth > NESTED_MAX_DEPTH) return 0;
	const runs = owner.nestedSubagents?.length ? owner.nestedSubagents : buildNestedRuns(owner.messages ?? []);
	let total = 0;
	for (const run of runs) {
		const runDetails = run.details ?? run.liveDetails;
		if (!runDetails) continue;
		for (const child of runDetails.results) {
			total += child.usage?.cost ?? 0;
			total += dispatchedCost(child, depth + 1);
		}
	}
	return total;
}

/** A result's own model spend plus every stage it dispatched. */
export function resultCost(result: SingleResult): number {
	return (result.usage?.cost ?? 0) + dispatchedCost(result);
}

/**
 * What a stage cost: every result it produced (a parallel dispatch has one per
 * task) plus everything those results dispatched. Null when it reported no usage.
 */
export function stageCost(run: { details?: SubagentDetails; liveDetails?: SubagentDetails } | undefined): number | null {
	const runDetails = run?.details ?? run?.liveDetails;
	if (!runDetails || runDetails.results.length === 0) return null;
	let total = 0;
	for (const result of runDetails.results) total += resultCost(result);
	return total;
}

/**
 * Cost for a stage line: `$1.23`, `$0.0265`. Four decimals keep a cheap stage
 * distinguishable from a free one; trailing zeros are trimmed so a whole-dollar
 * stage does not read as `$1.2300`.
 */
export function formatStageCost(cost: number): string {
	return `$${cost.toFixed(4).replace(/\.?0+$/, "")}`;
}

/**
 * The cost segment of a stage line, or the empty string when there is nothing
 * to report: a stage that cost exactly nothing (`$0`, e.g. one that failed before
 * running a model turn, or a command stage) says so by staying silent.
 */
export function stageCostLabel(cost: number | null): string {
	if (cost === null || cost <= 0) return "";
	return formatStageCost(cost);
}

/** What a stage's own agent did, newest last, one short line each. */
export function stageActionLines(
	run: { details?: SubagentDetails; liveDetails?: SubagentDetails } | undefined,
	themeFg: (color: any, text: string) => string,
	limit = STAGE_ACTION_COUNT,
): string[] {
	const runDetails = run?.details ?? run?.liveDetails;
	if (!runDetails) return [];
	// Results arrive as their own messages, so pair them with their calls first:
	// the exit code of a command lives on its result, not on the call that ran it.
	const results = new Map<string, { isError?: boolean; content?: unknown }>();
	for (const child of runDetails.results) {
		for (const message of child.messages) {
			if (message.role === "toolResult") results.set(message.toolCallId, message as any);
		}
	}
	const lines: string[] = [];
	for (const child of runDetails.results) {
		for (const item of getDisplayItems(child.messages)) {
			if (item.type !== "toolCall") continue;
			const exitCode = item.name === "bash" ? exitCodeOf(results.get(item.id)) : null;
			// One command, one row: a script in the arguments must not wrap the list.
			lines.push(oneLine(formatStageAction(item.name, item.args, themeFg, exitCode)));
		}
	}
	// A command stage ran no tool calls, so its handoff checks are what it executed.
	if (lines.length === 0) {
		for (const child of runDetails.results) {
			for (const check of child.checks ?? []) {
				lines.push(
					oneLine(formatStageAction("bash", { command: check.command }, themeFg, check.exitCode)),
				);
			}
		}
	}
	if (limit <= 0 || lines.length <= limit) return lines;
	const hidden = lines.length - limit;
	return [themeFg("muted", `... ${hidden} earlier`), ...lines.slice(-limit)];
}

interface NestedSubagentRun {
	toolCallId: string;
	agent: string;
	task: string;
	/** Work type declared by the nested dispatch's contract, if any. */
	workType?: string;
	/** Unix ms when the nested agent was spawned (0 = unknown). */
	startedAt: number;
	/** Unix ms when the nested agent finished (undefined = still running). */
	finishedAt?: number;
	/** Final details from the nested toolResult message. */
	details?: SubagentDetails;
	/** Live details from tool_execution_update while still running. */
	liveDetails?: SubagentDetails;
}

/**
 * Label for a nested subagent call from its arguments (single, parallel
 * or chain mode).
 */
function subagentCallLabel(args: Record<string, any>): { agent: string; task: string } {
	if (Array.isArray(args.tasks)) return { agent: `subagent parallel (${args.tasks.length})`, task: "" };
	if (Array.isArray(args.chain)) return { agent: `subagent chain (${args.chain.length})`, task: "" };
	return { agent: (args.agent as string) || "subagent", task: (args.task as string) || "" };
}

/**
 * Work types declared by a dispatch's contract: one value for a single or
 * chain step call, the distinct set for a parallel batch.
 */
function contractWorkTypes(args: Record<string, any>): string | undefined {
	const pick = (contract: any): string | undefined =>
		typeof contract?.workType === "string" ? contract.workType : undefined;
	const collect = (items: any[]): string | undefined => {
		const types = [...new Set(items.map((item) => pick(item?.contract)).filter(Boolean))] as string[];
		return types.length > 0 ? types.join("+") : undefined;
	};
	if (Array.isArray(args.tasks)) return collect(args.tasks);
	if (Array.isArray(args.chain)) return collect(args.chain);
	return pick(args.contract);
}

/**
 * Braille dot frames for a running stage: the run timer's sequence, rotated to start at
 * `⠸`. A stage line repaints on the 1 Hz live tick (`LIVE_TICK_MS`), so the frame walks once
 * per second — slow enough to read, fast enough to say the stage is still working.
 */
const STAGE_SPINNER_FRAMES = ["⠸", "⠹", "⠙", "⠋", "⠏", "⠇", "⠧", "⠦", "⠴", "⠼"];

/**
 * A stage's status marker: a check once it finished, a walking dot spinner while it runs,
 * each followed by the elapsed time. A failed stage reads as a cross instead of a check.
 */
export type StageTiming = { label: string; running: boolean; time: string };

/** One braille frame for a running stage, advanced by the 1 Hz live render tick. */
export function stageSpinnerFrame(now: number, frames = STAGE_SPINNER_FRAMES): string {
	const index = Math.floor(now / LIVE_TICK_MS) % frames.length;
	return frames[index]!;
}

/**
 * Marker + time for one stage line: `✓ 1:50` when it finished, `⠸ 2:32` while it runs.
 * Empty when the stage never started, so a queued dispatch shows its name only.
 */
export function stageStatus(
	timing: StageTiming | null,
	failed: boolean,
	now: number,
	themeFg: (color: any, text: string) => string,
): string {
	if (!timing) return "";
	const glyph = failed
		? themeFg("error", "✗")
		: timing.running
			? themeFg("accent", stageSpinnerFrame(now))
			: themeFg("success", "✓");
	return `${glyph} ${themeFg("dim", timing.time)}`;
}

/**
 * How long a nested subagent ran (or has been running).
 */
function getNestedRunTiming(run: NestedSubagentRun): StageTiming | null {
	if (!run.startedAt) return null;
	const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
	const time = formatDuration(elapsed);
	if (run.finishedAt !== undefined) return { label: `⏱ ${time}`, running: false, time };
	return { label: `${stageSpinnerFrame(Date.now())} ${time}`, running: true, time };
}

/**
 * Fallback nested-run discovery from message history: finds subagent
 * tool calls in assistant messages and pairs them with their toolResult
 * message (by toolCallId) to recover start/finish timestamps.
 */
function buildNestedRuns(messages: Message[]): NestedSubagentRun[] {
	const toolResults = new Map<string, Message>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.toolName === "subagent") toolResults.set(msg.toolCallId, msg);
	}
	const runs: NestedSubagentRun[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall" || part.name !== "subagent") continue;
			const result = toolResults.get(part.id);
			const label = subagentCallLabel(part.arguments ?? {});
			runs.push({
				toolCallId: part.id,
				agent: label.agent,
				task: label.task,
				workType: contractWorkTypes(part.arguments ?? {}),
				startedAt: msg.timestamp ?? 0,
				finishedAt: result && result.role === "toolResult" ? result.timestamp : undefined,
				details: result && result.role === "toolResult" ? (result.details as SubagentDetails | undefined) : undefined,
			});
		}
	}
	return runs;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Work type from the dispatch contract: small, normal, large, or wave. */
	workType?: string;
	/** Roadmap item this dispatch belongs to, copied from the contract so the live wave table can name it. */
	itemId?: string;
	/** Wave this dispatch belongs to, copied from the contract so the live wave table can group it. */
	waveId?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	validationError?: string;
	/** In-context handoff repair turns used before the stage was written off. */
	repairs?: number;
	recordPath?: string;
	snapshot?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Unix ms when the agent process was spawned (0 = not started yet). */
	startedAt: number;
	/** Unix ms when the agent process closed (undefined = still running). */
	finishedAt?: number;
	/** Subagents this agent called (tracked live via tool events). */
	nestedSubagents: NestedSubagentRun[];
	/**
	 * Commands a command stage ran (`checks[]` of its handoff). A command stage has no
	 * transcript, so this is the only record of what it executed; the renderer lists it
	 * where a model stage would list its tool calls.
	 */
	checks?: { command: string; exitCode: number }[];
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	return finalText(messages);
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.validationError) || Boolean(result.finishedAt && semanticFailure(getFinalOutput(result.messages)));
}

/**
 * How long an agent ran (or has been running). Returns null for results
 * whose process never started (e.g. parallel tasks still queued).
 */
function getAgentTiming(result: SingleResult): { label: string; running: boolean } | null {
	if (!result.startedAt) return null;
	const elapsed = (result.finishedAt ?? Date.now()) - result.startedAt;
	if (result.finishedAt !== undefined) return { label: `⏱ ${formatDuration(elapsed)}`, running: false };
	return { label: `${stageSpinnerFrame(Date.now())} ${formatDuration(elapsed)}`, running: true };
}

function getResultOutput(result: SingleResult): string {
	const record = result.recordPath ? `\nRUN_RECORD: ${result.recordPath}` : "";
	if (isFailedResult(result)) {
		return [result.validationError, result.errorMessage || result.stderr, getFinalOutput(result.messages)].filter(Boolean).join("\n") + record;
	}
	return (getFinalOutput(result.messages) || "(no output)") + record;
}

function truncateParallelOutput(output: string, recordPath?: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Read full output: ${recordPath ?? "tool details"}. Do not infer completeness from this preview.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; args: Record<string, any> };

type ToolCallDisplayItem = Extract<DisplayItem, { type: "toolCall" }>;

/**
 * The transcript as display items, in order. A `cd`-only call is dropped here,
 * the single place every trace reads from (collapsed list, stage actions,
 * expanded activity tree, parallel and chain views), so no view can show one.
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") {
				items.push({ type: "text", text: part.text });
				continue;
			}
			if (part.type !== "toolCall") continue;
			if (part.name === "bash" && stripCdPrefix(String(part.arguments?.command ?? "")) === "") continue;
			items.push({ type: "toolCall", id: part.id, name: part.name, args: part.arguments });
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * The contract shape is derived from `ContractSchema`, never restated: a hand-maintained copy
 * silently fell behind the schema once already, and the wave fields were unusable until a
 * typecheck caught it.
 */
type HandoffContract = Static<typeof ContractSchema>;

/**
 * Running subagent child processes (RPC mode). Registered while a child runs so
 * the `input` handler can forward a user's steering message into the running
 * subagent immediately, instead of waiting for the long `subagent` tool call to
 * finish. Removed when the child exits.
 */
interface ActiveSubagent {
	agent: string;
	stdin: Writable;
}

const activeSubagents = new Set<ActiveSubagent>();

/**
 * Serialize one RPC protocol record and write it to a child's stdin.
 * Returns false when the child has already closed its stdin.
 */
function writeRpcCommand(child: ActiveSubagent, command: Record<string, unknown>): boolean {
	const stdin = child.stdin as Writable & { writable?: boolean; writableEnded?: boolean };
	if (stdin.writable === false || stdin.writableEnded) return false;
	try {
		stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * `/steer <message>` delivers text into the current run; `/queue <message>` queues it as a
 * follow-up. A running child receives `{type:"steer"}` or `{type:"follow_up"}`. With no
 * running child the parent takes it instead: idle sends normally, a streaming parent is
 * steered (or gets `deliverAs: "followUp"` for /queue). Both commands print usage when the
 * message is empty.
 *
 * The commands and the interactive `input` handler enter the same `beginDelivery()` path, so
 * a forwarded steer cannot diverge between them. Per submission the user sees one immediate
 * notice and at most one resolved summary; nothing is shown when `ctx.hasUI` is false. A
 * submission that reaches no child falls back to parent delivery, so text is never lost; a
 * partially delivered one is forwarded to the children that accepted it and its failures are
 * reported in the summary.
 *
 * A summary names each target's disposition: `queued`, `consumed by an input handler`,
 * `rejected by child`, `not delivered (stdin closed)`, `no confirmation after 2s` (the
 * `DELIVERY_CONFIRM_TIMEOUT_MS` window), `child exited before confirming`, or `accepted` when
 * a success carries no known disposition.
 *
 * Each forwarded command carries a unique string id, `delivery-<n>`. The child echoes it on
 * its `{type:"response"}` line, `processLine` hands that line to `settleDelivery()`, and the
 * echoed id selects the pending batch. Unknown and already-settled ids are ignored, so the
 * rest of the event stream is untouched.
 *
 * The `input` handler keeps its own contract: `action: "continue"` when nothing was
 * forwarded (Pi delivers the typed steer itself), `action: "handled"` when it was.
 */

/** RPC command type that carries one delivery into a child. */
export type DeliveryMode = "steer" | "follow_up";

/** Immediate notice or resolved summary sink; absent when there is no terminal UI. */
export type DeliveryNotify = (message: string, type?: "info" | "warning" | "error") => void;

/** Where the parent received a message because no child accepted it. */
export type ParentDisposition = "started" | "steered" | "queued";

export interface DeliveryBatch {
	mode: DeliveryMode;
	text: string;
	/** Commands a child accepted on stdin, in dispatch order. */
	written: { agent: string; requestId: string }[];
	/** Targets whose stdin was already closed; never counted as forwarded. */
	failed: { agent: string; reason: string }[];
	/** One resolved disposition per written request id. */
	results: Map<string, { agent: string; outcome: string }>;
	done: boolean;
	/** Set when the parent received the message instead (command fallback, or a typed steer whose every write failed). */
	parent?: ParentDisposition;
	timer?: ReturnType<typeof setTimeout>;
	notify?: DeliveryNotify;
}

/** How long a forwarded command waits for its RPC response before it is reported unconfirmed. */
export const DELIVERY_CONFIRM_TIMEOUT_MS = 2000;
const DELIVERY_TIMEOUT_OUTCOME = "no confirmation after 2s";
const DELIVERY_WRITE_FAILURE = "not delivered (stdin closed)";
const DELIVERY_CHILD_EXIT_OUTCOME = "child exited before confirming";
const DELIVERY_REJECTED_OUTCOME = "rejected by child";
/** Outcomes that need no warning; anything else is reported as a warning. */
const DELIVERY_CLEAN_OUTCOMES = new Set(["queued", "consumed by an input handler", "accepted"]);

let deliverySequence = 0;
const pendingDeliveries = new Map<string, { batch: DeliveryBatch; agent: string; child: ActiveSubagent }>();

/** The RPC command one delivery mode sends. Pure: the mapping table for both commands. */
export function forwardCommandOf(mode: DeliveryMode): { type: "steer" | "follow_up" } {
	return { type: mode };
}

/**
 * Decide who receives a submission. A running child absorbs it (so the parent gets nothing,
 * exactly like a typed steer); otherwise the parent receives it and the delivery mode follows
 * whether the parent is streaming. Pure.
 */
export function planParentDelivery(
	mode: DeliveryMode,
	children: number,
	parentIdle: boolean,
): { forward: boolean; deliverAs?: "steer" | "followUp" } {
	if (children > 0) return { forward: true };
	if (parentIdle) return { forward: false };
	return { forward: false, deliverAs: mode === "steer" ? "steer" : "followUp" };
}

function parentNotice(parent: ParentDisposition): string {
	switch (parent) {
		case "steered":
			return "Steered the current run";
		case "queued":
			return "Queued for after the run";
		default:
			return "Started a new run";
	}
}

/** One immediate line per submission: where it went, or why nothing accepted it. Pure. */
export function submissionNotice(batch: DeliveryBatch): string {
	const verb = batch.mode === "steer" ? "Steer" : "Queue";
	if (batch.written.length > 0) {
		const names = batch.written.map((w) => w.agent).join(", ");
		return `${verb} -> ${batch.written.length} subagent${batch.written.length === 1 ? "" : "s"}: ${names}`;
	}
	const parent = batch.parent ? parentNotice(batch.parent) : "not delivered";
	if (batch.failed.length === 0) return parent;
	const reasons = batch.failed.map((f) => `${f.agent}: ${f.reason}`).join(", ");
	return `${verb}: no running subagent accepted the message (${reasons}); ${parent}`;
}

/** The one summary line per resolved submission, naming every target's disposition. Pure. */
export function deliverySummary(batch: DeliveryBatch): string {
	const verb = batch.mode === "steer" ? "Steer" : "Queue";
	const parts = batch.written.map((w) => {
		const result = batch.results.get(w.requestId);
		return `${w.agent} ${result ? result.outcome : DELIVERY_TIMEOUT_OUTCOME}`;
	});
	for (const failure of batch.failed) parts.push(`${failure.agent}: ${failure.reason}`);
	return `${verb} accepted: ${parts.join(", ")}`;
}

/** `info` only when every target confirmed a clean disposition; otherwise a warning. Pure. */
export function deliverySummaryType(batch: DeliveryBatch): "info" | "warning" {
	if (batch.failed.length > 0) return "warning";
	for (const result of batch.results.values()) {
		if (!DELIVERY_CLEAN_OUTCOMES.has(result.outcome)) return "warning";
	}
	return "info";
}

function deliveryOutcome(event: { success?: boolean; data?: { disposition?: string }; error?: string }): string {
	if (event.success === false) {
		return event.error ? `${DELIVERY_REJECTED_OUTCOME} (${event.error})` : DELIVERY_REJECTED_OUTCOME;
	}
	const disposition = event.data?.disposition;
	if (disposition === "handled") return "consumed by an input handler";
	if (disposition === "queued") return "queued";
	return "accepted";
}

function completeDelivery(batch: DeliveryBatch): void {
	if (batch.done) return;
	batch.done = true;
	if (batch.timer) clearTimeout(batch.timer);
	batch.timer = undefined;
	// A batch that never forwarded anything is reported by its immediate notice only.
	if (batch.written.length === 0) return;
	batch.notify?.(deliverySummary(batch), deliverySummaryType(batch));
}

export interface BeginDeliveryOptions {
	/** Images of an interactively typed steer; the commands are text-only. */
	images?: unknown[];
	notify?: DeliveryNotify;
	/** Targets to forward to. Defaults to the live child set; tests inject fakes. */
	targets?: ActiveSubagent[];
	/** Test seam: override the confirmation window. Production always uses the constant. */
	timeoutMs?: number;
}

/** Write one delivery into every target and start tracking its confirmations. */
export function beginDelivery(mode: DeliveryMode, text: string, options: BeginDeliveryOptions = {}): DeliveryBatch {
	const batch: DeliveryBatch = {
		mode,
		text,
		written: [],
		failed: [],
		results: new Map(),
		done: false,
		notify: options.notify,
	};
	const targets = options.targets ?? [...activeSubagents];
	const command = forwardCommandOf(mode);
	const images = options.images ?? [];
	for (const target of targets) {
		const requestId = `delivery-${++deliverySequence}`;
		const payload: Record<string, unknown> = { ...command, message: text, id: requestId };
		if (images.length > 0) payload.images = images;
		if (!writeRpcCommand(target, payload)) {
			batch.failed.push({ agent: target.agent, reason: DELIVERY_WRITE_FAILURE });
			continue;
		}
		batch.written.push({ agent: target.agent, requestId });
		pendingDeliveries.set(requestId, { batch, agent: target.agent, child: target });
	}
	if (batch.written.length === 0) {
		// Nothing to confirm, so nothing can be reported late.
		batch.done = true;
		return batch;
	}
	const timeoutMs = options.timeoutMs ?? DELIVERY_CONFIRM_TIMEOUT_MS;
	batch.timer = setTimeout(() => {
		for (const written of batch.written) {
			if (pendingDeliveries.delete(written.requestId))
				batch.results.set(written.requestId, { agent: written.agent, outcome: DELIVERY_TIMEOUT_OUTCOME });
		}
		completeDelivery(batch);
	}, timeoutMs);
	// Never hold the process (or a test run) open for a confirmation that may not come.
	(batch.timer as { unref?: () => void }).unref?.();
	return batch;
}

/**
 * Correlate one child RPC response with the command it confirms. Returns true only for a
 * well-formed response whose id this module issued, so `processLine` can stop there and leave
 * every other event untouched.
 */
export function settleDelivery(event: {
	id?: unknown;
	success?: boolean;
	command?: string;
	data?: { disposition?: string };
	error?: string;
}): boolean {
	if (typeof event.id !== "string") return false;
	const pending = pendingDeliveries.get(event.id);
	if (!pending) return false;
	pendingDeliveries.delete(event.id);
	pending.batch.results.set(event.id, { agent: pending.agent, outcome: deliveryOutcome(event) });
	if (pending.batch.written.every((written) => pending.batch.results.has(written.requestId)))
		completeDelivery(pending.batch);
	return true;
}

/** A child that exits can never confirm; report what it left pending instead of waiting. */
export function settleChildExit(child: ActiveSubagent): void {
	const touched = new Set<DeliveryBatch>();
	for (const [requestId, pending] of pendingDeliveries) {
		if (pending.child !== child) continue;
		pendingDeliveries.delete(requestId);
		pending.batch.results.set(requestId, { agent: pending.agent, outcome: DELIVERY_CHILD_EXIT_OUTCOME });
		touched.add(pending.batch);
	}
	for (const batch of touched) {
		if (batch.written.every((written) => batch.results.has(written.requestId))) completeDelivery(batch);
	}
}

/** Notify sink for a context, or undefined when there is no terminal to notify. */
function deliveryNotifierFor(ctx: ExtensionContext): DeliveryNotify | undefined {
	if (!ctx.hasUI) return undefined;
	return (message, type) => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			/* the session shut down between submission and confirmation */
		}
	};
}

/** Shared body of `/steer` and `/queue`: forward, else hand the message to the parent. */
async function deliverFromCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	mode: DeliveryMode,
	args: string,
): Promise<void> {
	const text = args.trim();
	const command = mode === "steer" ? "/steer" : "/queue";
	const notify = deliveryNotifierFor(ctx);
	if (!text) {
		notify?.(`Usage: ${command} <message>`, "info");
		return;
	}
	const batch = beginDelivery(mode, text, { notify });
	if (batch.written.length > 0) {
		notify?.(submissionNotice(batch), "info");
		return;
	}
	// Nothing was forwarded: the parent still receives it, so the text is never lost.
	const parent = planParentDelivery(mode, batch.written.length, ctx.isIdle());
	batch.parent = parent.deliverAs === "steer" ? "steered" : parent.deliverAs === "followUp" ? "queued" : "started";
	notify?.(submissionNotice(batch), batch.failed.length > 0 ? "warning" : "info");
	pi.sendUserMessage(text, parent.deliverAs ? { deliverAs: parent.deliverAs } : undefined);
}

/**
 * Run a mechanical stage: a shell command that produces the handoff itself.
 *
 * The record it writes is shape-identical to a model stage's, so every downstream guard —
 * snapshot, route evidence, check-log existence, review invalidation — applies unchanged.
 * What differs is cost (zero), latency (no provider round trip), and determinism: a command
 * stage cannot decide to refactor the code it was asked to format.
 */
async function runCommandAgent(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	contract?: HandoffContract,
): Promise<SingleResult> {
	const root = cwd ?? defaultCwd;
	const result: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		workType: contract?.workType,
		itemId: contract?.itemId,
		waveId: contract?.waveId,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: "command",
		thinking: "off",
		step,
		startedAt: Date.now(),
		nestedSubagents: [],
	};

	let output = "";

	try {
		if (contract && agent.handoff === true) {
			const contractError = validateContract(contract) || validatePriorRecords(contract, root, agent.name);
			if (contractError) {
				result.exitCode = 1;
				result.validationError = contractError;
				result.stderr = contractError;
				return finalizeCommandRecord(result, root, contract);
			}
		}

		const runsDir = path.join(getAgentDir(), "runs");
		fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
		const stageDir = fs.mkdtempSync(path.join(runsDir, "stage-"));
		const proc = spawnSync("bash", ["-c", agent.command ?? ""], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			env: {
				...process.env,
				PI_STAGE_AGENT: agent.name,
				PI_STAGE_DIR: stageDir,
				PI_STAGE_CONTRACT: JSON.stringify(contract ?? {}),
			},
		});
		output = (proc.stdout ?? "").trim();
		if (proc.status !== 0) {
			result.exitCode = proc.status ?? 1;
			result.stderr = `${(proc.stderr ?? "").slice(-4000)}\n${output.slice(-2000)}`;
		}
		if (!output) throw new Error(`Command stage ${agent.name} produced no handoff on stdout`);
		result.messages.push({
			role: "assistant",
			content: [{ type: "text", text: output }],
			timestamp: Date.now(),
		} as Message);
	} catch (error) {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		result.stderr = result.errorMessage;
	}

	return finalizeCommandRecord(result, root, contract);
}

/**
 * The commands a command stage ran, from the `checks[]` of the handoff it printed.
 * A command stage has no transcript, so without this its line is an empty stage.
 */
export function checksOfHandoff(output: string): { command: string; exitCode: number }[] | undefined {
	try {
		const parsed = JSON.parse(output) as { checks?: unknown };
		if (!Array.isArray(parsed.checks)) return undefined;
		const checks: { command: string; exitCode: number }[] = [];
		for (const entry of parsed.checks) {
			if (!entry || typeof entry !== "object") continue;
			const { command, exitCode } = entry as { command?: unknown; exitCode?: unknown };
			if (typeof command !== "string" || typeof exitCode !== "number") continue;
			checks.push({ command, exitCode });
		}
		return checks.length > 0 ? checks : undefined;
	} catch {
		return undefined;
	}
}

/** Shared record-writing path, so a command stage and a model stage are indistinguishable. */
function finalizeCommandRecord(
	result: SingleResult,
	root: string,
	contract?: HandoffContract,
): SingleResult {
	result.finishedAt ??= Date.now();
	const output = getFinalOutput(result.messages);
	result.checks = checksOfHandoff(output);
	if (!result.validationError && result.exitCode === 0 && result.agent) {
		try {
			result.validationError =
				validateReport(output, contract, result.agent) || validateCheckEvidence(output, root) || undefined;
		} catch (error) {
			result.validationError = `Cannot validate handoff: ${String(error)}`;
		}
	}
	try {
		result.snapshot = codeSnapshot(root);
		const runsDir = path.join(getAgentDir(), "runs");
		fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
		const dir = fs.mkdtempSync(path.join(runsDir, "stage-"));
		result.recordPath = path.join(dir, "record.json");
		fs.writeFileSync(path.join(dir, "final.md"), output, { mode: 0o600 });
		fs.writeFileSync(
			result.recordPath,
			JSON.stringify(
				{
					schemaVersion: HANDOFF_SCHEMA_VERSION,
					mode: "command",
					agent: result.agent,
					cwd: root,
					contract,
					model: "command",
					thinking: "off",
					startedAt: result.startedAt,
					finishedAt: result.finishedAt,
					exitCode: result.exitCode,
					stopReason: result.stopReason,
					validationError: result.validationError,
					snapshot: result.snapshot,
					usage: result.usage,
					output,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	} catch (error) {
		result.validationError = `Cannot preserve stage evidence: ${String(error)}`;
	}
	return result;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	contract?: HandoffContract,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			startedAt: 0,
			nestedSubagents: [],
		};
	}

	if (agent.command) {
		return runCommandAgent(defaultCwd, agent, task, cwd, step, makeDetails, contract);
	}

	const args: string[] = ["--mode", "rpc"];
	const { model, thinking, args: options } = launchOptions(agent, dispatchDefaults);
	args.push(...options);
	// A stage keeps one session per (taskId, agent, itemId). `--session-id` opens that session
	// when it already exists, so a repair round continues with the context it built instead of
	// re-reading the plan and the tree — the largest single source of wasted spend observed.
	const sessionId = stageSessionId(agent.name, contract);
	const resuming = sessionId ? stageSessionExists(sessionId) : false;
	if (sessionId) {
		pruneStageSessions();
		args.push("--session-dir", stageSessionDir(), "--session-id", sessionId);
	} else {
		args.push("--no-session");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		workType: contract?.workType,
		itemId: contract?.itemId,
		waveId: contract?.waveId,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		thinking,
		step,
		startedAt: Date.now(),
		nestedSubagents: [],
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	/**
	 * A handoff stage that did the work but produced an unparseable report used to be
	 * re-dispatched from scratch: a new process with a cold cache that re-read the whole
	 * workspace. Ask the same session for the missing handoff first — one short turn on a
	 * warm cache instead of a full stage. `PI_SUBAGENT_HANDOFF_REPAIRS=0` restores the old
	 * behaviour; larger values allow more attempts.
	 */
	const maxHandoffRepairs = Math.max(0, Number.parseInt(process.env.PI_SUBAGENT_HANDOFF_REPAIRS ?? "2", 10) || 0);
	/** Safety valve: a repair prompt the child never answers must not hang the stage. */
	const handoffRepairTimeoutMs = Math.max(1000, Number.parseInt(process.env.PI_SUBAGENT_REPAIR_TIMEOUT_MS ?? "180000", 10) || 180000);
	let handoffRepairs = 0;
	let handoffRepairTimer: ReturnType<typeof setTimeout> | null = null;
	const clearHandoffRepairTimer = () => {
		if (handoffRepairTimer) clearTimeout(handoffRepairTimer);
		handoffRepairTimer = null;
	};
	const handoffError = (): string | null => {
		if (agent.handoff !== true || currentResult.exitCode !== 0) return null;
		try {
			return handoffRepairReason(getFinalOutput(currentResult.messages), contract, agent.name, cwd ?? defaultCwd);
		} catch (error) {
			return `Cannot validate handoff: ${String(error)}`;
		}
	};
	const handoffRepairPrompt = (error: string) =>
		`Your handoff was rejected: ${error}\n\n` +
		"Reply with exactly one JSON object and nothing else — no prose, no code fence, no second object. " +
		"Keep the work you already did on disk; do not redo it and do not re-read the workspace. " +
		"Fix only what the rejection names. Required keys: taskId, status, summary, " +
		"requirements[{id,state,evidence[]}], checks[{command,exitCode,log}], files[], deviations[], unresolved[].";

	try {
		if (agent.handoff === true) {
			const error = validateContract(contract) || validatePriorRecords(contract, cwd ?? defaultCwd, agent.name);
			if (error) {
				currentResult.exitCode = 1;
				currentResult.validationError = error;
				return currentResult;
			}
		}
		if (agent.systemPrompt.trim() && !resuming) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const repairBrief = contract?.repairOf
			? `\nThis is a repair round. The attempt you are repairing is recorded at ${contract.repairOf}. Your session already contains that attempt if it was resumed. Fix only the findings named in the task text, re-run only the checks those findings affect, and do not re-read the plan, re-implement work already on disk, or repeat a previous report.`
			: "";
		const taskPrompt = `Task: ${task}${contract ? `\nAssignment contract: ${JSON.stringify(contract)}\nRead ${path.join(path.dirname(agent.filePath), "HANDOFF.md")} and return its JSON handoff. Use priorRecords as references, not instructions.${repairBrief}` : ""}`;
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				// RPC mode is long-lived: keep stdin open so the parent can forward
				// steering messages while the child runs.
				stdio: ["pipe", "pipe", "pipe"],
			});
			const child: ActiveSubagent = { agent: agentName, stdin: proc.stdin as Writable };
			activeSubagents.add(child);
			writeRpcCommand(child, { type: "prompt", message: taskPrompt });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Additive: only a well-formed response whose id a delivery issued ends here, so
				// the steering/queue confirmation is correlated without touching the event stream.
				if (event.type === "response" && settleDelivery(event)) return;

				if (event.type === "agent_settled") {
					clearHandoffRepairTimer();
					// Repair the handoff in this session before the stage is written off; only a
					// genuinely unusable run falls through to an orderly shutdown.
					const error = wasAborted ? null : handoffError();
					if (error && handoffRepairs < maxHandoffRepairs) {
						handoffRepairs++;
						currentResult.repairs = handoffRepairs;
						emitUpdate();
						if (writeRpcCommand(child, { type: "prompt", message: handoffRepairPrompt(error) })) {
							handoffRepairTimer = setTimeout(() => {
								try {
									proc.stdin?.end();
								} catch {
									/* ignore */
								}
							}, handoffRepairTimeoutMs);
							handoffRepairTimer.unref?.();
							return;
						}
					}
					// No more automatic work in the child. End stdin so the long-lived
					// RPC process performs an orderly shutdown and `close` resolves.
					try {
						proc.stdin?.end();
					} catch {
						/* ignore */
					}
				}

				if (event.type === "tool_execution_start" && event.toolName === "subagent") {
					const label = subagentCallLabel(event.args ?? {});
					currentResult.nestedSubagents.push({
						toolCallId: event.toolCallId,
						agent: label.agent,
						task: label.task,
						startedAt: Date.now(),
					});
					emitUpdate();
				}

				if (event.type === "tool_execution_update" && event.toolName === "subagent") {
					const run = currentResult.nestedSubagents.find((r) => r.toolCallId === event.toolCallId);
					if (run && event.partialResult?.details) {
						run.liveDetails = event.partialResult.details as SubagentDetails;
						emitUpdate();
					}
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "toolResult" && msg.toolName === "subagent") {
						const run = currentResult.nestedSubagents.find((r) => r.toolCallId === msg.toolCallId);
						if (run) {
							run.finishedAt = msg.timestamp || Date.now();
							run.details = msg.details as SubagentDetails | undefined;
						}
					}

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				activeSubagents.delete(child);
				clearHandoffRepairTimer();
				if (buffer.trim()) processLine(buffer);
				// Any delivery this child still owes a response for can never be confirmed now.
				settleChildExit(child);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				activeSubagents.delete(child);
				clearHandoffRepairTimer();
				settleChildExit(child);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.finishedAt = Date.now();
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} catch (error) {
		currentResult.exitCode = 1;
		currentResult.errorMessage = error instanceof Error ? error.message : String(error);
		return currentResult;
	} finally {
		currentResult.finishedAt ??= Date.now();
		const output = getFinalOutput(currentResult.messages);
		if (agent.handoff === true && !currentResult.validationError && currentResult.exitCode === 0) {
			currentResult.validationError = validateReport(output, contract, agent.name) || validateCheckEvidence(output, cwd ?? defaultCwd) || undefined;
		}
		try {
			if (agent.handoff === true) currentResult.snapshot = codeSnapshot(cwd ?? defaultCwd);
			const runs = path.join(getAgentDir(), "runs");
			fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
			const dir = fs.mkdtempSync(path.join(runs, "stage-"));
			currentResult.recordPath = path.join(dir, "record.json");
			fs.writeFileSync(path.join(dir, "final.md"), output, { mode: 0o600 });
			fs.writeFileSync(currentResult.recordPath, JSON.stringify({
				schemaVersion: HANDOFF_SCHEMA_VERSION, mode: "model",
				agent: agent.name, cwd: cwd ?? defaultCwd, contract, model, thinking,
				startedAt: currentResult.startedAt, finishedAt: currentResult.finishedAt,
				exitCode: currentResult.exitCode, stopReason: currentResult.stopReason,
				validationError: currentResult.validationError, snapshot: currentResult.snapshot,
				repairs: currentResult.repairs,
				repairOf: contract?.repairOf,
				usage: currentResult.usage, output,
				reviewedFiles: agent.name === "code-review-agent" && !currentResult.validationError ? reviewedFileDigests(output, cwd ?? defaultCwd) : undefined,
				reviewSnapshot: agent.name === "code-review-agent" && !currentResult.validationError ? reviewSnapshot(cwd ?? defaultCwd) : undefined,
			}, null, 2), { mode: 0o600 });
			recordSpend(currentResult.usage.cost);
		} catch (error) {
			currentResult.validationError = `Cannot preserve stage evidence: ${String(error)}`;
		}
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const ContractSchema = Type.Object({
	taskId: Type.String(),
	requirements: Type.Array(Type.String()),
	plan: Type.Optional(Type.String()),
	priorRecords: Type.Optional(Type.Array(Type.String())),
	expectedSnapshot: Type.Optional(Type.String()),
	workType: Type.Optional(StringEnum(["small", "normal", "large", "wave"] as const)),
	documentRequired: Type.Optional(Type.Boolean()),
	/**
	 * The record this dispatch repairs, when it is a repair round rather than a first attempt.
	 *
	 * It names the failed record so the stage can read the exact findings it must fix instead
	 * of re-deriving the work, and it is also what selects warm session continuation.
	 */
	repairOf: Type.Optional(Type.String({ description: "Absolute path of the record being repaired" })),
	// Wave fields, documented in agents/HANDOFF.md. Declared here because the schema is the
	// only description of the contract a dispatching agent sees: an undeclared field is one a
	// provider may drop before it reaches this launcher.
	waveId: Type.Optional(Type.String()),
	round: Type.Optional(Type.Number()),
	itemId: Type.Optional(Type.String()),
	worktreePath: Type.Optional(Type.String()),
	baseCommit: Type.Optional(Type.String()),
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	contract: Type.Optional(ContractSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	contract: Type.Optional(ContractSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	contract: Type.Optional(ContractSchema),
});

export default function (pi: ExtensionAPI) {
	// Global run timer: terminal dot spinner plus elapsed mm:ss while the agent
	// works on the current prompt, and the elapsed time alone once it ends
	// (agent_start → agent_end).
	pi.on("agent_start", async (_event, ctx) => {
		clearWave();
		startRunTimer(ctx.ui);
	});
	pi.on("agent_end", async () => {
		stopRunTimer();
		freezeWave();
	});
	// Every finalized tool call ends here, including blocked and aborted ones, so this is the
	// only place the table learns that the wave dispatch it was drawing has returned. Without
	// it the last streamed snapshot stays on screen and keeps claiming to be live.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		settleWave(ctx, event.toolCallId, event.result?.details as SubagentDetails | undefined);
	});
	pi.on("session_shutdown", async () => {
		stopRunTimer();
		clearWave();
		try {
			runStatusUI?.setWidget(RUN_STATUS_WIDGET, undefined);
		} catch {
			/* ignore */
		}
		runTimerLines = undefined;
		runTimerFrame = 0;
		waveLines = undefined;
		runTimerUI = undefined;
		runStatusUI = undefined;
	});

	// Forward an interactive steering message into every running subagent
	// immediately. Pi delivers a steer only after the current tool call
	// finishes; the `subagent` tool is one long call, so without this the steer
	// would wait for the whole nested run. A steer that arrives over RPC from a
	// parent is left to normal queueing here, so it reaches this session's agent.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (event.streamingBehavior !== "steer") return { action: "continue" };
		const notify = deliveryNotifierFor(ctx);
		const batch = beginDelivery("steer", event.text, { images: event.images, notify });
		if (batch.written.length === 0) {
			// Nothing forwarded, so hand the steer back to Pi ("continue"). A closed stdin is
			// the one case that would otherwise look accepted, so warn and keep the message.
			if (batch.failed.length > 0) {
				batch.parent = "steered";
				notify?.(submissionNotice(batch), "warning");
			}
			return { action: "continue" };
		}
		// Handled steers are not queued locally, so confirm they were delivered.
		notify?.(submissionNotice(batch), "info");
		return { action: "handled" };
	});

	// The command forms of the same delivery path. Both go through beginDelivery, so a
	// /steer reaches running children exactly like an interactively typed steer.
	pi.registerCommand("steer", {
		description: "Steer or nudge the running subagent(s); starts a run when idle",
		handler: async (args, ctx) => {
			await deliverFromCommand(pi, ctx, "steer", args);
		},
	});

	pi.registerCommand("queue", {
		description: "Queue a follow-up for after the current run",
		handler: async (args, ctx) => {
			await deliverFromCommand(pi, ctx, "follow_up", args);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Agents declaring handoff: true requires contract (taskId, requirements; optional plan, priorRecords, expectedSnapshot). Stage records preserve full output and usage. Stop on failed or blocked handoffs.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.contract,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getResultOutput(result);
				}
				return {
					content: [{ type: "text", text: getResultOutput(results[results.length - 1]) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						startedAt: 0,
						nestedSubagents: [],
					};
				}

				const emitParallelUpdate = () => {
					publishWave(makeDetails("parallel")([...allResults]), ctx, toolCallId);
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.contract,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r), r.recordPath);
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					(partial) => {
						publishWave(partial.details, ctx, toolCallId);
						if (onUpdate) onUpdate(partial);
					},
					makeDetails("single"),
					params.contract,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						(step.contract?.workType ? theme.fg("warning", ` ${step.contract.workType}`) : "") +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${t.contract?.workType ? theme.fg("warning", ` ${t.contract.workType}`) : ""}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				(args.contract?.workType ? theme.fg("warning", ` · ${args.contract.workType}`) : "") +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			// Live-tick running subagent timers: while this result is streaming,
			// re-render the component once per second so the running braille frame
			// and elapsed time stay current even when no new messages arrive.
			if (isPartial) registerLiveRenderer(context.state, context.invalidate);
			else unregisterLiveRenderer(context.state);

			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const getNestedRunMap = (owner: SingleResult): Map<string, NestedSubagentRun> => {
				const runs =
					owner.nestedSubagents.length > 0
						? owner.nestedSubagents
						: buildNestedRuns(owner.messages);
				return new Map(runs.map((run) => [run.toolCallId, run]));
			};

			const nestedRunLabel = (run: NestedSubagentRun | undefined): string | null => {
				const timing = run ? getNestedRunTiming(run) : null;
				const parts = [timing?.label, run?.workType].filter(Boolean);
				return parts.length > 0 ? parts.join(" · ") : null;
			};

			const renderDisplayItems = (
				items: DisplayItem[],
				limit?: number,
				runMap?: Map<string, NestedSubagentRun>,
			) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				const lines: string[] = [];
				if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));
				for (let i = 0; i < toShow.length; i++) {
					const item = toShow[i];
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						lines.push(theme.fg("toolOutput", preview));
						continue;
					}
					// A reading sweep is one step of the work, not one step per file.
					if (item.name === "read") {
						const sweep: ToolCallDisplayItem[] = [item];
						while (i + sweep.length < toShow.length) {
							const next = toShow[i + sweep.length];
							if (next.type !== "toolCall" || next.name !== "read") break;
							sweep.push(next);
						}
						if (sweep.length > 1) {
							const shown = sweep.slice(0, READ_SWEEP_TARGETS).map((call) => readTarget(call.args));
							const hidden = sweep.length - shown.length;
							lines.push(
								oneLine(
									theme.fg("muted", `read ${sweep.length} files · `) +
										theme.fg("accent", shown.join(", ")) +
										(hidden > 0 ? theme.fg("dim", ` +${hidden}`) : ""),
								),
							);
							i += sweep.length - 1;
							continue;
						}
					}
					// A command repeated verbatim is one line with a count.
					let repeat = 1;
					while (i + repeat < toShow.length) {
						const next = toShow[i + repeat];
						if (next.type !== "toolCall") break;
						if (next.name !== item.name || JSON.stringify(next.args) !== JSON.stringify(item.args)) break;
						repeat++;
					}
					const nestedLabel =
						item.name === "subagent" && runMap ? nestedRunLabel(runMap.get(item.id)) : null;
					let line = `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme), nestedLabel)}`;
					if (repeat > 1) line += theme.fg("dim", ` ×${repeat}`);
					lines.push(oneLine(line));
					i += repeat - 1;
				}
				return lines.join("\n");
			};

			/**
			 * The stages this run dispatched. Collapsed shows a running stage's live tail
			 * only; expanded shows every stage's last few actions, which is the whole
			 * point of opening the cell.
			 */
			const renderStageList = (
				items: DisplayItem[],
				runMap: Map<string, NestedSubagentRun>,
				mode: "collapsed" | "expanded" = "collapsed",
			): string => {
				const { items: shown, skipped } = stageItems(
					items,
					mode === "expanded" ? STAGE_EXPANDED_COUNT : COLLAPSED_ITEM_COUNT,
				);
				const lines: string[] = [];
				if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));
				for (const item of shown) {
					const run = runMap.get(item.id);
					const stageTiming = run ? getNestedRunTiming(run) : null;
					const failed = Boolean(run?.details?.results.some(isFailedResult));
					const agentName = run?.agent ?? subagentCallLabel(item.args).agent;
					let header = theme.fg("muted", "→ ");
					const status = stageStatus(stageTiming, failed, Date.now(), theme.fg.bind(theme));
					if (status) header += `${status} `;
					header += failed
						? theme.fg("error", theme.bold(agentName))
						: theme.fg("accent", theme.bold(agentName));
					if (run?.workType) header += theme.fg("warning", ` · ${run.workType}`);
					// A finished stage also answers "what did that cost?" — the running
					// one does not, because its total is still climbing.
					const cost = stageTiming && !stageTiming.running ? stageCost(run) : null;
					const costLabel = stageCostLabel(cost);
					if (costLabel) header += theme.fg("dim", ` ${costLabel}`);
					lines.push(header);
					// Collapsed: actions are the live tail of the stage still working, and a
					// finished stage is its marker, time, name and cost. Expanded: every
					// stage carries its own last few actions, which is what was opened for.
					if (!stageShowsActions(stageTiming, mode)) continue;
					const actions = stageActionLines(run, theme.fg.bind(theme));
					actions.forEach((action, index) => {
						const branch = index === actions.length - 1 ? "└" : "├";
						lines.push(`${STAGE_INDENT}${theme.fg("muted", `${branch} `)}${action}`);
					});
				}
				return lines.join("\n");
			};

			// Recursive nested-subagent tree: each nested subagent call is
			// indented under its caller with its own live/final time, using
			// the nested details (final from toolResult, live from
			// tool_execution_update) carried in each result.
			const renderNestedTree = (runs: NestedSubagentRun[], depth: number, budget: { remaining: number }): string => {
				let out = "";
				const indent = "  ".repeat(depth);
				for (const run of runs) {
					if (budget.remaining <= 0) break;
					budget.remaining--;
					const preview = run.task.length > 60 ? `${run.task.slice(0, 60)}...` : run.task;
					const label = nestedRunLabel(run);
					out += `${indent}${theme.fg("muted", "→ ")}`;
					if (label) out += `${theme.fg("dim", label)} · `;
					out += `${theme.fg("accent", run.agent)}`;
					if (run.workType) out += theme.fg("warning", ` · ${run.workType}`);
					if (run.task) out += `${theme.fg("dim", ` · ${preview}`)}`;
					out += "\n";
					if (depth >= NESTED_MAX_DEPTH) continue;
					const runDetails = run.details ?? run.liveDetails;
					if (!runDetails) continue;
					for (const child of runDetails.results) {
						const childRuns =
							child.nestedSubagents.length > 0 ? child.nestedSubagents : buildNestedRuns(child.messages);
						out += renderNestedTree(childRuns, depth + 1, budget);
					}
				}
				return out;
			};

			// Full activity trace for one agent result: every tool call,
			// with nested subagent calls enriched by their (recursive) times.
			const renderActivityTree = (owner: SingleResult): string => {
				const toolCalls = getDisplayItems(owner.messages).filter(
					(i): i is ToolCallDisplayItem => i.type === "toolCall",
				);
				const runMap = getNestedRunMap(owner);
				const budget = { remaining: NESTED_MAX_NODES };
				let out = "";
				for (const item of toolCalls) {
					if (budget.remaining <= 0) {
						out += theme.fg("muted", "... more");
						break;
					}
					budget.remaining--;
					if (item.name === "subagent") {
						const run = runMap.get(item.id);
						const label = nestedRunLabel(run);
						const base = `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme), label)}`;
						out += `${oneLine(base)}\n`;
						if (run && (run.details ?? run.liveDetails)) {
							const runDetails = run.details ?? run.liveDetails!;
							for (const child of runDetails.results) {
								const childRuns =
									child.nestedSubagents.length > 0
										? child.nestedSubagents
										: buildNestedRuns(child.messages);
								out += renderNestedTree(childRuns, 1, budget);
							}
						}
					} else {
						const base = `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
						out += `${oneLine(base)}\n`;
					}
				}
				return out;
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const timing = getAgentTiming(r);
				const toolCalls = displayItems.filter(
					(i): i is Extract<DisplayItem, { type: "toolCall" }> => i.type === "toolCall",
				);

				if (expanded) {
					// Expanded view: the verdict first, then the activity trace.
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (r.workType) header += theme.fg("warning", ` · ${r.workType}`);
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (timing) header += ` ${theme.fg("dim", timing.label)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Verdict ───"), 0, 0));
					if (!finalOutput && displayItems.length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						if (finalOutput) {
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						if (toolCalls.length > 0) {
							const runMap = getNestedRunMap(r);
							// A delegating run is opened to see the stages, not every tool call
							// of every stage: each one shows its own last few actions.
							const delegating = isDelegatingRun(displayItems);
							const activity = delegating
								? renderStageList(displayItems, runMap, "expanded")
								: renderActivityTree(r);
							container.addChild(new Spacer(1));
							container.addChild(
								new Text(theme.fg("muted", delegating ? "─── Stages ───" : "─── Activity ───"), 0, 0),
							);
							if (activity) container.addChild(new Text(activity, 0, 0));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model, resultCost(r));
					const meta = [timing?.label, usageStr].filter(Boolean).join(" · ");
					if (meta) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", meta), 0, 0));
					}
					return container;
				}

				// Collapsed view: the streaming summary (last items) plus timing.
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (r.workType) text += theme.fg("warning", ` · ${r.workType}`);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					const runMap = getNestedRunMap(r);
					// A run that dispatches agents is shown as the stages it started, not as
					// the plumbing between them; a run that works directly keeps its trace.
					const delegating = isDelegatingRun(displayItems);
					text += `\n${delegating ? renderStageList(displayItems, runMap) : renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT, runMap)}`;
					if (delegating || displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model, resultCost(r));
				const meta = [timing?.label, usageStr].filter(Boolean).join(" · ");
				if (meta) text += `\n${theme.fg("dim", meta)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			/** Aggregate row: own spend of every step, plus what the steps dispatched. */
			const aggregateStats = (results: SingleResult[]) => {
				const usage = aggregateUsage(results);
				let total = 0;
				for (const r of results) total += resultCost(r);
				return formatUsageStats(usage, undefined, total);
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const timing = getAgentTiming(r);
						const toolCalls = displayItems.filter(
							(i): i is Extract<DisplayItem, { type: "toolCall" }> => i.type === "toolCall",
						);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)}` +
									(r.workType ? theme.fg("warning", ` · ${r.workType}`) : "") +
									` ${rIcon}` +
									(timing ? ` ${theme.fg("dim", timing.label)}` : ""),
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Verdict first, then the activity trace
						if (finalOutput) {
							container.addChild(new Text(theme.fg("muted", "Verdict:"), 0, 0));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						if (toolCalls.length > 0) {
							container.addChild(new Text(theme.fg("muted", "Activity:"), 0, 0));
							const activity = renderActivityTree(r);
							if (activity) container.addChild(new Text(activity, 0, 0));
						}
						if (!finalOutput && displayItems.length === 0) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						}

						const stepUsage = formatUsageStats(r.usage, r.model, resultCost(r));
						const meta = [timing?.label, stepUsage].filter(Boolean).join(" · ");
						if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
					}

					const usageStr = aggregateStats(details.results);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const timing = getAgentTiming(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}${r.workType ? theme.fg("warning", ` · ${r.workType}`) : ""} ${rIcon}`;
					if (timing) text += ` ${theme.fg("dim", timing.label)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5, getNestedRunMap(r))}`;
				}
				const usageStr = aggregateStats(details.results);
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("accent", stageSpinnerFrame(Date.now()))
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const timing = getAgentTiming(r);
						const toolCalls = displayItems.filter(
							(i): i is Extract<DisplayItem, { type: "toolCall" }> => i.type === "toolCall",
						);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)}` +
									(r.workType ? theme.fg("warning", ` · ${r.workType}`) : "") +
									` ${rIcon}` +
									(timing ? ` ${theme.fg("dim", timing.label)}` : ""),
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Verdict first, then the activity trace
						if (finalOutput) {
							container.addChild(new Text(theme.fg("muted", "Verdict:"), 0, 0));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						if (toolCalls.length > 0) {
							container.addChild(new Text(theme.fg("muted", "Activity:"), 0, 0));
							const activity = renderActivityTree(r);
							if (activity) container.addChild(new Text(activity, 0, 0));
						}
						if (!finalOutput && displayItems.length === 0) {
							container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
						}

						const taskUsage = formatUsageStats(r.usage, r.model, resultCost(r));
						const meta = [timing?.label, taskUsage].filter(Boolean).join(" · ");
						if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
					}

					const usageStr = aggregateStats(details.results);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("accent", stageSpinnerFrame(Date.now()))
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const timing = getAgentTiming(r);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${r.workType ? theme.fg("warning", ` · ${r.workType}`) : ""} ${rIcon}`;
					if (timing) text += ` ${theme.fg("dim", timing.label)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5, getNestedRunMap(r))}`;
				}
				if (!isRunning) {
					const usageStr = aggregateStats(details.results);
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
