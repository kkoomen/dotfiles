/**
 * Handoff parsing: a stage's work is only worth anything if its report survives the trip.
 *
 * Regression guard for the "Expected one JSON handoff object" class of failures, where a
 * correct handoff wrapped in a sentence, a code fence, or preceded by a schema example was
 * rejected and the whole stage re-dispatched with a cold cache.
 *
 * Run (this repo has no package.json; link the global modules first):
 *
 *   cd /Users/koomen/dotfiles
 *   ln -sfn /Users/koomen/.bun/install/global/node_modules node_modules
 *   bun test ./.pi/agent/extensions/subagent/workflow-handoff.test.ts
 */
import { describe, expect, test } from "bun:test";
import { handoffRepairReason, parseReport, validateReport } from "./workflow.mjs";

const contract = { taskId: "t1", requirements: ["R1"] };

const handoff = {
	taskId: "t1",
	status: "PASS",
	summary: "Did the thing.",
	requirements: [{ id: "R1", state: "implemented", evidence: ["bun test src/a.test.ts"] }],
	checks: [{ command: "bun test src/a.test.ts", exitCode: 0, log: ".pi/checks/a.json" }],
	files: ["src/a.ts"],
	deviations: [],
	unresolved: [],
};

const expected = { ...handoff, requirements: handoff.requirements };

describe("parseReport", () => {
	test("bare JSON object", () => {
		expect(parseReport(JSON.stringify(handoff))).toEqual(expected);
	});

	test("fenced JSON", () => {
		expect(parseReport("```json\n" + JSON.stringify(handoff) + "\n```")).toEqual(expected);
	});

	test("prose before and after the object", () => {
		const text = `Here is the handoff.\n\n${JSON.stringify(handoff)}\n\nLet me know if you need more.`;
		expect(parseReport(text)).toEqual(expected);
	});

	test("schema example first, real handoff last", () => {
		const example = { taskId: "<id>", status: "PASS", summary: "..." };
		const text = `Example shape:\n${JSON.stringify(example)}\n\nActual:\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``;
		expect(parseReport(text)).toEqual(expected);
	});

	test("braces inside strings do not truncate the object", () => {
		const tricky = { ...handoff, summary: 'Fixed {nested: braces} and "quotes".' };
		expect(parseReport(`done\n${JSON.stringify(tricky)}`)).toEqual(tricky);
	});

	test("unusable text", () => {
		expect(parseReport("I finished the work but forgot the report.")).toBeNull();
		expect(parseReport("")).toBeNull();
		expect(parseReport(undefined as unknown as string)).toBeNull();
	});
});

describe("validateReport", () => {
	test("accepts a handoff wrapped in prose", () => {
		const text = `Report below.\n\n${JSON.stringify(handoff)}`;
		expect(validateReport(text, contract, "build-agent")).toBeNull();
	});

	test("still rejects a missing status", () => {
		const { status: _status, ...broken } = handoff;
		expect(validateReport(JSON.stringify(broken), contract, "build-agent")).toContain("status");
	});

	test("still rejects an uncovered requirement", () => {
		const text = JSON.stringify({ ...handoff, requirements: [] });
		expect(validateReport(text, contract, "build-agent")).toContain("requirement");
	});
});

describe("handoffRepairReason", () => {
	const cwd = process.cwd();
	// build-agent needs no executed checks; an empty list keeps the evidence stat out of scope.
	const noChecks = { ...handoff, checks: [] };

	test("prose-wrapped handoff needs no repair", () => {
		expect(handoffRepairReason(`Done.\n\n${JSON.stringify(noChecks)}`, contract, "build-agent", cwd)).toBeNull();
	});

	test("a stopped status is a valid handoff, never repaired", () => {
		const failed = { ...handoff, status: "FAIL", summary: "Blocked on missing schema." };
		expect(handoffRepairReason(JSON.stringify(failed), contract, "build-agent", cwd)).toBeNull();
	});

	test("unparseable output is repaired", () => {
		expect(handoffRepairReason("I finished the work.", contract, "build-agent", cwd)).toContain("JSON");
	});

	test("missing keys are repaired", () => {
		const text = JSON.stringify({ taskId: "t1", status: "PASS", summary: "x" });
		expect(handoffRepairReason(text, contract, "build-agent", cwd)).toBeTruthy();
	});
});
