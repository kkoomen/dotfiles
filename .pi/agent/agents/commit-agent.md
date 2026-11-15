---
name: commit-agent
description: Creates the focused commit the selected route allows after every stage required by the route has passed. Mechanical, no model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/commit-gate
---

# Commit Agent (mechanical stage)

This stage is **not a model**. `command:` makes the launcher run `~/.pi/agent/bin/commit-gate` with
`bash -c` inside the dispatch `cwd`; the script prints the handoff JSON itself and the launcher
records it exactly like a model stage.

## Why it is mechanical

The message is written by `build-agent`, which already holds the context and the reason, and is
carried in its handoff as `commit: {subject, bullets, files}`. What remained for this stage was
git plumbing plus assertions — 1,235 dispatches and 9,749 model turns in the measured history to
stage files and run `git commit`. The assertions are now code, and they are stricter than the
model's were:

- the route's required stages are present with their success statuses, and the formatter record's
  snapshot matches `expectedSnapshot`;
- the changed set is exactly the reviewed file set — unreviewed content is refused;
- the message matches that tree (`commit.files` must cover the change), which is what catches a
  message written before a later repair;
- the message stays general: a bullet naming a path, an extension, a symbol, or a line range is
  rejected;
- the staged diff is scanned for secrets, environment files, task artifacts, and debug leftovers;
- only explicit in-scope paths are staged; generated artifacts a repository hook rewrites (such as
  the git-cliff `CHANGELOG.md`) are left to the hook.

## Message contract (produced by `build-agent`)

```json
"commit": {
  "subject": "fix(frame): dismiss IME when the setup overlay loses focus",
  "bullets": [
    "Keep the setup root mounted across focus and visibility changes",
    "Route IME dismissal through the shared overlay controller"
  ],
  "files": ["apps/frame-android/src/main/java/.../FrameRoot.kt"]
}
```

`subject` is `type(scope): outcome`, at most 50 characters, no trailing period. `bullets` are 1–4
general statements, required whenever the tree touches more than one file. `files` is the staleness
guard. When the builder supplies no message, the gate composes one from the task id and the areas
touched, and records that as a deviation.

## Scope

Verify release readiness, stage only the assigned task, and create the focused commit or commits the route allows. This is a mechanical finalization role: never repair code, tests, documentation, formatting, plans, or validation failures.

## Required Context

- Read `HANDOFF.md` beside this file; its assignment, JSON output, and evidence rules apply here. Preserve every requirement and safety detail; no hard output-length limit.
- Read `HANDOFF.md` for the readiness table, and the repository's root `AGENTS.md` for commit conventions, signing, hooks, and authorship.
- The script, not this document, holds the readiness gate, the message lint, the scope check, and the hygiene scan. Read it before changing behaviour here.
- Pre-existing and unrelated working-tree changes are user-owned: they are never staged, and the gate refuses a tree whose changed set is wider than the reviewed set.

## Readiness Gate

- Every prior stage required by the selected route has its defined success status (`PLAN_READY`, `WAVE_READY`, `PASS`, `NOT_APPLICABLE`, or `INTEGRATION_PASS`) and supporting evidence.
- Every check required by the selected route or `AGENTS.md`—such as tests, builds, type checks, formatting, linting, review, or documentation—is current after the last change that could affect it.
- No blocking finding, unresolved conflict, temporary artifact, debug code, or accidental secret is present in the task diff.
- The commit contains one roadmap item, feature, fix, or inseparable supporting change—not a collection of unrelated work.
- For `workType: wave`: this item's own build, delta-gate, formatter, and review evidence. The wave planner record is not part of this dispatch; the plan gate and the DAG were settled before any worktree existed. Document and formatter writes invalidate nothing here, because both run before review inside the item's worktree. A content change after review re-runs that review and blocks the commit. The launcher enforces exactly this stage set for a `wave` dispatch.
- For `workType: wave`, `INTEGRATION_PASS` is not an item-commit gate: item commits precede the final gates and the integration review, so the orchestrator verifies that record in its readiness check instead.
- For a follow-up dispatch (`followup/<itemId>` or `assembly-fix/<itemId>` with a base), the build, formatter, and review records for that follow-up worktree, plus the wave's current integration-review record and the finding or conflict ID that opened the route.

## Commit Rules

- Stage explicit in-scope paths; do not use broad staging when unrelated changes exist.
- Write no message here. The message arrives from `build-agent`'s `commit` field (see *Message contract* above); this stage validates it and refuses a stale or over-specific one.
- Follow repository rules for generated files, issue references, signing, hooks, and authorship. Do not hand-edit `CHANGELOG.md`: the git-cliff pre-commit hook regenerates it from commit messages and stages it automatically.
- Report the final commit hash, exact subject, and any in-scope file intentionally left uncommitted.

## Worktree Commit Modes

Every orchestrator dispatch commits inside a worktree, so `worktreePath` and `baseCommit` are always present. `commit-gate` enforces the branch name, the base, and the single-commit rule below: a mismatch is a `FAIL` or `BLOCKED`, never something the stage works around.

### Single-Route Worktree Mode

When the contract carries a `workType` of `small`, `normal`, `large`, or `wave` with `worktreePath` and `baseCommit`, create the route's single commit inside that worktree, on branch `route/<taskId>`, against `baseCommit`.

- Stage and commit inside `<worktreePath>` only. The builder's working tree is the content, so the commit records exactly what review examined.
- Commit on the branch the worktree was created with; never `git checkout` another branch, never stage from the primary checkout, and never reach outside the worktree.
- Do not merge the branch into the primary checkout, do not remove or prune the worktree, and do not delete the branch. The orchestrator fast-forwards the branch, removes the worktree, and deletes the branch after the route's evidence is complete.
- Handoff: worktree path, `baseCommit`, branch `route/<taskId>`, commit hash, subject, and that worktree's final task-related working-tree status.

### Wave Mode

When the contract carries `workType: wave` with `worktreePath`, `baseCommit`, and one item ID, this route creates that item's single commit, inside that item's worktree, on branch `item/<itemId>`. This mode and the follow-up mode below are the only exceptions to the single-commit rule; no combined wave commit exists. The worker returns the hash; the orchestrator cherry-picks it onto the wave branch in the round's pick order, and the next round refills capacity.

- Each commit contains exactly one item's files, apart from a mandatory shared generated artifact that a repository hook regenerates on every commit (the git-cliff `CHANGELOG.md` is the known case). Never combine two items and never commit a checkout holding more than one item's changes.
- Stage and commit inside `<worktreePath>` only, against `baseCommit`. The builder's working tree is the content, so the commit records exactly what review examined.
- Do not cherry-pick, assemble, reorder, or amend: the orchestrator owns the rolling assembly of these commits, one at a time, and cherry-pick preserves each message so history keeps one commit per item.
- Verify before committing: the item's review record with its actual reviewed file list, its delta-gate baseline and post-change results, and the formatter record for this worktree.
- Return `FAIL` naming the missing, stale, or out-of-scope stage. Do not re-review, re-format, repair, or assemble anything.
- Handoff: item ID, worktree path, `baseCommit`, branch `item/<itemId>`, commit hash, subject, and that worktree's final task-related working-tree status.
- `documentRequired` is never inferred: the dispatch sets it `true` when the document stage ran and `false` when it was checked and does not apply. An absent value means `true`, so a missing document record fails the commit.

### Follow-up Mode (post-assembly)

When the contract carries a follow-up assignment instead of an item assignment, this route creates exactly one follow-up commit on the follow-up branch the orchestrator created: `followup/<itemId>` for a final-gate or integration-review failure, `assembly-fix/<itemId>` for an assembly cherry-pick conflict.

- A follow-up commit is not an item commit. It is the explicit carve-out from the one-commit-per-item rule and from the exactly-one-item's-files rule, so creating it does not violate either; the item's own commit is never amended, reverted, or duplicated.
- Stage and commit only inside the follow-up worktree, against its recorded base, and only the files that repair the named finding or conflict. A shared generated artifact that repository hooks regenerate, such as `CHANGELOG.md`, is included when the hook stages it; it never justifies dropping a repair file or widening the commit.
- Do not cherry-pick the follow-up commit. The orchestrator assembles it onto the wave branch, then the integration review re-runs and records a new `treeHash`.
- Handoff: item ID, follow-up worktree path, base, branch (`followup/<itemId>` or `assembly-fix/<itemId>`), commit hash, subject, the finding or conflict ID it repairs, and that worktree's final task-related working-tree status.

## Prohibited Actions

- Do not modify files, split implementation work yourself, bypass hooks, suppress validation, or commit with stale or missing required evidence.
- Do not stage or commit unrelated user changes, secret files, local environment files, caches, logs, or temporary artifacts.
- Do not amend, rebase, merge, tag, push, or force-update history unless the user explicitly requests that operation. Do not cherry-pick or assemble a wave's commits; assembly belongs to the orchestrator.
- Never merge two items into one commit; the only allowed multiplicity is the documented wave item commit and the single follow-up commit.

## Completion Criteria

- Return `COMMITTED` with evidence after success, or `FAIL` with the unmet readiness condition. Never return a generic completion message.
- Exactly one focused commit was created for the assigned task, on `route/<taskId>` inside the route worktree for a single-item route, or, in wave mode, exactly one commit for the dispatched item on branch `item/<itemId>`, or exactly one follow-up commit on `followup/<itemId>` or `assembly-fix/<itemId>`, with no combined commit.
- The commit message follows repository conventions and accurately describes the diff.
- Only verified, in-scope files are included; unrelated working-tree changes remain untouched.
- The handoff contains the commit hash, subject, route evidence checked, and final working-tree status relevant to the task.
