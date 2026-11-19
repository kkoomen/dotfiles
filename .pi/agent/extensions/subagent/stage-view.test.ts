/**
 * Collapsed view of a delegating run: stage lines plus the actions under them.
 *
 * Inert to Pi's loader, which only loads `.pi/agent/extensions/{*\/index.ts,*.ts}`, so this
 * file is never executed as an extension. It drives the display helpers directly to prove a
 * run that dispatches agents shows those stages (and what each one did) instead of its own
 * plumbing, and that a run that works directly keeps its ordinary trace.
 *
 * How to run it (this repo has no package.json or node_modules, and index.ts imports
 * @earendil-works/*, so bun needs a module resolution root; bun does not honor NODE_PATH):
 *
 *   cd <repo root>
 *   ln -sfn /Users/koomen/.bun/install/global/node_modules node_modules
 *   bun test ./.pi/agent/extensions/subagent/stage-view.test.ts
 *   rm -f node_modules
 *
 * Without that symlink the suite fails with `Cannot find module '@earendil-works/pi-ai'`.
 * The link is test scaffolding only: create it for the run, remove it again afterwards.
 * Bun resolves the importing file's real path, so when `extensions/subagent` is itself a
 * symlink the link has to sit beside its target (`.pi/agent/node_modules`), not beside the
 * directory the symlink was created in.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import os from "node:os";
import {
	exitCodeOf,
	checksOfHandoff,
	checkActionLines,
	commandActionLines,
	summaryOfHandoff,
	stageHasSummary,
	isFailedResult,
	isCommandStage,
	formatStageAction,
	oneLine,
	getDisplayItems,
	isDelegatingRun,
	stageActionLines,
	ownTraceLimit,
	formatStageCost,
	stageCostLabel,
	readTarget,
	shortenPath,
	stripCdPrefix,
	stageCost,
	dispatchedCost,
	resultCost,
	stageItems,
	nestedStageLines,
	AGENT_STARTING_TEXT,
	STAGE_STARTING_TEXT,
	collapsedStageBody,
	stageShowsActions,
	stageSpinnerFrame,
	stageStatus,
	type SubagentDetails,
	type StageTiming,
} from "./index.ts";

/** Identity "theme": the helpers must not depend on a real theme to be checkable. */
const plain = (_color: string, text: string) => text;

const home = os.homedir();

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall" as const,
	id,
	name,
	args,
});

/** Minimal result shape the stage helpers read: just the transcript. */
const result = (messages: any[]) => ({ messages }) as any;

const details = (messages: any[]): SubagentDetails =>
	({ mode: "single", agentScope: "user", projectAgentsDir: null, results: [result(messages)] }) as SubagentDetails;

/** An assistant message carrying one tool call, in the transcript's shape. */
const assistantCall = (id: string, name: string, args: Record<string, unknown>) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
});

describe("formatStageAction", () => {
	test("file operations read as verbs", () => {
		expect(formatStageAction("edit", { file_path: "file2.md" }, plain)).toBe("Edited file2.md");
		expect(formatStageAction("write", { file_path: "file2.md" }, plain)).toBe("Created file2.md");
		expect(formatStageAction("read", { file_path: "file2.md" }, plain)).toBe("Read file2.md");
	});

	test("a command carries its exit code", () => {
		expect(formatStageAction("bash", { command: "npm run format" }, plain, 1)).toBe("$ npm run format (exit code 1)");
		expect(formatStageAction("bash", { command: "npm run format" }, plain, 0)).toBe("$ npm run format (exit code 0)");
		// Unknown (still running, aborted, timed out): no claim either way.
		expect(formatStageAction("bash", { command: "npm run format" }, plain, null)).toBe("$ npm run format");
		// A file operation has no exit code to report.
		expect(formatStageAction("edit", { file_path: "file2.md" }, plain, 0)).toBe("Edited file2.md");
	});

	test("a bare rm reads as the removal it performs", () => {
		expect(formatStageAction("bash", { command: "rm -f file2.md" }, plain)).toBe("Removed file2.md");
		// Anything with shell structure stays a command.
		expect(formatStageAction("bash", { command: "rm -rf out && echo ok" }, plain)).toBe("$ rm -rf out && echo ok");
	});

	test("shell commands keep the $ form and are length-capped", () => {
		expect(formatStageAction("bash", { command: "npm run format" }, plain)).toBe("$ npm run format");
		const long = formatStageAction("bash", { command: "x".repeat(120) }, plain);
		expect(long.endsWith("...")).toBe(true);
		expect(long.length).toBeLessThan(70);
	});

	test("the home directory is shortened, never a full path", () => {
		expect(formatStageAction("edit", { file_path: `${home}/proj/a.md` }, plain)).toBe("Edited ~/proj/a.md");
	});
});

describe("isDelegatingRun", () => {
	test("true when the run dispatched an agent", () => {
		expect(isDelegatingRun([toolCall("1", "bash", { command: "ls" }), toolCall("2", "subagent", { agent: "x", task: "y" })])).toBe(true);
	});

	test("false for a run that only works", () => {
		expect(isDelegatingRun([toolCall("1", "bash", { command: "ls" }), toolCall("2", "edit", { file_path: "a.md" })])).toBe(false);
	});
});

describe("stageItems", () => {
	test("keeps only stage dispatches, newest last", () => {
		const items = [
			toolCall("1", "subagent", { agent: "a", task: "t" }),
			toolCall("2", "bash", { command: "ls" }),
			toolCall("3", "subagent", { agent: "b", task: "t" }),
		];
		const { items: shown, skipped } = stageItems(items, 10);
		expect(shown.map((i) => i.id)).toEqual(["1", "3"]);
		expect(skipped).toBe(0);
	});

	test("windows the list and reports what it hid", () => {
		const items = Array.from({ length: 4 }, (_, i) => toolCall(String(i), "subagent", { agent: `a${i}`, task: "t" }));
		const { items: shown, skipped } = stageItems(items, 2);
		expect(shown.map((i) => i.id)).toEqual(["2", "3"]);
		expect(skipped).toBe(2);
	});
});

describe("stageActionLines", () => {
	test("one line per tool call of the stage's agent", () => {
		const run = {
			details: details([
				assistantCall("1", "edit", { file_path: "file2.md" }),
				assistantCall("2", "edit", { file_path: "file2.md" }),
				assistantCall("3", "write", { file_path: "file2.md" }),
				assistantCall("4", "bash", { command: "rm file2.md" }),
			]),
		};
		expect(stageActionLines(run, plain)).toEqual([
			"Edited file2.md",
			"Edited file2.md",
			"Created file2.md",
			"Removed file2.md",
		]);
	});

	test("a stage that did nothing yet contributes no lines", () => {
		expect(stageActionLines(undefined, plain)).toEqual([]);
		expect(stageActionLines({ details: details([]) }, plain)).toEqual([]);
	});

	test("falls back to the live details while the stage runs", () => {
		const run = { liveDetails: details([assistantCall("1", "bash", { command: "npm run format" })]) };
		expect(stageActionLines(run, plain)).toEqual(["$ npm run format"]);
	});

	test("long stages keep their tail and say how many it hid", () => {
		const calls = Array.from({ length: 5 }, (_, i) => assistantCall(String(i), "bash", { command: `cmd${i}` }));
		const lines = stageActionLines({ details: details(calls) }, plain, 2);
		expect(lines).toEqual(["... 3 earlier", "$ cmd3", "$ cmd4"]);
	});
});

describe("ownTraceLimit", () => {
	test("a coordinator's own trace uses the stage action window", () => {
		expect(ownTraceLimit("orchestrator-agent")).toBe(4);
	});

	test("a diagnostician's own trace uses the same window instead of everything", () => {
		expect(ownTraceLimit("diagnose-agent")).toBe(4);
	});

	test("any other directly dispatched agent keeps its ordinary trace", () => {
		// 10 is COLLAPSED_ITEM_COUNT, module-private by design.
		expect(ownTraceLimit("build-agent")).toBe(10);
	});

	test("the agent name must match exactly, so a near miss keeps the full trace", () => {
		expect(ownTraceLimit("orchestrator")).toBe(10);
	});
});

describe("stageStatus", () => {
	const T = 1_700_000_000_000;
	const done: StageTiming = { label: "⏱ 1:50", running: false, time: "1:50" };
	const running: StageTiming = { label: `${stageSpinnerFrame(T)} 2:32`, running: true, time: "2:32" };

	test("a finished stage shows a check and its time, never the hourglass", () => {
		expect(stageStatus(done, false, T, plain)).toBe("✓ 1:50");
	});

	test("a running stage shows a braille frame and its time", () => {
		const marker = stageStatus(running, false, T, plain);
		expect(marker).toBe(`${stageSpinnerFrame(T)} 2:32`);
	});

	test("a failed stage shows a cross, keeping its time", () => {
		expect(stageStatus(done, true, T, plain)).toBe("✗ 1:50");
	});

	test("a stage that never started has no marker", () => {
		expect(stageStatus(null, false, T, plain)).toBe("");
	});
});

describe("stageSpinnerFrame", () => {
	const frames = ["⠸", "⠹", "⠙", "⠋", "⠏", "⠇", "⠧", "⠦", "⠴", "⠼"];

	test("starts at the frame the sequence was chosen for", () => {
		expect(stageSpinnerFrame(0)).toBe("⠸");
	});

	test("advances one frame per second and wraps", () => {
		const walked = Array.from({ length: 11 }, (_, i) => stageSpinnerFrame(i * 1000));
		expect(walked).toEqual([...frames, frames[0]!]);
	});

	test("holds one frame for a whole second, so a repaint at 1 Hz animates it", () => {
		expect(stageSpinnerFrame(3_100)).toBe(stageSpinnerFrame(3_900));
		expect(stageSpinnerFrame(3_900)).not.toBe(stageSpinnerFrame(4_000));
	});
});

describe("exitCodeOf", () => {
	const text = (value: string) => ({ content: [{ type: "text", text: value }] });

	test("reads the appended status line of a failed command", () => {
		expect(exitCodeOf({ ...text("boom\n\nCommand exited with code 1"), isError: true })).toBe(1);
		expect(exitCodeOf({ ...text("Command exited with code 127\n"), isError: true })).toBe(127);
	});

	test("a successful command exits 0", () => {
		expect(exitCodeOf({ ...text("all good"), isError: false })).toBe(0);
	});

	test("the phrase inside the command's own output does not win over the real status", () => {
		const message = { ...text("Command exited with code 3\n\nCommand exited with code 1"), isError: true };
		expect(exitCodeOf(message)).toBe(1);
	});

	test("a timeout or abort reports no exit code", () => {
		expect(exitCodeOf({ ...text("Command timed out after 30 seconds"), isError: true })).toBeNull();
		expect(exitCodeOf(undefined)).toBeNull();
	});
});

describe("stageActionLines exit codes", () => {
	const bashCall = (id: string, command: string) => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
	});
	const bashResult = (id: string, code: number) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		isError: code !== 0,
		content: [{ type: "text", text: code === 0 ? "ok" : `boom\n\nCommand exited with code ${code}` }],
	});

	test("pairs each command with its own result, in order", () => {
		const run = {
			details: details([
				bashCall("1", "npm run format"),
				bashResult("1", 1),
				bashCall("2", "npm run format:fix"),
				bashResult("2", 0),
			]),
		};
		expect(stageActionLines(run, plain)).toEqual([
			"$ npm run format (exit code 1)",
			"$ npm run format:fix (exit code 0)",
		]);
	});

	test("a retry loop reads newest last, windows to the last four", () => {
		const messages: any[] = [];
		[1, 1, 1, 0].forEach((code, index) => {
			messages.push(bashCall(String(index), "npm run format"));
			messages.push(bashResult(String(index), code));
		});
		const run = { details: details(messages) };
		expect(stageActionLines(run, plain)).toEqual([
			"$ npm run format (exit code 1)",
			"$ npm run format (exit code 1)",
			"$ npm run format (exit code 1)",
			"$ npm run format (exit code 0)",
		]);

		// Six runs: the two oldest drop, the newest stays at the bottom.
		const longer: any[] = [];
		[1, 1, 1, 1, 1, 0].forEach((code, index) => {
			longer.push(bashCall(String(index), `attempt${index}`));
			longer.push(bashResult(String(index), code));
		});
		expect(stageActionLines({ details: details(longer) }, plain)).toEqual([
			"... 2 earlier",
			"$ attempt2 (exit code 1)",
			"$ attempt3 (exit code 1)",
			"$ attempt4 (exit code 1)",
			"$ attempt5 (exit code 0)",
		]);
	});

	test("a command with no result yet shows no exit code", () => {
		const run = { details: details([bashCall("1", "bun test")]) };
		expect(stageActionLines(run, plain)).toEqual(["$ bun test"]);
	});
});

describe("no hourglass anywhere in the view code", () => {
	test("the extension never paints ⏳ — a running agent reads as a braille frame", () => {
		const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		const hourglass = source.split("\n").filter((line) => line.includes("\u23f3"));
		expect(hourglass).toEqual([]);
	});
});

describe("stageShowsActions", () => {
	const T = 1_700_000_000_000;

	test("a running stage shows its live action tail", () => {
		expect(stageShowsActions({ label: `${stageSpinnerFrame(T)} 2:32`, running: true, time: "2:32" })).toBe(true);
	});

	test("a finished stage shows only its marker, time and name", () => {
		expect(stageShowsActions({ label: "⏱ 2:03", running: false, time: "2:03" })).toBe(false);
	});

	test("a failed stage is finished too, so it shows no action tail", () => {
		const failed: StageTiming = { label: "⏱ 0:00", running: false, time: "0:00" };
		expect(stageShowsActions(failed)).toBe(false);
	});

	test("a finished stage whose handoff summary is its answer keeps its rows", () => {
		// plan-lint reports FAIL at exit 0 with no checks; collapsing its summary would
		// leave a bare stage line with no reason under it.
		const failed: StageTiming = { label: "⏱ 0:00", running: false, time: "0:00" };
		expect(stageShowsActions(failed, "collapsed", true)).toBe(true);
		// The summary flag is the command stage's, not a general escape from collapsing.
		expect(stageShowsActions(failed, "collapsed", false)).toBe(false);
	});

	test("a stage with no timing yet has nothing to show", () => {
		expect(stageShowsActions(null)).toBe(true);
	});

	test("opening the cell shows every stage's actions, finished ones included", () => {
		expect(stageShowsActions({ label: "⏱ 2:03", running: false, time: "2:03" }, "expanded")).toBe(true);
	});
});

describe("stageCost", () => {
	const withUsage = (...costs: number[]) => ({
		details: {
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: costs.map((cost) => ({ messages: [], usage: { cost } })),
		},
	});

	test("sums every result of the stage", () => {
		expect(stageCost(withUsage(0.25, 0.5) as any)).toBe(0.75);
	});

	test("a stage with no reported usage has no cost to show", () => {
		expect(stageCost(undefined)).toBeNull();
		expect(stageCost({ details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] } } as any)).toBeNull();
	});

	test("a free stage reports 0, not null", () => {
		expect(stageCost(withUsage(0) as any)).toBe(0);
	});
});

describe("formatStageCost", () => {
	test("keeps four decimals for a cheap stage, trims trailing zeros", () => {
		expect(formatStageCost(0.0265)).toBe("$0.0265");
		expect(formatStageCost(0.03)).toBe("$0.03");
		expect(formatStageCost(0)).toBe("$0");
	});

	test("a whole-dollar stage does not read as $1.2300", () => {
		expect(formatStageCost(1.23)).toBe("$1.23");
		expect(formatStageCost(2.12)).toBe("$2.12");
		expect(formatStageCost(10)).toBe("$10");
	});
});

describe("stripCdPrefix", () => {
	test("drops the directory the agent already works in", () => {
		expect(stripCdPrefix("cd /x/y && grep -rn foo src")).toBe("grep -rn foo src");
		expect(stripCdPrefix("cd /x/y; ls")).toBe("ls");
		expect(stripCdPrefix('cd "/x y" && ls')).toBe("ls");
		expect(stripCdPrefix("cd /a && cd /b && bun test")).toBe("bun test");
	});

	test("leaves a plain command alone", () => {
		expect(stripCdPrefix("bun test")).toBe("bun test");
	});

	test("a newline separates statements, so the command after it survives", () => {
		expect(stripCdPrefix("cd /x\nls -l")).toBe("ls -l");
		expect(stripCdPrefix("cd /x\n")).toBe("");
	});

	test("a command that only changes directory strips to nothing", () => {
		expect(stripCdPrefix("cd /x")).toBe("");
		expect(stripCdPrefix("cd")).toBe("");
		expect(stripCdPrefix("cd -")).toBe("");
		expect(stripCdPrefix("cd /a && cd /b")).toBe("");
		expect(stripCdPrefix("cd /a; cd /b;")).toBe("");
	});
});

describe("shortenPath", () => {
	const base = "/Users/koomen/tech/app";

	test("is relative to the directory the run works in", () => {
		expect(shortenPath(`${base}/src/app.ts`, base)).toBe("src/app.ts");
		expect(shortenPath(base, base)).toBe(".");
	});

	test("falls back to ~ and then to the path itself", () => {
		expect(shortenPath(`${home}/elsewhere/a.md`, base)).toBe("~/elsewhere/a.md");
		expect(shortenPath("/opt/tool", base)).toBe("/opt/tool");
	});
});

describe("readTarget", () => {
	test("names the range that was read", () => {
		expect(readTarget({ file_path: "a/b.js", offset: 85, limit: 120 })).toBe("a/b.js:85-204");
		expect(readTarget({ file_path: "a/b.js", offset: 85 })).toBe("a/b.js:85");
		expect(readTarget({ file_path: "a/b.js" })).toBe("a/b.js");
	});
});

describe("getDisplayItems", () => {
	const message = (...parts: any[]) => ({ role: "assistant", content: parts });
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

	test("drops a cd-only call but keeps the real command that followed", () => {
		const items = getDisplayItems([
			message(call("1", "bash", { command: "cd /repo" })),
			message(call("2", "bash", { command: "cd /repo/src && bun test" })),
			message(call("3", "read", { file_path: "a.ts" })),
		]);
		expect(items.map((item: any) => item.id)).toEqual(["2", "3"]);
		expect(formatStageAction("bash", (items[0] as any).args, plain, 0)).toBe("$ bun test (exit code 0)");
	});

	test("a transcript of only cd calls renders as no items at all", () => {
		expect(getDisplayItems([message(call("1", "bash", { command: "cd /repo" }))])).toEqual([]);
	});
});

describe("a cell before its agent has reported anything", () => {
	test("a single agent that has said nothing yet says what it is preparing", () => {
		expect(AGENT_STARTING_TEXT).toBe("Preparing the agent — loading its instructions and the workspace…");
	});

	test("a stage with no messages yet says it is starting, not that it has no output", () => {
		expect(collapsedStageBody("", "", true)).toBe("Preparing the stage — agent starting, no actions reported yet…");
		// One ellipsis character, never three dots: it is one phrase, not a truncated line.
		expect(STAGE_STARTING_TEXT.includes("...")).toBe(false);
	});

	test("a finished stage with no output still reads as no output", () => {
		expect(collapsedStageBody("", "", false)).toBe("(no output)");
	});

	test("a command stage shows its command lines, never the placeholder", () => {
		const lines = "$ npm run typecheck (exit code 0)";
		expect(collapsedStageBody(lines, "", true)).toBe(lines);
		expect(collapsedStageBody(lines, "", false)).toBe(lines);
	});

	test("a transcript wins over the placeholder but not over commands", () => {
		expect(collapsedStageBody("", "Edited a.ts", true)).toBe("Edited a.ts");
		expect(collapsedStageBody("$ cmd", "Edited a.ts", true)).toBe("$ cmd");
	});

	test("no cell still paints the bare (running...) placeholder", () => {
		const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		expect(source.includes("(running...)")).toBe(false);
		// A streamed cell is still wired to the per-agent fallback, never to a bare placeholder.
		expect(source.includes("getFinalOutput(currentResult.messages) || streamingFallback()")).toBe(true);
		// Both collapsed per-stage views (chain and parallel) decide through the one helper.
		expect(source.split("collapsedStageBody(").length - 1).toBe(3);
	});
});

describe("nested stage lines", () => {
	/** A nested dispatch: one stage of a coordinator, live or finished. */
	const run = (over: Record<string, unknown> = {}) => ({
		toolCallId: "r1",
		agent: "build-agent",
		task: "do the thing",
		startedAt: 1000,
		...over,
	});
	/** A transcript of `count` distinct bash calls, so each row is identifiable. */
	const commands = (count: number) =>
		details(Array.from({ length: count }, (_, i) => assistantCall(`c${i + 1}`, "bash", { command: `echo ${i + 1}` })));

	test("a run that dispatched nothing has no stage rows at all", () => {
		expect(nestedStageLines([], plain, 0)).toEqual([]);
	});

	test("a stage with no actions yet is one header row naming the agent", () => {
		const lines = nestedStageLines([run()], plain, 0);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("build-agent");
	});

	test("a running stage shows the last four of its actions, with the hidden count", () => {
		const lines = nestedStageLines([run({ liveDetails: commands(6) })], plain, 0);
		// Header, the `... N earlier` row, then the window.
		expect(lines.length).toBe(6);
		expect(lines[0]).toContain("build-agent");
		expect(lines[1]).toContain("... 2 earlier");
		const actions = lines.slice(2);
		expect(actions.map((line) => line.trim())).toEqual([
			"├ $ echo 3",
			"├ $ echo 4",
			"├ $ echo 5",
			"└ $ echo 6",
		]);
		expect(actions[0]!.startsWith("    ")).toBe(true);
	});

	test("a finished stage is its header row only, however much it did", () => {
		const lines = nestedStageLines([run({ finishedAt: 2000, details: commands(3) })], plain, 0);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("build-agent");
	});

	test("a failed stage's header marks it failed", () => {
		const failedDetails = {
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [{ messages: [], exitCode: 1 }],
		} as unknown as SubagentDetails;
		const lines = nestedStageLines([run({ finishedAt: 2000, details: failedDetails })], plain, 0);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("✗");
		expect(lines[0]).not.toContain("✓");
	});

	/**
	 * Pi answers a `subagent` call it rejected before dispatch (unparseable arguments, a
	 * blocked tool) with a toolResult whose `details` is `{}` — truthy, but with no `results`.
	 * It is paired into a nested run like any other, so walking the tree must survive it.
	 */
	test("a rejected dispatch carrying no results neither throws nor invents a stage body", () => {
		const rejected = run({ finishedAt: 2000, details: {} as unknown as SubagentDetails });
		expect(() => nestedStageLines([rejected], plain, 0)).not.toThrow();
		const lines = nestedStageLines([rejected], plain, 0);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("build-agent");
		expect(stageCost(rejected)).toBeNull();
		expect(stageActionLines(rejected, plain)).toEqual([]);
		expect(stageHasSummary(rejected)).toBe(false);
		const owner = { usage: { cost: 0.01 }, messages: [], nestedSubagents: [rejected] } as any;
		expect(() => resultCost(owner)).not.toThrow();
		expect(resultCost(owner)).toBeCloseTo(0.01, 10);
	});
});

describe("nested spend", () => {
	/** A result whose own turn cost `cost` and which dispatched `children`. */
	const result = (cost: number, children: any[] = []) =>
		({ usage: { cost }, messages: [], nestedSubagents: children }) as any;
	/** A nested dispatch whose details hold the given results. */
	const run = (results: any[]) => ({
		toolCallId: `n${Math.random()}`,
		agent: "stage",
		task: "",
		startedAt: 1,
		details: { mode: "single", agentScope: "user", projectAgentsDir: null, results },
	});

	test("a result with no dispatches costs exactly its own spend", () => {
		expect(resultCost(result(0.0314))).toBe(0.0314);
	});

	test("dispatched cost is the children's spend, which the parent's usage never holds", () => {
		const owner = result(0.0314, [run([result(0.0296)]), run([result(0.0122)])]);
		expect(dispatchedCost(owner)).toBeCloseTo(0.0418, 10);
		expect(resultCost(owner)).toBeCloseTo(0.0732, 10);
	});

	test("a nested stage's own dispatches are counted too, so the total never undercounts", () => {
		const grandchild = run([result(0.5)]);
		const child = result(0.25, [grandchild]);
		const owner = result(0.1, [run([child])]);
		expect(resultCost(owner)).toBeCloseTo(0.85, 10);
	});

	test("the bottom line equals the sum of the stage lines", () => {
		const stages = [0, 0, 0.0296, 0.0122, 0, 0];
		const owner = result(0.0314, stages.map((c) => run([result(c)])));
		const stageSum = stages.reduce((a, b) => a + b, 0);
		const footer = resultCost(owner);
		expect(footer - 0.0314).toBeCloseTo(stageSum, 10);
		expect(footer).toBeCloseTo(0.0732, 10);
	});
});

describe("oneLine", () => {
	test("collapses a heredoc or a multi-statement chain onto one line", () => {
		expect(oneLine("cat > plan.md <<'EOF'\n# Plan\n- one\nEOF")).toBe("cat > plan.md <<'EOF' # Plan - one EOF");
		expect(oneLine("cd /x &&\n  bun test")).toBe("cd /x && bun test");
		expect(oneLine("a\n\n\nb")).toBe("a b");
	});

	test("never leaves a newline behind", () => {
		const rendered = oneLine("line1\nline2\r\nline3");
		expect(rendered.includes("\n")).toBe(false);
		expect(rendered.includes("\r")).toBe(false);
	});

	test("a rendered command line is single-line even for a script", () => {
		const script = "cat > file.sh <<'EOF'\n#!/bin/bash\necho hi\nEOF\nbash file.sh";
		expect(formatStageAction("bash", { command: script }, plain, 0).includes("\n")).toBe(false);
	});
});

describe("a stage action can never wrap", () => {
	const script = "cat >> firebase-functions/test/gemini.test.js <<'EOF'\n\ntest(\"background\", async () => {\n  expect(1).toBe(1);\n});\nEOF";
	const run = {
		details: {
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				{
					messages: [
						{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: script } }] },
						{
							role: "toolResult",
							toolCallId: "1",
							toolName: "bash",
							isError: false,
							content: [{ type: "text", text: "ok" }],
						},
					],
				},
			],
		},
	} as any;

	test("a heredoc command renders on one line", () => {
		const lines = stageActionLines(run, plain);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.includes("\n")).toBe(false);
		expect(lines[0]!.startsWith("$ cat >> firebase-functions/test/gemini.test.js")).toBe(true);
		expect(lines[0]!.endsWith("(exit code 0)")).toBe(true);
	});
});

describe("stageCostLabel", () => {
	test("names a real cost", () => {
		expect(stageCostLabel(0.0265)).toBe("$0.0265");
	});

	test("stays silent when the stage cost nothing", () => {
		expect(stageCostLabel(0)).toBe("");
		expect(stageCostLabel(null)).toBe("");
	});
});

describe("command stage checks", () => {
	const handoff = (checks: unknown) => JSON.stringify({ schemaVersion: 1, taskId: "t", status: "PASS", checks });

	test("reads the commands a command stage ran", () => {
		expect(
			checksOfHandoff(handoff([
				{ command: "npm run typecheck", exitCode: 0, log: "/l1" },
				{ command: "npx prettier --check src", exitCode: 1, log: "/l2" },
			])),
		).toEqual([
			{ command: "npm run typecheck", exitCode: 0 },
			{ command: "npx prettier --check src", exitCode: 1 },
		]);
	});

	test("an empty, absent or malformed checks list is not a crash", () => {
		expect(checksOfHandoff(handoff([]))).toBeUndefined();
		expect(checksOfHandoff(handoff(undefined))).toBeUndefined();
		expect(checksOfHandoff("not json")).toBeUndefined();
		expect(checksOfHandoff(handoff([{ command: 1 }]))).toBeUndefined();
	});

	test("a stage with no transcript lists its checks as the actions it ran", () => {
		const run = {
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: [
					{
						messages: [],
						usage: { cost: 0 },
						checks: [
							{ command: "npm run typecheck", exitCode: 0 },
							{ command: "npx prettier --check src", exitCode: 1 },
						],
					},
				],
			},
		} as any;
		expect(stageActionLines(run, plain)).toEqual([
			"$ npm run typecheck (exit code 0)",
			"$ npx prettier --check src (exit code 1)",
		]);
	});

	test("a command stage shows its checks where other agents show their trace", () => {
		const checks = [1, 2, 3, 4, 5, 6].map((n) => ({ command: `cmd ${n}`, exitCode: n % 2 }));
		expect(checkActionLines(checks, plain)).toEqual([
			"... 2 earlier",
			"$ cmd 3 (exit code 1)",
			"$ cmd 4 (exit code 0)",
			"$ cmd 5 (exit code 1)",
			"$ cmd 6 (exit code 0)",
		]);
	});

	test("no checks means no check rows; the stage's rows come from its handoff", () => {
		expect(checkActionLines(undefined, plain)).toEqual([]);
		expect(checkActionLines([], plain)).toEqual([]);
	});

	test("only a command stage is identified by its model", () => {
		expect(isCommandStage({ model: "command" })).toBe(true);
		expect(isCommandStage({ model: "claude-sonnet-4" })).toBe(false);
		expect(isCommandStage(undefined)).toBe(false);
	});
});

describe("a command stage's own handoff is its trace", () => {
	/** A launcher command stage's result: one handoff record, no transcript, no checks. */
	const stage = (over: Record<string, unknown> = {}) =>
		({
			model: "command",
			agent: "plan-lint-agent",
			command: "/Users/koomen/.pi/agent/bin/plan-lint",
			exitCode: 0,
			finishedAt: 1,
			messages: [],
			usage: { cost: 0 },
			checks: [],
			summary: "Plan file not found: x.md. Pass the feature plan.",
			...over,
		}) as any;
	const run = (child: any) =>
		({ details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [child] } }) as any;
	const planLint = JSON.stringify({
		schemaVersion: 1,
		taskId: "t",
		status: "FAIL",
		summary: "Plan file not found: x.md. Pass the feature plan.",
		requirements: [],
		checks: [],
		files: [],
		deviations: [],
		unresolved: [],
	});

	test("the invocation and the handoff summary are the rows it has to show", () => {
		const rows = [
			"$ /Users/koomen/.pi/agent/bin/plan-lint (exit code 0)",
			"Plan file not found: x.md. Pass the feature plan.",
		];
		expect(commandActionLines(stage(), plain)).toEqual(rows);
		expect(stageActionLines(run(stage()), plain)).toEqual(rows);
	});

	test("a stage that logged checks shows those instead of its invocation", () => {
		expect(
			commandActionLines(stage({ checks: [{ command: "npm run typecheck", exitCode: 1 }], summary: "two failures" }), plain),
		).toEqual(["$ npm run typecheck (exit code 1)"]);
	});

	test("the summary comes from the handoff, and a stage without one adds no row", () => {
		expect(summaryOfHandoff(planLint)).toBe("Plan file not found: x.md. Pass the feature plan.");
		expect(summaryOfHandoff(JSON.stringify({ status: "PASS" }))).toBeUndefined();
		expect(summaryOfHandoff("not json")).toBeUndefined();
		expect(commandActionLines(stage({ summary: undefined }), plain)).toEqual([
			"$ /Users/koomen/.pi/agent/bin/plan-lint (exit code 0)",
		]);
	});

	test("the summary row is one line, cut to fit an action row", () => {
		const rows = commandActionLines(stage({ summary: `first line\nsecond ${"x".repeat(200)}` }), plain);
		expect(rows).toHaveLength(2);
		expect(rows[1]!.includes("\n")).toBe(false);
		expect(rows[1]!.endsWith("...")).toBe(true);
		expect(rows[1]!.length).toBeLessThan(110);
	});

	test("a collapsed stage list can tell that the summary is the answer it owes", () => {
		// Collapsed normally hides a finished stage's actions, so the summary has to be
		// offered explicitly or a plan-lint FAIL collapses to a bare stage line.
		expect(stageHasSummary(run(stage()))).toBe(true);
		expect(stageHasSummary(run(stage({ checks: [{ command: "cmd", exitCode: 0 }] })))).toBe(false);
		expect(stageHasSummary(run(stage({ model: "claude-sonnet-4" })))).toBe(false);
		expect(stageHasSummary(undefined)).toBe(false);
	});

	test("a plan-lint FAIL at exit 0 is a failed stage, because the body says so", () => {
		const result = stage({ messages: [{ role: "assistant", content: [{ type: "text", text: planLint }] }] });
		expect(result.exitCode).toBe(0);
		expect(isFailedResult(result)).toBe(true);
		// The same shape carrying PASS in the body passes, so the exit code decided neither.
		const passing = planLint.replace('"FAIL"', '"PASS"');
		expect(
			isFailedResult({ ...result, messages: [{ role: "assistant", content: [{ type: "text", text: passing }] }] }),
		).toBe(false);
	});
});
