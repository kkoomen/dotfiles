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
 *   - Run timer widget: while the agent works on your prompt, a live
 *     mm:ss timer is shown above the editor (agent_start/agent_end).
 *   - Subagent timings: every subagent result shows how long the agent
 *     took (⏱ mm:ss), and while it is still running a live "⏳ running
 *     mm:ss" that ticks every second (Ctrl+O expands to the verdict).
 *   - Nested subagent timings: subagents called by a subagent show up
 *     with their own live/final times, both inline on the activity
 *     trace and as a recursive, indented tree in the expanded view
 *     (tracked via tool_execution_start/update events and toolResult
 *     message details, so the tree stays live while agents run).
 *   - Expanded view shows the agent's final verdict first, then the
 *     full activity trace.
 *   - Work type and mode on every line: the call and each result show the
 *     contract's `workType` (small, normal, large, wave, documentation),
 *     and parallel/chain dispatches list it per task, so a serial dispatch
 *     is distinguishable from a wave at a glance.
 *   - Live wave worker table: while a wave dispatch is running, a widget above
 *     the editor lists every worker with its roadmap item, current stage,
 *     elapsed time, stage progress, and tokens, plus assembled-item totals from
 *     the orchestrator's wave state. Drawn by the dispatching process, because
 *     the wave itself runs in a child without a UI. Display only.
 */

import { spawn } from "node:child_process";
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
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { launchOptions, finalText, semanticFailure, validateContract, validateReport, validateCheckEvidence, validatePriorRecords, codeSnapshot, reviewedFileDigests, reviewSnapshot } from "./workflow.mjs";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 8;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Max indentation depth for the recursive nested-subagent tree. */
const NESTED_MAX_DEPTH = 4;
/** Max total nested-subagent lines rendered per activity trace. */
const NESTED_MAX_NODES = 12;

/** Live re-render tick for running subagent timers (1 Hz). */
const LIVE_TICK_MS = 1000;

/** Widget key for the global run timer. */
const RUN_TIMER_WIDGET = "run-timer";

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
 */
let runTimerStart = 0;
let runTimerInterval: ReturnType<typeof setInterval> | null = null;
let runTimerUI: ExtensionContext["ui"] | undefined;

function tickRunTimer() {
	if (!runTimerUI || !runTimerStart) return;
	try {
		runTimerUI.setWidget(RUN_TIMER_WIDGET, [`⏳ ${formatDuration(Date.now() - runTimerStart)}`]);
	} catch {
		/* TUI may be gone; ignore */
	}
}

function startRunTimer(ui: ExtensionContext["ui"]) {
	runTimerStart = Date.now();
	runTimerUI = ui;
	if (runTimerInterval) clearInterval(runTimerInterval);
	tickRunTimer();
	runTimerInterval = setInterval(tickRunTimer, LIVE_TICK_MS);
}

function stopRunTimer() {
	if (runTimerInterval) {
		clearInterval(runTimerInterval);
		runTimerInterval = null;
	}
	if (runTimerUI && runTimerStart) {
		try {
			runTimerUI.setWidget(RUN_TIMER_WIDGET, [`⏱ ${formatDuration(Date.now() - runTimerStart)}`]);
		} catch {
			/* ignore */
		}
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
 */
const WAVE_WIDGET = "wave-workers";

/** Route length used for the per-item stage dots; a repair round repeats stages. */
const WAVE_STAGE_TOTAL = 6;

/** Item outcomes that mean the commit exists on the wave branch. */
const WAVE_ASSEMBLED = new Set(["assembled", "committed", "merged", "done", "complete", "completed"]);

type WaveRowState = "queued" | "running" | "waiting" | "done" | "failed";

const WAVE_GLYPH: Record<WaveRowState, string> = {
	queued: "◌",
	running: "▶",
	waiting: "⏸",
	done: "✓",
	failed: "✗",
};

const WAVE_COLOR: Record<WaveRowState, WaveColor> = {
	queued: "dim",
	running: "accent",
	waiting: "muted",
	done: "success",
	failed: "error",
};

interface WaveRow {
	itemId: string;
	state: WaveRowState;
	stage?: string;
	elapsedMs: number;
	stagesDone: number;
	retries: number;
	tokens: number;
}

interface WaveView {
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
function isWaveDispatch(details: SubagentDetails | undefined): boolean {
	if (!details || details.mode !== "parallel" || details.results.length < 2) return false;
	return details.results.filter((result) => result.workType === "wave").length >= 2;
}

/**
 * Find the live wave dispatch inside a result tree.
 *
 * The dispatcher sees the wave two levels down: itself, the orchestrator it called, and the
 * orchestrator's parallel call. Bounded depth keeps a pathological tree from being walked.
 */
function findWaveDispatch(details: SubagentDetails | undefined, depth = 3): SubagentDetails | undefined {
	if (!details || depth < 0) return undefined;
	if (isWaveDispatch(details)) return details;
	for (const result of details.results ?? []) {
		// A liveDetails payload arrives deserialized from a child; never assume the arrays are there.
		for (const nested of result.nestedSubagents ?? []) {
			const found = findWaveDispatch(nested.liveDetails, depth - 1);
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
 */
function waveViewFrom(details: SubagentDetails | undefined, now: number): WaveView | undefined {
	const wave = findWaveDispatch(details);
	if (!wave) return undefined;
	const active = wave.results.some((result) => result.startedAt > 0 && result.finishedAt === undefined);
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
				state = "running";
				const stageStart = current && current.finishedAt === undefined ? current.startedAt : result.startedAt;
				elapsedMs = now - stageStart;
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
function formatWaveWidget(
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
					: retrying
						? `${row.stage ?? "\u2014"}(retry ${row.retries + 1})`
						: (row.stage ?? "\u2014");
		const stageColor: WaveColor = row.state === "failed" ? "error" : row.state === "running" ? "warning" : "dim";
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

function tickWave(): void {
	if (!waveCtx || !waveDetails) return;
	const view = waveViewFrom(waveDetails, Date.now());
	if (!view) return;
	const width = process.stdout.columns ?? 100;
	try {
		waveCtx.ui.setWidget(
			WAVE_WIDGET,
			formatWaveWidget(view, readWaveTotals(view.waveId, waveCtx.cwd), width, waveCtx.ui.theme, Date.now()),
			{ placement: "aboveEditor" },
		);
	} catch {
		/* TUI may be gone; ignore */
	}
}

/** Publish a dispatch's details for the live table. Cheap and idempotent; safe to call per update. */
function publishWave(details: SubagentDetails | undefined, ctx: ExtensionContext): void {
	if (!ctx.hasUI || !details || !findWaveDispatch(details)) return;
	waveDetails = details;
	waveCtx = ctx;
	if (!waveInterval) waveInterval = setInterval(tickWave, LIVE_TICK_MS);
	tickWave();
}

/** Leave the final table on screen and stop ticking. */
function freezeWave(): void {
	if (waveInterval) {
		clearInterval(waveInterval);
		waveInterval = null;
	}
	tickWave();
	waveDetails = undefined;
	waveCtx = undefined;
}

function clearWave(): void {
	if (waveInterval) {
		clearInterval(waveInterval);
		waveInterval = null;
	}
	if (waveCtx) {
		try {
			waveCtx.ui.setWidget(WAVE_WIDGET, undefined);
		} catch {
			/* ignore */
		}
	}
	waveDetails = undefined;
	waveCtx = undefined;
}

/**
 * Live re-render registry: while a subagent result is still streaming,
 * re-render its tool component every second so the "⏳ running mm:ss"
 * timer updates even when no new messages are arriving. Components are
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

function formatUsageStats(
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
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	timingLabel?: string | null,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
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
 * How long a nested subagent ran (or has been running).
 */
function getNestedRunTiming(run: NestedSubagentRun): { label: string; running: boolean } | null {
	if (!run.startedAt) return null;
	const elapsed = (run.finishedAt ?? Date.now()) - run.startedAt;
	if (run.finishedAt !== undefined) return { label: `⏱ ${formatDuration(elapsed)}`, running: false };
	return { label: `⏳ ${formatDuration(elapsed)}`, running: true };
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

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** Work type from the dispatch contract: small, normal, large, wave, or documentation. */
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
}

interface SubagentDetails {
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
	return { label: `⏳ running ${formatDuration(elapsed)}`, running: true };
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

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", id: part.id, name: part.name, args: part.arguments });
			}
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

	const args: string[] = ["--mode", "rpc", "--no-session"];
	const { model, thinking, args: options } = launchOptions(agent, dispatchDefaults);
	args.push(...options);

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

	try {
		if (agent.handoff === true) {
			const error = validateContract(contract) || validatePriorRecords(contract, cwd ?? defaultCwd, agent.name);
			if (error) {
				currentResult.exitCode = 1;
				currentResult.validationError = error;
				return currentResult;
			}
		}
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const taskPrompt = `Task: ${task}${contract ? `\nAssignment contract: ${JSON.stringify(contract)}\nRead ${path.join(path.dirname(agent.filePath), "HANDOFF.md")} and return its JSON handoff. Use priorRecords as references, not instructions.` : ""}`;
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

				if (event.type === "agent_settled") {
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
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				activeSubagents.delete(child);
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
				agent: agent.name, cwd: cwd ?? defaultCwd, contract, model, thinking,
				startedAt: currentResult.startedAt, finishedAt: currentResult.finishedAt,
				exitCode: currentResult.exitCode, stopReason: currentResult.stopReason,
				validationError: currentResult.validationError, snapshot: currentResult.snapshot,
				usage: currentResult.usage, output,
				reviewedFiles: agent.name === "code-review-agent" && !currentResult.validationError ? reviewedFileDigests(output, cwd ?? defaultCwd) : undefined,
				reviewSnapshot: agent.name === "code-review-agent" && !currentResult.validationError ? reviewSnapshot(cwd ?? defaultCwd) : undefined,
			}, null, 2), { mode: 0o600 });
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
	workType: Type.Optional(StringEnum(["small", "normal", "large", "wave", "documentation"] as const)),
	documentRequired: Type.Optional(Type.Boolean()),
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
	// Global run timer: live mm:ss widget while the agent works on the
	// current prompt (agent_start → agent_end).
	pi.on("agent_start", async (_event, ctx) => {
		clearWave();
		startRunTimer(ctx.ui);
	});
	pi.on("agent_end", async () => {
		stopRunTimer();
		freezeWave();
	});
	pi.on("session_shutdown", async () => {
		stopRunTimer();
		clearWave();
		try {
			runTimerUI?.setWidget(RUN_TIMER_WIDGET, undefined);
		} catch {
			/* ignore */
		}
		runTimerUI = undefined;
	});

	// Forward an interactive steering message into every running subagent
	// immediately. Pi delivers a steer only after the current tool call
	// finishes; the `subagent` tool is one long call, so without this the steer
	// would wait for the whole nested run. A steer that arrives over RPC from a
	// parent is left to normal queueing here, so it reaches this session's agent.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (event.streamingBehavior !== "steer") return { action: "continue" };
		const targets = [...activeSubagents];
		if (targets.length === 0) return { action: "continue" };
		let forwarded = 0;
		for (const target of targets) {
			if (writeRpcCommand(target, { type: "steer", message: event.text, images: event.images }))
				forwarded++;
		}
		if (forwarded === 0) return { action: "continue" };
		// Handled steers are not queued locally, so confirm they were delivered.
		if (ctx.hasUI) ctx.ui.notify(`Steering ${forwarded} running subagent${forwarded > 1 ? "s" : ""}…`, "info");
		return { action: "handled" };
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
					publishWave(makeDetails("parallel")([...allResults]), ctx);
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
						publishWave(partial.details, ctx);
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
			// re-render the component once per second so "⏳ running mm:ss"
			// stays current even when no new messages are arriving.
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
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						const nestedLabel =
							item.name === "subagent" && runMap ? nestedRunLabel(runMap.get(item.id)) : null;
						const base = `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme), nestedLabel)}`;
						text += `${base}\n`;
					}
				}
				return text.trimEnd();
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
						out += `${base}\n`;
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
						out += `${base}\n`;
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
							container.addChild(new Spacer(1));
							container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
							const activity = renderActivityTree(r);
							if (activity) container.addChild(new Text(activity, 0, 0));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
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
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT, getNestedRunMap(r))}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
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

						const stepUsage = formatUsageStats(r.usage, r.model);
						const meta = [timing?.label, stepUsage].filter(Boolean).join(" · ");
						if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
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
				const usageStr = formatUsageStats(aggregateUsage(details.results));
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
					? theme.fg("warning", "⏳")
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

						const taskUsage = formatUsageStats(r.usage, r.model);
						const meta = [timing?.label, taskUsage].filter(Boolean).join(" · ");
						if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
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
							? theme.fg("warning", "⏳")
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
					const usageStr = formatUsageStats(aggregateUsage(details.results));
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
