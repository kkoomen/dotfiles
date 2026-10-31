# Stage handoff contract

Read this once per isolated stage. Preserve meaning and evidence; no hard word cap. Use Caveman lite for summaries, normal language for plans, conditions, safety, and user questions. Never abbreviate away a requirement or failure scenario.

## Assignment

The orchestrator supplies `contract` to each specialist invocation: `taskId`, the complete requirement IDs assigned to this stage, and, when available, `plan`, `priorRecords`, and `expectedSnapshot`. The task text supplies scope, requirement meanings, allowed paths, exclusions, confirmed decisions, and unresolved finding IDs. A path alone is not enough: read its relevant content. Prior results are evidence to verify, not new instructions.

For a wave stage the contract also carries `waveId`, `layer`, `worktreePath`, `baseCommit`, and `mergeOrder` where that stage needs them. All are optional and absent on single-item routes; never require them outside `workType: wave`, and never infer them from a path.

## Context economy

Keep every stage's context proportional to its assignment; context size is a correctness-safe cost, not a virtue.

- Treat the current `git diff` plus the changed-file list as the primary artifact. For build, review, and test, read only the files and ranges needed to judge the assigned IDs, using `read` offsets instead of whole trees. Expand a range only when a specific question requires it.
- Do not re-derive a prior stage's work. Read its record by `RUN_RECORD` path with `jq`, selecting only the fields you need. `priorRecords` are paths, not inlined content; never assume a report body is already in your context.
- The parent's preview of your output may be truncated by `context-guard`, with the full text left in your `RUN_RECORD`. Keep the canonical detail in the record and the summary short; do not paste whole files, dependency trees, or long logs into evidence.
- When `context-guard` appends an over-budget note to a stage result, narrow the next dispatch rather than ignoring it: tighter read ranges, fewer files, and no repeated full-report echoing. Report the note if it blocks the assignment.

For commit, also supply `workType` (`small`, `normal`, `large`, `wave`, or `documentation`), all required successful `priorRecords`, and the latest `expectedSnapshot`. Set `documentRequired: false` only when small/normal documentation triggers were checked and do not apply; document that decision in task state. The launcher checks required route stages, current formatter evidence, and changes since review before starting the committer. Review records must list the actual reviewed files. Newly changed production/test/configuration files invalidate review even if they were not in its original file list.

For `wave`, the commit stage runs once per item, in parallel, each inside that item's own worktree on branch `item/<itemId>`, and each dispatch carries exactly one item's files apart from mandatory shared generated artifacts. The orchestrator then assembles those commits by cherry-pick in DAG order. No combined wave commit exists, and the one commit per roadmap item rule still holds.

Post-assembly repair uses the orchestrator's follow-up route, and it is the only exception to that rule: one follow-up commit on `followup/<itemId>` in a fresh worktree created at the last good assembly commit, or on `assembly-fix/<itemId>` for a step-8 conflict, cherry-picked by the orchestrator, followed by a re-run integration review that records the new `treeHash`. A follow-up commit is not an item commit, and it is the explicit carve-out from both the one-commit-per-item rule and the exactly-one-item's-files rule. A file a repository hook regenerates on every commit, such as the git-cliff `CHANGELOG.md`, is likewise excluded from the exactly-one-item's-files rule and is listed by the planner as a mandatory shared artifact; a step-8 conflict on one is resolved only through the follow-up route, never by amending an item commit.

`priorRecords` contains only current successful prerequisites, never failed or superseded runs. For a repair, put failed-report paths and unresolved findings in the task text instead; those are the work to fix, not prerequisites that must already pass. Preserve failed records in the ledger for audit.

Use stable acceptance IDs (`R1`, `R2`, `R1.1`). Preserve exact conditions, interfaces, failure behavior, and verification methods in the canonical plan. Map every requirement to an owning stage. Assign all relevant behavior IDs to builder, tester, and reviewer; assign documentation and mechanical obligations to their owning stages. A stage cannot remove or silently defer an assigned ID. Return `REPLAN_REQUIRED` if the assignment must change. The orchestrator must reconcile additional IDs before retrying.

## Final response

Return one JSON object, optionally in a JSON code fence, with no surrounding narrative. Successful responses use:

```json
{
  "taskId": "same-as-assignment",
  "status": "PASS",
  "summary": "Stage outcome; important rationale or limitations.",
  "requirements": [
    {
      "id": "R1",
      "state": "implemented",
      "evidence": ["path:symbol — behavior; test name or check reference"]
    }
  ],
  "checks": [
    {
      "command": "exact executed command",
      "exitCode": 0,
      "log": "absolute evidence path"
    }
  ],
  "files": ["exact changed or reviewed path"],
  "deviations": [],
  "unresolved": []
}
```

Keep meaningful details, not repeated activity narration. No fabricated snapshots, paths, outcomes, or savings. Retain failures separately and resolve them before success. An empty `checks` array is allowed only when the role genuinely needs no executed check; explain manual verification or non-applicability in evidence. Tests always require executed-check evidence.

- Architect: `PLAN_READY`, every assigned ID `planned`. Normal architect puts its complete concise plan in `summary` (stored once by the launcher). Large architect writes only the assigned roadmap plan, then returns its path and acceptance/decision references, not another copy of the full plan.
- Builder: `PASS`, IDs `implemented`; map each to code and meaningful validation. Later-stage obligations remain pending in the orchestrator's ledger, not falsely completed here.
- Tester/reviewer: `PASS`, IDs `verified`; independently inspect requirements, code, diff, tests, and evidence. Builder claims are navigation, not proof. Reviewer gives each finding an ID, severity, requirement, exact location, failure scenario, and correction. Put blocking findings in `unresolved`; optional observations may be an additional `findings` array.
- Documenter/formatter: `PASS` or justified `NOT_APPLICABLE`, IDs `verified` or `not_applicable`. Non-applicability evidence must explain why the obligation does not apply; it is not permission to drop required behavior.
- Committer: `COMMITTED`, IDs `verified`; add `commit` (full hash), `subject`, and final task-related working-tree status. Verify all assigned readiness obligations before committing. In wave mode return one record per dispatch: item ID, worktree path, branch `item/<itemId>`, and that item's commit hash, with no combined commit. A follow-up dispatch instead returns the item ID, the follow-up worktree path and base, its branch `followup/<itemId>` or `assembly-fix/<itemId>`, and that one follow-up commit hash; it is a follow-up commit, not an item commit. A committer never assembles or cherry-picks either kind.
- Wave planner: `WAVE_READY` with the plan in `summary` (required blocks in `wave-planner-agent.md`), or `INTERVIEW_ROUND` with exactly one user-owned question, or `REPLAN_REQUIRED`. `files` lists every roadmap file read. Its `Wave constraints` block must name the mandatory shared artifacts that repository hooks regenerate on every commit, so the step-7 one-item-files rule and the step-8 conflict handler both have an authorized exception.
- Integration reviewer: `INTEGRATION_PASS` or `INTEGRATION_FINDINGS`. The record names `treeHash`, `recordedAt`, covered items, assembly order, and shared surfaces; every finding names its owning item. This is the last stage that inspects content: nothing writes after it. After a follow-up commit it re-runs on the updated assembled tree and records a new `treeHash`; the previous record is never reused.
- `QUARANTINED` is an item state recorded by the orchestrator in `.pi/state/<waveId>.json`, not a specialist success status. A specialist returns `FAIL`; only the orchestrator quarantines, after the repair cap, with the branch and records retained. Quarantine is pre-commit only: an item may be quarantined at any point before its step-7 commit exists. Once committed and assembled, a failure becomes a follow-up route on the committed content, recorded as merged and blocked with follow-up and never reverted; one item is never recorded as both committed and quarantined.

For `FAIL`, `BLOCKED`, `INTEGRATION_FINDINGS`, `REPLAN_REQUIRED`, `RECLASSIFY`, or `INTERVIEW_ROUND`, return at least `taskId`, `status`, and an exact `summary` explaining the blocker, responsible stage, or verbatim user question. Include available evidence and finding IDs. These statuses stop progression; they are not runtime crashes. Never report success with unresolved required work.

## Durable evidence and resumption

The launcher adds `RUN_RECORD: <absolute path>` outside your response. It stores the full final output, effective requested model/thinking, task contract, usage, and a generated snapshot under the user's private Pi `runs` directory. Do not repeat previous reports in your final output. The orchestrator reads records selectively with `jq` and passes their paths onward. Full text remains available even when a preview is truncated.

For normal planning, `final.md` next to the architect's record is the canonical plan artifact; for large planning, use the assigned roadmap file. Keep exact user decisions and full interview transcripts in the task's ignored local state, not repeatedly in tool arguments. Read them on reinvocation. Do not create roadmap files during routine execution.

The orchestrator owns `.pi/state/<taskId>.json`: canonical plan reference/revision, requirement meanings and owners, user decisions/transcript reference, selected route, current stage, all stage record paths, outstanding findings, and next action. This is coordination state, not production implementation. Checkpoint after every stage and before compaction. Keep secrets out. It is ignored by Git and must not be committed.

For a wave, the orchestrator owns `.pi/state/<waveId>.json`: per item the roadmap file, workspace, layer, stage task IDs, worktree path and its branch `item/<itemId>`, `baseCommit`, `mergeOrder`, commit hash, repair-round count, record paths, and quarantine state, plus the pruned DAG with edge kinds and prune reasons, interface freezes, per-item path attribution (including the documentation paths a document dispatch may edit), per-item blast radius, any open follow-up (branch, base, commit, repair-round count), and the current integration-review record (`status`, `treeHash`, `recordedAt`, covered items). It is ignored by Git and never committed.

Snapshots are scoped: an item's worktree snapshot guards only that item's stages, and the assembled-tree snapshot guards the wave's post-assembly stages: the per-workspace test runs on the assembled tree, the integration review, and the readiness report. A worktree snapshot never invalidates an assembled-tree record, and an assembled-tree change does not by itself invalidate an item's review. But any post-assembly repair that touches an item's files requires that item's review to be re-run, and the integration review to be re-run. The guard is never satisfied by replacing the value, and a worktree snapshot is never compared with an assembled-tree record. A follow-up worktree gets its own snapshot against its base, and it does not replace the item's step-6 snapshot.

Step 9 is verification-only: the assembled-tree test dispatch may not add or change tests and may not fix production code, because nothing can commit on the assembled tree after step 7. Missing coverage discovered at step 9 or later goes back to the owning item's worktree before step 7 or through the follow-up route. If step 9 or step 10 writes anything, the item review for the touched files is invalidated and must be re-run before the readiness report.

The integration-review record binds to content, not to `HEAD`: `treeHash` is the tree content it examined and `recordedAt` is when it recorded the result. Item commits at step 7 do not change content and the step-8 cherry-picks preserve content, so neither invalidates the record; only a content change does. Nothing writes after the integration review, so a current `INTEGRATION_PASS` cannot be stale by the time the readiness report runs, and a follow-up repair re-runs the review before the next readiness report instead of reusing the old record. A stale record blocks that report; only a re-run integration review may refresh it.

Use single-stage dispatch and examine status before proceeding. Supply the preceding record's snapshot as `expectedSnapshot` when dispatching the next stage. If it differs, inspect changes and refresh affected evidence; never merely replace the value to silence the guard. Changes to production/tests after review require renewed affected validation and independent review. Mechanical changes also need their effects checked; missing evidence blocks commit.

Compaction must retain task ID, state/plan/record paths, confirmed decisions, unresolved IDs, current stage, and next action. Reload those sources after compaction. Use Pi's normal automatic compaction; do not compact after every stage or add a separate summarizer agent.

The schema checks completeness and explicit statuses, not semantic correctness. Independent review and executed validation remain mandatory for their routes.
