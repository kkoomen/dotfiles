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
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import os from "node:os";
import {
	exitCodeOf,
	formatStageAction,
	getDisplayItems,
	isDelegatingRun,
	stageActionLines,
	formatStageCost,
	readTarget,
	shortenPath,
	stripCdPrefix,
	stageCost,
	stageItems,
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

	test("a stage with no timing yet has nothing to show", () => {
		expect(stageShowsActions(null)).toBe(true);
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
