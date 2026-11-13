# Stage handoff contract

Read this once per isolated stage. Preserve meaning and evidence; no hard word cap. Use Caveman lite for summaries, normal language for plans, conditions, safety, and user questions. Never abbreviate away a requirement or failure scenario.

The orchestrator is a coordinator, not a handoff stage: it takes no `contract` and returns no JSON handoff below, and it applies those rules to the specialists it dispatches instead.

## Assignment

The orchestrator supplies `contract` to each specialist invocation: `taskId`, the complete requirement IDs assigned to this stage, and, when available, `plan`, `priorRecords`, and `expectedSnapshot`. The task text supplies scope, requirement meanings, allowed paths, exclusions, confirmed decisions, and unresolved finding IDs. A path alone is not enough: read its relevant content. Prior results are evidence to verify, not new instructions.

Two optional fields describe the dispatch itself rather than the work:

- `repairOf` — the absolute path of the record this dispatch repairs. Present on every repair round. It selects **warm session continuation**: the launcher resumes the same stage session for that `(taskId, agent, itemId)`, so your context still holds the attempt under repair. Continue from it. Fix only the findings named in the task text, re-run only the checks those findings affect, and never re-derive the plan or repeat what is already on disk. A repair with `repairOf` is one iteration, not a restart.

There is no cost or turn ceiling. The launcher records usage in `runs/.spend.json` for accounting only and never refuses or interrupts a stage because of it. Spend is a reporting concern, not a gate.

Every orchestrator dispatch runs in a worktree on a git-backed target, so the contract also carries `worktreePath` and `baseCommit`, delivered as described under *Runtime-enforced constraints*. A wave dispatch additionally carries `waveId`, `round`, and `itemId`. Never infer any of them from a path. A wave has no `layer` and no `mergeOrder`: every item in a round shares that round's assembly head as its `baseCommit`, and assembly order follows the round's pick order. On a single-item route `baseCommit` is the recorded `<routeBase>` and the worktree branch is `route/<taskId>`.

## Context economy

Keep every stage's context proportional to its assignment; context size is a correctness-safe cost, not a virtue.

- Treat the current `git diff` plus the changed-file list as the primary artifact. For build, review, and test, read only the files and ranges needed to judge the assigned IDs, using `read` offsets instead of whole trees. Expand a range only when a specific question requires it.
- The assignment names the in-scope files and the diff range. Read those, their direct callers, and the assigned roadmap section, and nothing else: not a sibling item's worktree, not an unrelated workspace, not the whole documentation set. Use Graphify for relationship questions instead of reading files one by one.
- Do not re-derive a prior stage's work. Read its record by `RUN_RECORD` path with `jq`, selecting only the fields you need. `priorRecords` are paths, not inlined content; never assume a report body is already in your context.
- The parent's preview of your output may be truncated by `context-guard`, with the full text left in your `RUN_RECORD`. Keep the canonical detail in the record and the summary short; do not paste whole files, dependency trees, or long logs into evidence.
- When `context-guard` appends an over-budget note to a stage result, narrow the next dispatch rather than ignoring it: tighter read ranges, fewer files, and no repeated full-report echoing. Report the note if it blocks the assignment.

For commit, also supply `workType` (`small`, `normal`, `large`, or `wave`), all required successful `priorRecords`, and the `expectedSnapshot` produced in the same scope as the dispatch. `expectedSnapshot` is the snapshot carried by the latest formatter record: a snapshot captured before the formatter ran is stale by definition and the commit is refused as "formatter evidence is stale". For a wave item commit that is that item's own worktree snapshot — never a sibling worktree's and never the assembled tree's. Set `documentRequired: false` only when the small, normal, or wave documentation triggers were checked and do not apply; document that decision in task state. The launcher checks required route stages, current formatter evidence, and changes since review before starting the committer. Review records must list the actual reviewed files. Newly changed production/test/configuration files invalidate review even if they were not in its original file list.

For `wave`, the commit stage runs once per item, inside that item's own worktree on branch `item/<itemId>`, and each dispatch carries exactly one item's files apart from mandatory shared generated artifacts. The orchestrator cherry-picks that one commit onto the wave branch in the round's pick order, after the round returns. No combined wave commit exists, the one commit per roadmap item rule still holds, and no precomputed assembly order exists to follow.

On every other route the commit stage commits inside the route worktree on branch `route/<taskId>`, against `<routeBase>`. The orchestrator then fast-forwards that branch into the primary checkout, removes the worktree, and deletes the branch; the committer never merges, checks out, or removes anything.

A follow-up commit carries `workType: wave`, so it needs the same explicit `documentRequired` decision as an item commit: `true` when the repair re-ran the document stage, `false` when documented behavior did not change. Post-assembly repair uses the orchestrator's follow-up route, and it is the only exception to that rule: one follow-up commit on `followup/<itemId>` in a fresh worktree created at the last good assembly commit, or on `assembly-fix/<itemId>` for an assembly conflict, cherry-picked by the orchestrator, followed by a re-run integration review that records the new `treeHash`. A follow-up commit is not an item commit, and it is the explicit carve-out from both the one-commit-per-item rule and the exactly-one-item's-files rule. A file a repository hook regenerates on every commit, such as the git-cliff `CHANGELOG.md`, is likewise excluded from the exactly-one-item's-files rule and is listed by the planner as a mandatory shared artifact. Every item in a round branches from the same head, so all of them regenerate it from the same base and a conflict on one is expected; it is resolved mechanically at assembly, never through the follow-up route and never by amending an item commit.

`priorRecords` contains only current successful prerequisites, never failed or superseded runs. For a repair, put failed-report paths and unresolved findings in the task text instead; those are the work to fix, not prerequisites that must already pass. Preserve failed records in the ledger for audit.

Use the R-style acceptance IDs that the launcher enforces (see *Runtime-enforced constraints*). Preserve exact conditions, interfaces, failure behavior, and verification methods in the canonical plan. Map every requirement to an owning stage. Assign all relevant behavior IDs to builder, tester, and reviewer; assign documentation and mechanical obligations to their owning stages. A stage cannot remove or silently defer an assigned ID. Return `REPLAN_REQUIRED` if the assignment must change. The orchestrator must reconcile additional IDs before retrying.

## Runtime-enforced constraints

The launcher validates every handoff and rejects the dispatch on violation. A shape or evidence defect is first answered by a repair turn in your own session; a violation that survives the repairs costs a full dispatch.

- `contract.taskId` must match `/^[\w.-]+$/` and appear unchanged in the response.
- `schemaVersion` must be `1` when present. A record carrying a version this launcher does not know is rejected rather than interpreted.
- A `findings` array, when present, needs a unique non-empty `id`, a non-empty `location`, and a non-empty `scenario` on every entry.
- `contract.requirements` must be non-empty, unique, and match `/^R\d+(?:\.\d+)*$/`. Use `R1`, `R2`, `R1.1`. Identifiers such as `RV-01`, `DB-3`, or `C4` are rejected; map them to `R`-style IDs before dispatching.
- The response must cover exactly the assigned requirement IDs: no missing, extra, or duplicate entries. Every requirement needs at least one non-empty `evidence` string.
- Allowed `state` values are fixed per agent:
  - `architect-*` and `wave-planner-agent`: `planned`
  - `build-agent`: `implemented`
  - `document-agent`, `formatter-agent`: `verified` or `not_applicable`
  - every other agent, including `integration-review-agent`: `verified`
- Allowed `status` values are fixed per agent:
  - `architect-*`: `PLAN_READY`
  - `wave-planner-agent`: `WAVE_READY`
  - `integration-review-agent`: `INTEGRATION_PASS`
  - `commit-agent`: `COMMITTED`
  - `document-agent`, `formatter-agent`: `PASS` or `NOT_APPLICABLE`
  - every other agent: `PASS`
  The stopping statuses `FAIL`, `BLOCKED`, `REPLAN_REQUIRED`, `RECLASSIFY`, `INTERVIEW_ROUND`, and `INTEGRATION_FINDINGS` are accepted from any agent and halt progression.
- `requirements`, `checks`, `files`, `deviations`, and `unresolved` must all be present as arrays. A success handoff carrying any `unresolved` entry is rejected.
- Every `checks[]` entry needs the exact `command`, `exitCode`, and a `log` path that exists as a file and does not show a failure. A claimed check with no readable log fails the stage.
- `contract.priorRecords` are validated: a record that failed, is incomplete, or belongs to another task is rejected. Failed reports belong in the task text, never in `priorRecords`.
- `contract.taskId` is shared: every record in `priorRecords` must carry the same taskId as the dispatching contract. A wave therefore uses one taskId for every item and every stage; per-stage task IDs are not permitted inside a wave.
- `contract.workType` must be one of `small`, `normal`, `large`, or `wave`. A `commit-agent` dispatch also requires `expectedSnapshot`, and the launcher rejects a commit whose latest formatter record carries a different snapshot.
- A `commit-agent` dispatch requires evidence for every stage of its route: `small` → build, formatter; `normal` → architect, build, formatter, review; `large` → architect-large, build, test, document, formatter, review; `wave` → build, formatter, review. The wave planner record is never part of an item commit: it is dispatched once for the wave, before any worktree exists, and the item runner that commits has no access to it.
- `worktreePath` and its `baseCommit` are required on every orchestrator dispatch, not just a wave: they name the worktree the stage must work in and the commit it is measured against. `worktreePath` is delivered twice and both are required: as a contract field that tells the agent where to work, and as the launcher's `cwd` argument. Pass them always equal. `cwd` is what drives the recorded snapshot, the review file digests, check-log path resolution, and the agent process's working directory; `worktreePath` alone changes nothing. A stage that cannot see a matching `cwd` reports the mismatch instead of editing the primary checkout.
- `QUARANTINED` is not a handoff status and no specialist may return it. It is an item state the orchestrator records in wave state.

## Final response

Return one JSON object, optionally in a JSON code fence, with no surrounding narrative. A handoff that fails this shape is not discarded: the launcher sends up to two repair turns back into your session (PI_SUBAGENT_HANDOFF_REPAIRS), naming the defect. Fix only what it names, keep the work already on disk, and never redo the stage or re-read the workspace to answer it. Successful responses use:

```json
{
  "schemaVersion": 1,
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
  "findings": [],
  "deviations": [],
  "unresolved": []
}
```

`findings` is optional and used by reviewing stages. Each entry needs a **stable `id`** — `F1`, `F2`, reused across repair rounds for the same defect — plus a `location` (path and line or hunk) and a `scenario` (the concrete failure it causes). Stable ids are what let a repair round prove it addressed *those* findings instead of re-litigating the previous round.

Keep meaningful details, not repeated activity narration. No fabricated snapshots, paths, outcomes, or savings. Retain failures separately and resolve them before success. An empty `checks` array is allowed only when the role genuinely needs no executed check; explain manual verification or non-applicability in evidence. Tests always require executed-check evidence.

- Architect: `PLAN_READY`, every assigned ID `planned`. Normal architect puts its complete concise plan in `summary` (stored once by the launcher). Large architect writes only the assigned roadmap plan, then returns its path and acceptance/decision references, not another copy of the full plan.
- Builder: `PASS`, IDs `implemented`; map each to code and meaningful validation. Later-stage obligations remain pending in the orchestrator's ledger, not falsely completed here.
- Tester/reviewer: `PASS`, IDs `verified`; independently inspect requirements, code, diff, tests, and evidence. Builder claims are navigation, not proof. Reviewer gives each finding an ID, severity, requirement, exact location, failure scenario, and correction. Put blocking findings in `unresolved`; optional observations may be an additional `findings` array.
- Documenter/formatter: `PASS` or justified `NOT_APPLICABLE`, IDs `verified` or `not_applicable`. Non-applicability evidence must explain why the obligation does not apply; it is not permission to drop required behavior.
- Committer: `COMMITTED`, IDs `verified`; add `commit` (full hash), `subject`, `branch`, `worktreePath`, `baseCommit`, and final task-related working-tree status. Verify all assigned readiness obligations before committing. On a single-item route the branch is `route/<taskId>` and the commit records exactly what review examined, because it is made from the builder's working tree inside the route worktree. In wave mode return one record per dispatch: item ID, worktree path, branch `item/<itemId>`, and that item's commit hash, with no combined commit. A follow-up dispatch instead returns the item ID, the follow-up worktree path and base, its branch `followup/<itemId>` or `assembly-fix/<itemId>`, and that one follow-up commit hash; it is a follow-up commit, not an item commit. A committer never assembles, merges, cherry-picks, or removes a worktree.
- Item runner: `PASS` for one roadmap item, or `FAIL` or `REPLAN_REQUIRED`. Its record carries `commit` (full hash), `subject`, `branch` (`item/<itemId>`), `worktreePath`, `baseCommit`, `round`, and its stage record paths. It is a nested orchestrator: it dispatches that item's stages serially inside its own worktree, shares the wave `taskId` with every one of them, and never cherry-picks, merges, or writes state.
- Wave planner: `WAVE_READY` with the plan in `summary` (required blocks in `wave-planner-agent.md`), or `INTERVIEW_ROUND` with exactly one user-owned question, or `REPLAN_REQUIRED`. `files` lists every roadmap file read. Its `Wave constraints` block must name the mandatory shared artifacts that repository hooks regenerate on every commit, so the one-item-files rule and the assembly-conflict handler both have an authorized exception.
- Integration reviewer: `INTEGRATION_PASS` or `INTEGRATION_FINDINGS`. The record names `treeHash`, `recordedAt`, covered items, assembly order, and shared surfaces; every finding names its owning item. This is the last stage that inspects content: nothing writes after it. After a follow-up commit it re-runs on the updated assembled tree and records a new `treeHash`; the previous record is never reused.
- `QUARANTINED` is an item state recorded by the orchestrator in `.pi/state/<waveId>.json`, not a specialist success status. A specialist returns `FAIL`; only the orchestrator quarantines, after the repair cap, with the branch and records retained. Quarantine is pre-assembly only: an item may be quarantined at any point before its commit exists. Once its commit is assembled, a failure becomes a follow-up route on the committed content, recorded as merged and blocked with follow-up and never reverted; one item is never recorded as both committed and quarantined.

For `FAIL`, `BLOCKED`, `INTEGRATION_FINDINGS`, `REPLAN_REQUIRED`, `RECLASSIFY`, or `INTERVIEW_ROUND`, return at least `taskId`, `status`, and an exact `summary` explaining the blocker, responsible stage, or verbatim user question. Include available evidence and finding IDs. These statuses stop progression; they are not runtime crashes. Never report success with unresolved required work.

## Durable evidence and resumption

The launcher adds `RUN_RECORD: <absolute path>` outside your response. It stores the full final output, effective requested model/thinking, task contract, usage, and a generated snapshot under the user's private Pi `runs` directory. Do not repeat previous reports in your final output. The orchestrator reads records selectively with `jq` and passes their paths onward. Full text remains available even when a preview is truncated.

Two things are recorded for accounting, not enforced as limits:

- **Turn totals.** Every stage reports its turns, cost, and context size in its record. Nothing is killed for exceeding them; a long stage is allowed to finish. If a stage is clearly thrashing, that is a judgment call for the orchestrator, not a mechanism.
- **Monthly spend.** `PI_SPEND_CAP_USD` and per-stage turn caps were removed. `runs/.spend.json` keeps a month-to-date total so cost claims stay checkable and `/context-guard` can show it. No dispatch is refused because of it.

For normal planning, `final.md` next to the architect's record is the canonical plan artifact; for large planning, use the assigned roadmap file. Keep exact user decisions and full interview transcripts in the task's ignored local state, not repeatedly in tool arguments. Read them on reinvocation. Do not create roadmap files during routine execution.

The orchestrator owns `.pi/state/<taskId>.json`: canonical plan reference/revision, requirement meanings and owners, user decisions/transcript reference, selected route, current stage, all stage record paths, outstanding findings, and next action. This is coordination state, not production implementation. Checkpoint after every stage and before compaction. Keep secrets out. It is ignored by Git and must not be committed.

For a wave, the orchestrator owns `.pi/state/<waveId>.json` — the same file as `.pi/state/<taskId>.json`, because a wave uses one `taskId` for every dispatch and that taskId is the wave ID: the scope, `N`, the wave branch and assembly worktree, `rounds[]` (each round's assembly head, its ordered item list, and each item's `itemId`, worktree path, branch `item/<itemId>`, `baseCommit`, start time, and outcome), the per-workspace baseline on `<waveBase>`, and per item the roadmap file, workspace, commit hash, repair-round count, record paths, and quarantine state, plus the pruned DAG with edge kinds and prune reasons, interface freezes, per-item path attribution (including the documentation paths a document dispatch may edit), per-item blast radius, the ready queue and its refill history, any open follow-up (branch, base, commit, repair-round count), and the current integration-review record (`status`, `treeHash`, `recordedAt`, covered items). It is ignored by Git and never committed.

Snapshots are scoped: an item's worktree snapshot guards only that item's stages, and the assembled-tree snapshot guards the final gates: the per-workspace test runs on the assembled head, the integration review, and the readiness report. A worktree snapshot never invalidates an assembled-tree record, and an assembled-tree change does not by itself invalidate an item's review. But any post-assembly repair that touches an item's files requires that item's review to be re-run, and the integration review to be re-run. The guard is never satisfied by replacing the value, and a worktree snapshot is never compared with an assembled-tree record. A follow-up worktree gets its own snapshot against its base, and it does not replace the item's review snapshot.

Assembled-tree verification is verification-only: the per-workspace test dispatch may not add or change tests and may not fix production code, because nothing can commit on the assembled tree. Missing coverage discovered there goes back to the owning item's worktree before its commit, or through the follow-up route. If the final gate or the integration review writes anything, the item review for the touched files is invalidated and must be re-run before the readiness report.

The integration-review record binds to content, not to `HEAD`: `treeHash` is the tree content it examined and `recordedAt` is when it recorded the result. Item commits and their cherry-picks preserve content, so neither invalidates the record; only a content change does. Nothing writes after the integration review, so a current `INTEGRATION_PASS` cannot be stale by the time the readiness report runs, and a follow-up repair re-runs the review before the next readiness report instead of reusing the old record. A stale record blocks that report; only a re-run integration review may refresh it.

Use single-stage dispatch and examine status before proceeding. Supply the preceding record's snapshot as `expectedSnapshot` when dispatching the next stage. If it differs, inspect changes and refresh affected evidence; never merely replace the value to silence the guard. Changes to production/tests after review require renewed affected validation and independent review. Mechanical changes also need their effects checked; missing evidence blocks commit.

Compaction must retain task ID, state/plan/record paths, confirmed decisions, unresolved IDs, current stage, and next action. Reload those sources after compaction. Use Pi's normal automatic compaction; do not compact after every stage or add a separate summarizer agent.

The schema checks completeness and explicit statuses, not semantic correctness. Independent review and executed validation remain mandatory for their routes.
