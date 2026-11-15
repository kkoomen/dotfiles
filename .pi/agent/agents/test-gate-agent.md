---
name: test-gate-agent
description: Runs the repository's test suites mechanically and reports the delta against the base commit. No model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/test-gate
---

# Test Gate (mechanical stage)

This stage is **not a model**. `command:` makes the launcher run `~/.pi/agent/bin/test-gate`
with `bash -c` inside the dispatch `cwd`; the script prints the handoff JSON itself and the
launcher records it exactly like a model stage.

## Why it is mechanical

Running a suite is tool orchestration: the exit code already answers "did anything break".
Paying a reasoning model 28 turns to re-derive that produced 588 PASS results out of 625 runs in
the measured history — the judgement that *is* needed (what deserves a test) now belongs to
`build-agent`, which owns the tests for its work, and to the optional `test-agent` design review,
which reads this gate's gap report instead of re-reading the tree.

## What it runs

Discovery, first match wins:

1. Repository gate configuration via `bin/gate-config` (default `<git-common-dir>/pi-gate.json`,
   shared by every worktree and never committed) → `test[]`, and `"baseline": "base"` to always
   measure against `baseCommit`, which is what a repository with known-red tests at HEAD needs.
2. `<repo>/.pi/tests.json` → `suites[]`.
3. `package.json` → `scripts.test`.

## Delta rule

A failure that also fails at the base commit is the zero point, not a regression. The baseline
comes from `contract.baselineFailures`, or from re-running the same suites at `contract.baseCommit`
in a temporary worktree (`contract.baselineAtBase`, or the repository config). **A non-zero exit is
authoritative**: if the output carries no parsable test name, the command itself becomes the
regression rather than a silent pass.

## What it reports beyond pass/fail

- `uncovered[]` — changed source files that no test file references by name. This is the only list
  a test-design pass needs to read.
- `baselineFailures[]` — pre-existing failures treated as the zero point.
- `checks[]` — every command with its exit code and log.

## Rules

- Never edits code, tests, fixtures, or configuration.
- Never weakens the delta rule to get a PASS.
- A `BLOCKED` invocation (missing toolchain, no worktree bootstrap) is an environment problem, not
  a code failure; report it and let the orchestrator bootstrap.
