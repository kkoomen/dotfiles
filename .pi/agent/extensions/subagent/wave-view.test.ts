/**
 * Live wave table: terminal rows and widget lifecycle.
 *
 * Inert to Pi's loader, which only loads `.pi/agent/extensions/{*\/index.ts,*.ts}`, so this
 * file is never executed as an extension. It drives the display helpers directly to prove the
 * table stops claiming to be live once the dispatch it draws has ended.
 *
 * How to run it (this repo has no package.json or node_modules, and index.ts imports
 * @earendil-works/*, so bun needs a module resolution root; bun does not honor NODE_PATH):
 *
 *   cd <repo root>
 *   ln -sfn /Users/koomen/.bun/install/global/node_modules node_modules
 *   bun test ./.pi/agent/extensions/subagent/wave-view.test.ts
 *   rm -f node_modules
 *
 * Without that symlink the suite fails with `Cannot find module '@earendil-works/pi-ai'`. The
 * link is test scaffolding only: create it for the run and remove it again before any commit.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearWave,
	findWaveDispatch,
	formatWaveWidget,
	isWaveDispatch,
	publishWave,
	settleWave,
	startRunTimer,
	stopRunTimer,
	tickRunTimer,
	waveViewFrom,
	type SingleResult,
	type SubagentDetails,
} from "./index.ts";

const T0 = 1_700_000_000_000;
const TICK = 1_000;

function usage(cost = 0) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 0 };
}

/** One worker result; every field the table reads is explicit. */
function worker(overrides: Partial<SingleResult>): SingleResult {
	return {
		agent: "item-runner-agent",
		agentSource: "user",
		task: "work the item",
		workType: "wave",
		itemId: "item/01-a",
		waveId: "wave-1",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: usage(),
		startedAt: T0,
		nestedSubagents: [],
		...overrides,
	};
}

function parallel(results: SingleResult[]): SubagentDetails {
	return { mode: "parallel", agentScope: "user", projectAgentsDir: null, results };
}

/** The dispatcher's own view: one orchestrator run whose nested parallel call is the wave. */
function dispatcher(nested: { details?: SubagentDetails; liveDetails?: SubagentDetails }): SubagentDetails {
	return {
		mode: "single",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			worker({
				agent: "orchestrator-agent",
				workType: "normal",
				itemId: undefined,
				nestedSubagents: [
					{
						toolCallId: "call-nested",
						agent: "subagent parallel (2)",
						task: "",
						startedAt: T0,
						...nested,
					},
				],
			}),
		],
	};
}

const theme = { fg: (_color: string, text: string) => text } as any;

const liveWave = parallel([worker({ itemId: "item/01-a" }), worker({ itemId: "item/02-b" })]);
/** A clean end: both workers reported a result. */
const finalWave = parallel([
	worker({ itemId: "item/01-a", exitCode: 0, finishedAt: T0 + 5 * TICK }),
	worker({ itemId: "item/02-b", exitCode: 0, finishedAt: T0 + 6 * TICK }),
]);
/** A dropped end: the second worker never reported. */
const droppedWave = parallel([
	worker({ itemId: "item/01-a", exitCode: 0, finishedAt: T0 + 5 * TICK }),
	worker({ itemId: "item/02-b" }),
]);

test("findWaveDispatch prefers the final details over a stale liveDetails", () => {
	expect(isWaveDispatch(liveWave)).toBe(true);
	expect(findWaveDispatch(dispatcher({ details: finalWave, liveDetails: liveWave }))).toBe(finalWave);
	// With no terminal payload yet, the streamed snapshot is still the only truth available.
	expect(findWaveDispatch(dispatcher({ liveDetails: liveWave }))).toBe(liveWave);
});

test("a live view keeps unfinished rows running", () => {
	const view = waveViewFrom(liveWave, T0 + 42 * TICK);
	expect(view).toBeDefined();
	expect(view!.active).toBe(true);
	expect(view!.rows.map((row) => row.state)).toEqual(["running", "running"]);
});

test("an ended view is terminal, with elapsed frozen at detection time", () => {
	const endedAt = T0 + 30 * TICK;
	const view = waveViewFrom(droppedWave, endedAt + 90 * TICK, endedAt)!;
	expect(view.active).toBe(false);
	expect(view.rows.some((row) => row.state === "running")).toBe(false);

	const interrupted = view.rows.find((row) => row.itemId === "item/02-b")!;
	expect(interrupted.state).toBe("interrupted");
	expect(interrupted.elapsedMs).toBe(30 * TICK);

	const finished = view.rows.find((row) => row.itemId === "item/01-a")!;
	expect(finished.state).toBe("done");
	expect(finished.elapsedMs).toBe(5 * TICK);

	// Two different `now` values give the same elapsed times: the clock stopped.
	const later = waveViewFrom(droppedWave, endedAt + 600 * TICK, endedAt)!;
	expect(later.rows.map((row) => row.elapsedMs)).toEqual(view.rows.map((row) => row.elapsedMs));
});

test("the ended widget says interrupted, shows no running glyph, and keeps every item id", () => {
	const endedAt = T0 + 30 * TICK;
	const text = formatWaveWidget(waveViewFrom(droppedWave, endedAt, endedAt)!, undefined, 100, theme, endedAt).join("\n");
	expect(text).toContain("interrupted");
	expect(text).not.toContain("▶");
	expect(text).toContain("item/01-a");
	expect(text).toContain("item/02-b");
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wave-view-test-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** One UI context: stable for the life of a Pi session (the runner keeps exactly one). */
function makeUI(rendered: (string[] | undefined)[]) {
	return {
		theme,
		setWidget: (_key: string, lines?: string[]) => {
			rendered.push(lines);
		},
	};
}

/**
 * One `ExtensionContext`, built fresh per call the way Pi builds one per emission. Two contexts
 * from this factory are the same session but distinct objects, so a test can only settle the
 * table if the code compares the stable `ui` handle instead of the wrapper.
 */
function makeCtx(ui: ReturnType<typeof makeUI>) {
	return { hasUI: true, cwd: tmpRoot, ui } as any;
}

test("a dropped dispatch settles across two distinct contexts", async () => {
	const rendered: (string[] | undefined)[] = [];
	const ui = makeUI(rendered);
	const publishCtx = makeCtx(ui);
	// Pi emits with a context it just built: same session (`ui`), different wrapper object.
	const settleCtx = makeCtx(ui);
	expect(settleCtx).not.toBe(publishCtx);
	expect(settleCtx.ui).toBe(publishCtx.ui);

	publishWave(liveWave, publishCtx, "call-drop");
	expect(String(rendered.at(-1)!.join("\n"))).toContain("▶");

	// No terminal toolResult: settlement alone must turn the live rows terminal.
	settleWave(settleCtx, "call-drop");
	const text = String(rendered.at(-1)!.join("\n"));
	expect(text).not.toContain("▶");
	expect(text).toContain("interrupted");
	expect(text).toContain("item/01-a");
	expect(text).toContain("item/02-b");

	// Settlement really happened: the 1 Hz interval is gone, so the frame count stops growing.
	const frames = rendered.length;
	await Bun.sleep(1_300);
	expect(rendered.length).toBe(frames);
});

test("settleWave freezes the owning call only, and writes no wave state", () => {
	const rendered: (string[] | undefined)[] = [];
	const ui = makeUI(rendered);
	const publishCtx = makeCtx(ui);
	const settleCtx = makeCtx(ui);
	expect(settleCtx).not.toBe(publishCtx);

	publishWave(liveWave, publishCtx, "call-1");
	expect(String(rendered.at(-1)!.join("\n"))).toContain("▶");

	// A foreign tool-call id must not settle the table that call-1 owns.
	settleWave(settleCtx, "call-other", finalWave);
	expect(String(rendered.at(-1)!.join("\n"))).toContain("▶");

	settleWave(settleCtx, "call-1", finalWave);
	const settled = String(rendered.at(-1)!.join("\n"));
	expect(settled).not.toContain("▶");
	expect(settled).toContain("✓");

	expect(fs.existsSync(path.join(tmpRoot, ".pi", "state", "wave-1.json"))).toBe(false);

	// A different session's context must not settle this table either.
	const foreignCtx = makeCtx(makeUI(rendered));
	publishWave(liveWave, publishCtx, "call-2");
	settleWave(foreignCtx, "call-2");
	expect(String(rendered.at(-1)!.join("\n"))).toContain("▶");

	// Clean up the interval this test started, through the context that owns it.
	settleWave(settleCtx, "call-2");
	expect(String(rendered.at(-1)!.join("\n"))).not.toContain("▶");
});

/**
 * A UI stub that copies Pi's widget bookkeeping instead of just recording writes.
 *
 * `setExtensionWidget` disposes and removes the key from both placement maps and then
 * re-inserts it at the end of the target map
 * (dist/modes/interactive/interactive-mode.js:1938-1962), and the container is built by
 * appending `map.values()` in insertion order. So the map order below is the on-screen order:
 * key 0 renders highest, the last key renders lowest, directly above the editor.
 *
 * It also copies the line cap: the container takes only the first `PI_MAX_WIDGET_LINES` entries
 * and appends a muted notice when the write was longer (:1958-1961, `MAX_WIDGET_LINES = 10`
 * at :2014). A stub without that cap cannot see a strip being sliced off, which is exactly how
 * a timer at the end of the array can disappear from a real terminal.
 */
const PI_MAX_WIDGET_LINES = 10;
const WIDGET_TRUNCATION_NOTICE = "... (widget truncated)";

function makePiUI() {
	const aboveEditor = new Map<string, string[] | undefined>();
	const ui = {
		theme,
		/** Top-to-bottom rows of the above-editor area, as Pi would paint them. */
		render(): string[] {
			return [...aboveEditor.values()].flatMap((lines) => lines ?? []);
		},
		/** Live keys, highest first. */
		keys(): string[] {
			return [...aboveEditor.keys()];
		},
		setWidget(key: string, content?: string[], options?: { placement?: string }) {
			expect(options?.placement ?? "aboveEditor").toBe("aboveEditor");
			// removeExisting(): dispose the old component, delete the key, then re-insert.
			aboveEditor.delete(key);
			if (content === undefined) return;
			// The container renders the first MAX_WIDGET_LINES entries, then the notice.
			const rows = content.slice(0, PI_MAX_WIDGET_LINES);
			if (content.length > PI_MAX_WIDGET_LINES) rows.push(WIDGET_TRUNCATION_NOTICE);
			aboveEditor.set(key, rows);
		},
	};
	return ui;
}

/** Wave rows must be the leading rows and the timer the last row. */
function expectWaveAboveTimer(ui: ReturnType<typeof makePiUI>) {
	const rows = ui.render();
	const timerRow = rows.findIndex((row) => /^[\u23f3\u23f1]/.test(row));
	const waveRow = rows.findIndex((row) => row.includes("item/01-a"));
	expect(waveRow).toBeGreaterThanOrEqual(0);
	expect(timerRow).toBeGreaterThan(waveRow);
	// Nothing renders below the timer: it is the strip closest to the editor.
	expect(timerRow).toBe(rows.length - 1);
}

test("two widget keys under one placement flip on the last write (the pre-fix defect)", () => {
	const ui = makePiUI();
	ui.setWidget("run-timer", ["\u23f3 0:01"]);
	ui.setWidget("wave-workers", ["WAVE"]);
	// The wave table is written last, so it lands closest to the editor: the reported bug.
	expect(ui.render()).toEqual(["\u23f3 0:01", "WAVE"]);
	ui.setWidget("run-timer", ["\u23f3 0:02"]);
	expect(ui.render()).toEqual(["WAVE", "\u23f3 0:02"]);
});

test("the wave table renders above the run timer for every tick interleaving", () => {
	const ui = makePiUI();
	const ctx = makeCtx(ui as any);

	// Module state outlives a test, so start from no table and no timer.
	clearWave();
	startRunTimer(ui as any);
	expect(ui.keys()).toEqual(["run-status"]);
	expect(ui.render()).toEqual([expect.stringMatching(/^\u23f3 /)]);

	// wave tick, then timer tick.
	publishWave(liveWave, ctx, "call-order");
	expectWaveAboveTimer(ui);
	tickRunTimer();
	expectWaveAboveTimer(ui);

	// timer tick, then wave tick.
	tickRunTimer();
	expectWaveAboveTimer(ui);
	publishWave(liveWave, ctx, "call-order");
	expectWaveAboveTimer(ui);

	// Repeated alternation in both directions: neither order can win a slot.
	for (let i = 0; i < 5; i += 1) {
		tickRunTimer();
		publishWave(liveWave, ctx, "call-order");
		expectWaveAboveTimer(ui);
		publishWave(liveWave, ctx, "call-order");
		tickRunTimer();
		expectWaveAboveTimer(ui);
	}

	// The timer's stop path writes the final "⏱" value after a wave render.
	stopRunTimer();
	expect(ui.render().at(-1)).toMatch(/^\u23f1 /);
	expectWaveAboveTimer(ui);

	// A frozen/settled table keeps its slot above that final timer value.
	settleWave(ctx, "call-order", finalWave);
	expectWaveAboveTimer(ui);
	expect(ui.render().at(-1)).toMatch(/^\u23f1 /);

	// Still valid once the frozen rows stop ticking.
	tickRunTimer();
	expectWaveAboveTimer(ui);
	stopRunTimer();
	expectWaveAboveTimer(ui);
});

/** A full round: eight workers, the most one parallel dispatch runs at once. */
const fullWave = parallel(
	Array.from({ length: 8 }, (_, i) => worker({ itemId: `item/0${i + 1}-${String.fromCharCode(97 + i)}` })),
);

test("a full 8-worker table plus a running timer keeps the timer as the last rendered row", () => {
	const ui = makePiUI();
	const ctx = makeCtx(ui as any);

	// Module state outlives a test, so start from a known state.
	clearWave();
	startRunTimer(ui as any);

	// This table alone is longer than Pi's cap (3 header lines + 8 rows + border = 12), so an
	// uncapped wave portion pushes the timer past the slice and it vanishes for the whole round.
	publishWave(fullWave, ctx, "call-full");
	const rows = ui.render();
	// The timer is the row that must survive: it is the strip closest to the editor.
	expect(rows.at(-1)).toMatch(/^\u23f3 /);
	expect(rows).not.toContain(WIDGET_TRUNCATION_NOTICE);
	expect(rows).toHaveLength(PI_MAX_WIDGET_LINES);
	// The budget the timer does not need is still spent on the table's rows: 10 lines minus the
	// 3 header lines and the 1 timer line leaves 6 of the 8 worker rows.
	expect(rows.filter((row) => row.includes("item/"))).toHaveLength(PI_MAX_WIDGET_LINES - 4);
	expectWaveAboveTimer(ui);

	// Every 1 Hz refresh of either widget keeps the same shape, in both orders.
	for (let i = 0; i < 3; i += 1) {
		tickRunTimer();
		expectWaveAboveTimer(ui);
		expect(ui.render()).toHaveLength(PI_MAX_WIDGET_LINES);
		publishWave(fullWave, ctx, "call-full");
		expectWaveAboveTimer(ui);
		expect(ui.render().at(-1)).toMatch(/^\u23f3 /);
	}

	// The stop path's final "\u23f1" line is the last rendered row too.
	stopRunTimer();
	expect(ui.render().at(-1)).toMatch(/^\u23f1 /);
	expectWaveAboveTimer(ui);

	clearWave();
});
