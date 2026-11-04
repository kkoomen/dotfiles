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
	findWaveDispatch,
	formatWaveWidget,
	isWaveDispatch,
	publishWave,
	settleWave,
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
