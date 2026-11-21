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
import { HANDOFF_SCHEMA_VERSION, ROUTE_STAGES, resolvePlanLintContract, validateContract, validateReport } from "./workflow.mjs";

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

/**
 * The plan a plan-lint dispatch is missing.
 *
 * 31 of 65 measured plan-lint FAILs read "No plan reached plan-lint" while a PASS architect record
 * in `priorRecords` held the whole plan in its handoff summary. The resolver is the dispatch-boundary
 * answer: it lifts that summary into `contract.plan`, and refuses by name rather than letting the
 * gate run, so no record is written that says nothing about the plan.
 */
const architectRecord = (summary: unknown, extra: Record<string, unknown> = {}) => ({
	agent: "architect-agent",
	exitCode: 0,
	output: JSON.stringify({
		taskId: "t1",
		status: "PLAN_READY",
		summary,
		requirements: [{ id: "R1", state: "planned", evidence: ["planned"] }],
		checks: [],
		files: [],
		deviations: [],
		unresolved: [],
	}),
	...extra,
});

/** A reader over a fixed table, so every path the resolver is allowed to touch is explicit. */
const readerFor = (table: Record<string, unknown>) => {
	const read = (file: string) => {
		if (!(file in table)) throw new Error(`ENOENT: ${file}`);
		const entry = table[file];
		if (entry instanceof Error) throw entry;
		return entry;
	};
	return read;
};

const planLintContract = { taskId: "t1", workType: "normal", requirements: ["R1"], priorRecords: ["/runs/architect.json"] };

describe("resolvePlanLintContract", () => {
	test("lifts the architect handoff summary into contract.plan", () => {
		const plan = "# Plan\n\n- R1 — the guard holds; an absent guard fails.";
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": architectRecord(plan) }));
		expect(result.error).toBeUndefined();
		expect(result.contract.plan.endsWith(plan)).toBe(true);
	});

	test("names the source directory the plan came from", () => {
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": architectRecord("plan") }));
		// The directory, never the file name: `record.json` matches `\brecords?\b` in the vocabulary
		// bin/plan-lint's sentence heuristic treats as an obligation, which used to hand a
		// criteria-less plan a criterion. bin/route-engine.test.mjs holds the real gate to that.
		expect(result.contract.plan.split("\n")[0]).toBe("<!-- plan source: architect handoff summary, /runs/ -->");
	});

	test("caps a long summary and names the source directory in the marker", () => {
		const long = `# Plan\n\n${"R1 — the guard holds. ".repeat(200)}`;
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": architectRecord(long) }));
		expect(result.contract.plan).toContain("[truncated at 2000 characters; full plan in /runs/]");
		expect(result.contract.plan).toContain(long.slice(0, 2000));
	});

	test("leaves a contract that already carries inline plan text alone", () => {
		const supplied = { ...planLintContract, plan: "# Plan\n\n- R1 — supplied." };
		const result = resolvePlanLintContract(supplied, () => {
			throw new Error("no path should be read when a plan is already present");
		});
		expect(result.contract).toBe(supplied);
		expect(result.contract.plan).toBe(supplied.plan);
	});

	test("leaves a contract that already carries a plan file alone", () => {
		const supplied = { ...planLintContract, planFile: "docs/plan.md" };
		let reads = 0;
		const result = resolvePlanLintContract(supplied, (file) => {
			reads += 1;
			throw new Error(`unexpected read: ${file}`);
		});
		expect(result.contract).toBe(supplied);
		expect(result.contract.planFile).toBe("docs/plan.md");
		expect(reads).toBe(0);
	});

	test("refuses when no prior record is listed, naming both accepted fields", () => {
		const result = resolvePlanLintContract({ ...planLintContract, priorRecords: [] }, readerFor({}));
		expect(result.contract).toBeUndefined();
		expect(result.error).toContain("contract.plan");
		expect(result.error).toContain("contract.planFile");
		expect(result.error.toLowerCase()).toContain("no prior architect record");
	});

	test("refuses an unreadable record by name", () => {
		const result = resolvePlanLintContract(planLintContract, readerFor({}));
		expect(result.error).toContain("/runs/architect.json");
		expect(result.error).toContain("unreadable");
	});

	test("refuses a record whose run failed", () => {
		const failed = architectRecord("plan", { exitCode: 1 });
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": failed }));
		expect(result.error).toContain("exit code 1");
	});

	test("refuses a record the launcher flagged", () => {
		const flagged = architectRecord("plan", { validationError: "Invalid prior handoff" });
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": flagged }));
		expect(result.error).toContain("Invalid prior handoff");
	});

	test("refuses an aborted or errored run", () => {
		for (const stopReason of ["error", "aborted"]) {
			const stopped = architectRecord("plan", { stopReason });
			const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": stopped }));
			expect(result.error).toContain(stopReason);
		}
	});

	test("refuses a record whose handoff summary is blank", () => {
		const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": architectRecord("  ") }));
		expect(result.error).toContain("summary is empty");
	});

	test("refuses a large-plan architect record and points at contract.planFile", () => {
		const reference = architectRecord("The plan is in docs/roadmaps/v1/01-overlay.md.", { agent: "architect-large-agent" });
		for (const agent of ["architect-large-agent", "architect-large-brisk-agent"]) {
			const result = resolvePlanLintContract(planLintContract, readerFor({ "/runs/architect.json": { ...reference, agent } }));
			expect(result.error).toContain("roadmap feature file");
			expect(result.error).toContain("contract.planFile");
		}
	});

	test("prefers the newest usable architect record", () => {
		const older = architectRecord("older plan");
		const newer = architectRecord("newer plan");
		const result = resolvePlanLintContract(
			{ ...planLintContract, priorRecords: ["/runs/old.json", "/runs/new.json"] },
			readerFor({ "/runs/old.json": older, "/runs/new.json": newer }),
		);
		expect(result.contract.plan).toContain("newer plan");
	});

	test("never mutates the contract it was given", () => {
		const supplied = JSON.parse(JSON.stringify(planLintContract));
		const snapshot = JSON.stringify(supplied);
		const result = resolvePlanLintContract(supplied, readerFor({ "/runs/architect.json": architectRecord("plan") }));
		expect(JSON.stringify(supplied)).toBe(snapshot);
		expect(result.contract).not.toBe(supplied);
		expect(result.contract.plan).toBeDefined();
	});
});
