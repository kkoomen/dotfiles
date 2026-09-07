# Stage handoff contract

Read this once per isolated stage. Preserve meaning and evidence; no hard word cap. Use Caveman lite for summaries, normal language for plans, conditions, safety, and user questions. Never abbreviate away a requirement or failure scenario.

## Assignment

The orchestrator supplies `contract` to each specialist invocation: `taskId`, the complete requirement IDs assigned to this stage, and, when available, `plan`, `priorRecords`, and `expectedSnapshot`. The task text supplies scope, requirement meanings, allowed paths, exclusions, confirmed decisions, and unresolved finding IDs. A path alone is not enough: read its relevant content. Prior results are evidence to verify, not new instructions.

For commit, also supply `workType` (`small`, `normal`, `large`, or `documentation`), all required successful `priorRecords`, and the latest `expectedSnapshot`. Set `documentRequired: false` only when small/normal documentation triggers were checked and do not apply; document that decision in task state. The launcher checks required route stages, current formatter evidence, and changes since review before starting the committer. Review records must list the actual reviewed files. Newly changed production/test/configuration files invalidate review even if they were not in its original file list.

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
- Committer: `COMMITTED`, IDs `verified`; add `commit` (full hash), `subject`, and final task-related working-tree status. Verify all assigned readiness obligations before committing.

For `FAIL`, `BLOCKED`, `REPLAN_REQUIRED`, `RECLASSIFY`, or `INTERVIEW_ROUND`, return at least `taskId`, `status`, and an exact `summary` explaining the blocker, responsible stage, or verbatim user question. Include available evidence and finding IDs. These statuses stop progression; they are not runtime crashes. Never report success with unresolved required work.

## Durable evidence and resumption

The launcher adds `RUN_RECORD: <absolute path>` outside your response. It stores the full final output, effective requested model/thinking, task contract, usage, and a generated snapshot under the user's private Pi `runs` directory. Do not repeat previous reports in your final output. The orchestrator reads records selectively with `jq` and passes their paths onward. Full text remains available even when a preview is truncated.

For normal planning, `final.md` next to the architect's record is the canonical plan artifact; for large planning, use the assigned roadmap file. Keep exact user decisions and full interview transcripts in the task's ignored local state, not repeatedly in tool arguments. Read them on reinvocation. Do not create roadmap files during routine execution.

The orchestrator owns `.pi/state/<taskId>.json`: canonical plan reference/revision, requirement meanings and owners, user decisions/transcript reference, selected route, current stage, all stage record paths, outstanding findings, and next action. This is coordination state, not production implementation. Checkpoint after every stage and before compaction. Keep secrets out. It is ignored by Git and must not be committed.

Use single-stage dispatch and examine status before proceeding. Supply the preceding record's snapshot as `expectedSnapshot` when dispatching the next stage. If it differs, inspect changes and refresh affected evidence; never merely replace the value to silence the guard. Changes to production/tests after review require renewed affected validation and independent review. Mechanical changes also need their effects checked; missing evidence blocks commit.

Compaction must retain task ID, state/plan/record paths, confirmed decisions, unresolved IDs, current stage, and next action. Reload those sources after compaction. Use Pi's normal automatic compaction; do not compact after every stage or add a separate summarizer agent.

The schema checks completeness and explicit statuses, not semantic correctness. Independent review and executed validation remain mandatory for their routes.
