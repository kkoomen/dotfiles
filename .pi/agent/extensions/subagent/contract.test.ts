/**
 * Contract-v2 guards: schema versioning, stable finding ids, and the exported route map.
 *
 * These exist because a handoff schema is evidence: an unversioned change makes 10k records
 * on disk ambiguous, and a finding without a stable id cannot be shown to be fixed by the
 * next repair round. Both are cheap to check and expensive to discover late.
 *
 * Run (this repo has no package.json; link the global modules first):
 *
 *   cd /Users/koomen/dotfiles
 *   ln -sfn /Users/koomen/.bun/install/global/node_modules node_modules
 *   bun test ./.pi/agent/extensions/subagent/contract.test.ts
 */
import { describe, expect, test } from "bun:test";
import { HANDOFF_SCHEMA_VERSION, ROUTE_STAGES, validateContract, validateReport } from "./workflow.mjs";

const contract = { taskId: "t1", requirements: ["R1"] };

const base = {
	taskId: "t1",
	status: "PASS",
	summary: "did the thing",
	requirements: [{ id: "R1", state: "verified", evidence: ["a.ts:1 — covered"] }],
	checks: [],
	files: ["a.ts"],
	deviations: [],
	unresolved: [],
};

describe("schemaVersion", () => {
	test("is accepted when absent, so old records stay valid", () => {
		expect(validateReport(JSON.stringify(base), contract, "code-review-agent")).toBeNull();
	});

	test("accepts the current version", () => {
		const report = { ...base, schemaVersion: HANDOFF_SCHEMA_VERSION };
		expect(validateReport(JSON.stringify(report), contract, "code-review-agent")).toBeNull();
	});

	test("rejects a version the launcher does not know", () => {
		const report = { ...base, schemaVersion: HANDOFF_SCHEMA_VERSION + 1 };
		expect(validateReport(JSON.stringify(report), contract, "code-review-agent")).toContain("schemaVersion");
	});
});

describe("findings", () => {
	test("accepts a finding with id, location and scenario", () => {
		const report = {
			...base,
			findings: [{ id: "F1", location: "a.ts:12", scenario: "null deref when input is empty" }],
		};
		expect(validateReport(JSON.stringify(report), contract, "code-review-agent")).toBeNull();
	});

	test("rejects a finding without a stable id", () => {
		const report = { ...base, findings: [{ location: "a.ts:12", scenario: "boom" }] };
		expect(validateReport(JSON.stringify(report), contract, "code-review-agent")).toContain("stable id");
	});

	test("rejects a duplicate finding id", () => {
		const report = {
			...base,
			findings: [
				{ id: "F1", location: "a.ts:12", scenario: "one" },
				{ id: "F1", location: "b.ts:3", scenario: "two" },
			],
		};
		expect(validateReport(JSON.stringify(report), contract, "code-review-agent")).toContain("Duplicate finding");
	});

	test("rejects a finding without a location or scenario", () => {
		expect(
			validateReport(
				JSON.stringify({ ...base, findings: [{ id: "F1", scenario: "boom" }] }),
				contract,
				"code-review-agent",
			),
		).toContain("location");
		expect(
			validateReport(
				JSON.stringify({ ...base, findings: [{ id: "F1", location: "a.ts:1" }] }),
				contract,
				"code-review-agent",
			),
		).toContain("scenario");
	});
});

describe("ROUTE_STAGES", () => {
	test("keeps formatter before review on every route that has both", () => {
		for (const stages of Object.values(ROUTE_STAGES)) {
			const formatter = stages.indexOf("formatter-agent");
			const review = stages.indexOf("code-review-agent");
			if (formatter !== -1 && review !== -1) expect(formatter).toBeLessThan(review);
		}
	});
});

describe("requirement ownership", () => {
	test("accepts { id, text, owner } requirements", () => {
		expect(
			validateContract({
				taskId: "t1",
				requirements: [{ id: "R1", text: "Implement the guard", owner: "build-agent" }],
			}),
		).toBeNull();
	});

	test("still accepts bare-string requirements from an in-flight ledger", () => {
		expect(validateContract({ taskId: "t1", requirements: ["R1", "R2"] })).toBeNull();
	});

	test("a non-owning stage may report not_applicable with a reason", () => {
		const owned = {
			taskId: "t1",
			requirements: [{ id: "R1", text: "Implement the guard", owner: "build-agent" }],
		};
		const report = {
			...base,
			requirements: [{ id: "R1", state: "not_applicable", evidence: ["owned by build-agent"] }],
		};
		expect(validateReport(JSON.stringify(report), owned, "code-review-agent")).toBeNull();
	});

	test("an owning stage cannot downgrade its own requirement to not_applicable", () => {
		const owned = {
			taskId: "t1",
			requirements: [{ id: "R1", text: "Implement the guard", owner: "build-agent" }],
		};
		const report = {
			...base,
			requirements: [{ id: "R1", state: "not_applicable", evidence: ["skipped"] }],
		};
		expect(validateReport(JSON.stringify(report), owned, "build-agent")).toContain("Unfinished or invalid state");
	});

	test("a requirement with no owner keeps the per-agent state rules", () => {
		const unowned = { taskId: "t1", requirements: [{ id: "R1", text: "x" }] };
		const report = {
			...base,
			requirements: [{ id: "R1", state: "not_applicable", evidence: ["irrelevant"] }],
		};
		expect(validateReport(JSON.stringify(report), unowned, "code-review-agent")).toContain(
			"Unfinished or invalid state",
		);
	});
});
