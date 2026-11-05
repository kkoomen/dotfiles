/**
 * `/steer` and `/queue` delivery: command mapping, parent fallback, notices, confirmations.
 *
 * Inert to Pi's loader, which only loads `.pi/agent/extensions/{*\/index.ts,*.ts}`, so this
 * file is never executed as an extension. It drives the exported delivery seams directly with
 * fake children whose stdin records what the extension would have sent, so no `pi` child is
 * ever spawned.
 *
 * How to run it (this repo has no package.json or node_modules, and index.ts imports
 * @earendil-works/*, so bun needs a module resolution root; bun does not honor NODE_PATH):
 *
 *   cd <repo root>
 *   ln -sfn /Users/koomen/.bun/install/global/node_modules node_modules
 *   bun test ./.pi/agent/extensions/subagent/steer-queue.test.ts
 *   rm -f node_modules
 *
 * Without that symlink the suite fails with `Cannot find module '@earendil-works/pi-ai'`. The
 * link is test scaffolding only: create it for the run and remove it again before any commit.
 */

import { expect, test } from "bun:test";
import {
	beginDelivery,
	deliverySummary,
	deliverySummaryType,
	forwardCommandOf,
	planParentDelivery,
	settleChildExit,
	settleDelivery,
	submissionNotice,
	type BeginDeliveryOptions,
	type DeliveryBatch,
} from "./index.ts";

type FakeTarget = NonNullable<BeginDeliveryOptions["targets"]>[number];
type Notice = { message: string; type?: "info" | "warning" | "error" };

/** One child whose stdin records the RPC commands the extension writes to it. */
function fakeChild(agent: string, open = true) {
	const writes: Record<string, unknown>[] = [];
	const stdin = {
		writable: open,
		writableEnded: false,
		write(chunk: string) {
			writes.push(JSON.parse(chunk));
			return true;
		},
	};
	return { child: { agent, stdin } as unknown as FakeTarget, writes };
}

/** A batch shaped by the test, for the pure formatters. */
function batch(overrides: Partial<DeliveryBatch> = {}): DeliveryBatch {
	return {
		mode: "steer",
		text: "focus on the parser",
		written: [],
		failed: [],
		results: new Map(),
		done: false,
		...overrides,
	};
}

function collector() {
	const notices: Notice[] = [];
	const notify = (message: string, type?: "info" | "warning" | "error") => {
		notices.push({ message, type });
	};
	return { notices, notify };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("both commands map to their RPC command type", () => {
	expect(forwardCommandOf("steer")).toEqual({ type: "steer" });
	expect(forwardCommandOf("follow_up")).toEqual({ type: "follow_up" });
});

test("a running child absorbs the submission and the parent gets nothing", () => {
	for (const mode of ["steer", "follow_up"] as const) {
		expect(planParentDelivery(mode, 2, false)).toEqual({ forward: true });
		expect(planParentDelivery(mode, 1, true)).toEqual({ forward: true });
	}
});

test("with no child the parent delivery follows the streaming state", () => {
	expect(planParentDelivery("steer", 0, false)).toEqual({ forward: false, deliverAs: "steer" });
	expect(planParentDelivery("follow_up", 0, false)).toEqual({ forward: false, deliverAs: "followUp" });
	// Idle: a plain send starts a turn, so no delivery mode.
	expect(planParentDelivery("steer", 0, true)).toEqual({ forward: false });
	expect(planParentDelivery("follow_up", 0, true)).toEqual({ forward: false });
});

test("beginDelivery writes the mode's RPC command with one unique id per target", () => {
	const build = fakeChild("build-agent");
	const review = fakeChild("review-agent");
	const steer = beginDelivery("steer", "look at the parser", { targets: [build.child, review.child] });
	expect(steer.written.map((w) => w.agent)).toEqual(["build-agent", "review-agent"]);
	expect(build.writes[0]).toEqual({
		type: "steer",
		message: "look at the parser",
		id: steer.written[0].requestId,
	});
	expect(Object.keys(build.writes[0] ?? {}).sort()).toEqual(["id", "message", "type"]);
	expect(review.writes[0]).toEqual({
		type: "steer",
		message: "look at the parser",
		id: steer.written[1].requestId,
	});
	expect(steer.written[0].requestId).not.toBe(steer.written[1].requestId);

	const queued = beginDelivery("follow_up", "then summarize", { targets: [build.child] });
	expect(build.writes[1]).toEqual({
		type: "follow_up",
		message: "then summarize",
		id: queued.written[0].requestId,
	});
	expect(queued.written[0].requestId).not.toBe(steer.written[0].requestId);

	// Settle both batches so no confirmation timer outlives this test.
	for (const id of [...steer.written, ...queued.written]) settleDelivery({ id: id.requestId, success: true });
});

test("a typed steer still forwards its images", () => {
	const build = fakeChild("build-agent");
	const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
	const steer = beginDelivery("steer", "describe this", { targets: [build.child], images });
	expect(build.writes[0]).toEqual({
		type: "steer",
		message: "describe this",
		id: steer.written[0].requestId,
		images,
	});
	settleDelivery({ id: steer.written[0].requestId, success: true });
});

test("a closed child stdin is a write failure, never a forwarded target", () => {
	const closed = fakeChild("build-agent", false);
	const result = beginDelivery("steer", "hi", { targets: [closed.child] });
	expect(closed.writes).toEqual([]);
	expect(result.written).toEqual([]);
	expect(result.failed).toEqual([{ agent: "build-agent", reason: "not delivered (stdin closed)" }]);
	expect(result.done).toBe(true);
});

test("no targets: nothing written and no summary is ever emitted", async () => {
	const { notices, notify } = collector();
	const result = beginDelivery("steer", "hi", { targets: [], notify, timeoutMs: 5 });
	expect(result.written.length).toBe(0);
	expect(result.done).toBe(true);
	await wait(15);
	expect(notices).toEqual([]);
});

test("submissionNotice names the forwarded targets", () => {
	const two = batch({
		written: [
			{ agent: "build-agent", requestId: "a" },
			{ agent: "review-agent", requestId: "b" },
		],
	});
	expect(submissionNotice(two)).toBe("Steer -> 2 subagents: build-agent, review-agent");
	expect(submissionNotice(batch({ written: [{ agent: "build-agent", requestId: "a" }] }))).toBe(
		"Steer -> 1 subagent: build-agent",
	);
	expect(submissionNotice(batch({ mode: "follow_up", written: [{ agent: "build-agent", requestId: "a" }] }))).toBe(
		"Queue -> 1 subagent: build-agent",
	);
});

test("submissionNotice names the parent disposition when nothing was forwarded", () => {
	expect(submissionNotice(batch({ parent: "started" }))).toBe("Started a new run");
	expect(submissionNotice(batch({ parent: "steered" }))).toBe("Steered the current run");
	expect(submissionNotice(batch({ mode: "follow_up", parent: "queued" }))).toBe("Queued for after the run");
});

test("submissionNotice keeps a write failure visible next to the parent fallback", () => {
	const notice = submissionNotice(
		batch({
			failed: [{ agent: "build-agent", reason: "not delivered (stdin closed)" }],
			parent: "queued",
		}),
	);
	expect(notice).toBe(
		"Steer: no running subagent accepted the message (build-agent: not delivered (stdin closed)); Queued for after the run",
	);
});

test("deliverySummary reports each agent's disposition", () => {
	const summary = batch({
		written: [
			{ agent: "build-agent", requestId: "a" },
			{ agent: "review-agent", requestId: "b" },
		],
		results: new Map([
			["a", { agent: "build-agent", outcome: "queued" }],
			["b", { agent: "review-agent", outcome: "consumed by an input handler" }],
		]),
		done: true,
	});
	expect(deliverySummary(summary)).toBe("Steer accepted: build-agent queued, review-agent consumed by an input handler");
	expect(deliverySummaryType(summary)).toBe("info");
});

test("rejected, timed-out and child-exit outcomes are named and warned about", () => {
	for (const outcome of ["rejected by child", "no confirmation after 2s", "child exited before confirming"]) {
		const summary = batch({
			written: [{ agent: "build-agent", requestId: "a" }],
			results: new Map([["a", { agent: "build-agent", outcome }]]),
			done: true,
		});
		expect(deliverySummary(summary)).toBe(`Steer accepted: build-agent ${outcome}`);
		expect(deliverySummaryType(summary)).toBe("warning");
	}
});

test("a write failure is named in the summary and warns", () => {
	const summary = batch({
		written: [{ agent: "build-agent", requestId: "a" }],
		results: new Map([["a", { agent: "build-agent", outcome: "queued" }]]),
		failed: [{ agent: "review-agent", reason: "not delivered (stdin closed)" }],
		done: true,
	});
	expect(deliverySummary(summary)).toBe(
		"Steer accepted: build-agent queued, review-agent: not delivered (stdin closed)",
	);
	expect(deliverySummaryType(summary)).toBe("warning");
});

test("settleDelivery correlates the response id and ignores ids it never issued", () => {
	const build = fakeChild("build-agent");
	const { notices, notify } = collector();
	const steer = beginDelivery("steer", "hi", { targets: [build.child], notify, timeoutMs: 50 });
	const requestId = steer.written[0].requestId;

	expect(settleDelivery({ id: "another-request", success: true })).toBe(false);
	expect(settleDelivery({ success: true })).toBe(false);
	expect(settleDelivery({ id: 42, success: true })).toBe(false);
	expect(notices).toEqual([]);

	expect(settleDelivery({ id: requestId, command: "steer", success: true, data: { disposition: "queued" } })).toBe(true);
	expect(notices).toEqual([{ message: "Steer accepted: build-agent queued", type: "info" }]);
	expect(steer.done).toBe(true);

	// A duplicate response must not produce a second summary.
	expect(settleDelivery({ id: requestId, command: "steer", success: true, data: { disposition: "queued" } })).toBe(false);
	expect(notices.length).toBe(1);
});

test("a rejected response is reported as rejected by the child", () => {
	const review = fakeChild("review-agent");
	const { notices, notify } = collector();
	const queued = beginDelivery("follow_up", "later", { targets: [review.child], notify, timeoutMs: 50 });
	settleDelivery({ id: queued.written[0].requestId, command: "follow_up", success: false, error: "no active run" });
	expect(notices).toEqual([
		{ message: "Queue accepted: review-agent rejected by child (no active run)", type: "warning" },
	]);
});

test("the summary waits for every forwarded id", () => {
	const build = fakeChild("build-agent");
	const review = fakeChild("review-agent");
	const { notices, notify } = collector();
	const queued = beginDelivery("follow_up", "later", {
		targets: [build.child, review.child],
		notify,
		timeoutMs: 50,
	});
	settleDelivery({ id: queued.written[0].requestId, success: true, data: { disposition: "queued" } });
	expect(notices).toEqual([]);
	settleDelivery({ id: queued.written[1].requestId, success: true, data: { disposition: "queued" } });
	expect(notices).toEqual([{ message: "Queue accepted: build-agent queued, review-agent queued", type: "info" }]);
});

test("an unanswered command is reported after the confirmation window", async () => {
	const build = fakeChild("build-agent");
	const { notices, notify } = collector();
	const steer = beginDelivery("steer", "hi", { targets: [build.child], notify, timeoutMs: 5 });
	await wait(20);
	expect(notices).toEqual([{ message: "Steer accepted: build-agent no confirmation after 2s", type: "warning" }]);
	expect(steer.done).toBe(true);
	// A response arriving after the timeout confirms nothing new.
	expect(settleDelivery({ id: steer.written[0].requestId, success: true })).toBe(false);
	expect(notices.length).toBe(1);
});

test("a child that exits before confirming is reported instead of left pending", () => {
	const build = fakeChild("build-agent");
	const review = fakeChild("review-agent");
	const { notices, notify } = collector();
	const steer = beginDelivery("steer", "hi", {
		targets: [build.child, review.child],
		notify,
		timeoutMs: 50,
	});

	settleChildExit(build.child);
	// The review child still owes a response, so the batch is not summarized yet.
	expect(notices).toEqual([]);

	settleDelivery({ id: steer.written[1].requestId, success: true, data: { disposition: "queued" } });
	expect(notices).toEqual([
		{
			message: "Steer accepted: build-agent child exited before confirming, review-agent queued",
			type: "warning",
		},
	]);
});
