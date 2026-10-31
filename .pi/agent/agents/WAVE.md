# Wave route

Read this before dispatching any wave stage. `AGENTS.md` holds the wave invariants and `orchestrator-agent.md` holds the classification and edge taxonomy; this file owns the route, its state, and its repair paths.

## Required context

- Own `.pi/state/<waveId>.json` in addition to the per-stage task state, and use one `taskId` for the entire wave — the wave ID itself — passed unchanged to every dispatch of every item and stage, because the launcher rejects any `priorRecords` entry whose taskId differs from the dispatching contract.
- Record per item: the roadmap file, workspace, layer, `itemId`, worktree path and its branch `item/<itemId>`, `baseCommit`, `mergeOrder`, commit hash, repair-round count, record paths, and quarantine state; plus the pruned DAG with edge kinds, pruned edges and reasons, interface freezes, per-item path attribution, per-item blast radius, any open follow-up (branch, base, commit), and the current integration-review record (`status`, `treeHash`, `recordedAt`, covered items).
- Create each item worktree with `git worktree add -b item/<itemId> <path> <baseCommit>`, where `<baseCommit>` is `<waveBase>` for every item, and remove it only after that item's commit exists and has been assembled.
- `itemId` must be a valid Git ref component and unique inside the wave. Namespace it by track when two tracks can produce the same file name — `server/01-handler-guards`, never a bare `01-handler-guards` — because it becomes both a branch name and a wave-state key.
- Pass `cwd` on every wave dispatch, equal to that stage's `worktreePath`. The contract field tells the agent where to work; the launcher's `cwd` argument is what snapshots, review digests, check-log paths, and the process working directory actually use. Never set one without the other.
- Never resolve a conflict, never amend, and never merge content on an item's behalf. The history operations you perform are the step-8 cherry-pick of already-reviewed item commits in DAG order and the post-assembly follow-up cherry-picks of the Follow-up Route. A cherry-pick conflict stops you and opens that route.
- Post-assembly gate re-runs are dispatched to `test-agent` as verification-only runs, or to `build-agent` when content must change; never executed by the orchestrator.
- Snapshots are per scope: an item's worktree snapshot guards only that item's stages; the assembled tree's snapshot guards the assembled test runs, integration review, and readiness report. Never compare a worktree snapshot to an assembled-tree record.
- If the repository does not ignore `.pi/worktrees/`, place worktrees outside the repo and record that path.

## Route

```
1  architect-large-agent      x N   parallel   one roadmap feature file each
2  wave-planner-agent         x 1   serial     DAG, layers, freezes, merge order -> WAVE_READY
3  build-agent                x N   parallel   one worktree each; item tests + delta gate; no commit
4  document-agent             x N   parallel   only when triggered; inside the item's worktree
5  formatter-agent            x N   parallel   inside the item's worktree
6  code-review-agent          x N   parallel   item scope; working tree vs baseCommit
7  commit-agent              x N   parallel   one commit per item on branch item/<id>
8  assemble                   x 1   serial     cherry-pick in DAG order onto the wave branch
9  test-agent                 x W   parallel   one dispatch per workspace on the assembled tree
10 integration-review-agent   x 1   serial     cross-item surfaces only; records tree hash
11 readiness report           x 1   serial     orchestrator verifies evidence; creates no commit
```

Build is parallel for every item; assembly is serial by layer.

- **Item cap.** A wave carries at most 8 items. If more are ready, split them into sequential waves ordered by the DAG and tell the user the batch plan before step 3. Do not run a 9-item wave as two dispatch batches of one wave.
- **Dispatch ceiling.** One `subagent` parallel call accepts at most 8 tasks and runs 4 concurrently. Dispatch a step in batches of at most 8, size a layer to 4 where throughput matters, and treat a step of 9 or more as a dispatch error rather than a slow run.
- **Wave base and assembly worktree.** Before any worktree exists, fix the wave base as `git rev-parse HEAD` on a clean tree, record it as `<waveBase>`, and give every item that same `baseCommit`. Record, per workspace, the baseline suite result on `<waveBase>` — that is the zero point step 9 compares against, and it is not the per-item worktree baseline from step 3. Create one dedicated assembly worktree with `git worktree add -b <waveId> <assemblyPath> <waveBase>` and run step 8 and step 10 there, never in the user's main checkout, which may hold uncommitted work. Remove the assembly worktree only after the readiness report.
- **Step 1** runs against the main checkout, before worktrees exist. Dispatch each item's architect with `workType: large`; every other wave dispatch carries `workType: wave`. Each architect may edit only its own assigned feature file; overlapping roadmap files stop the wave before step 2. A `RECLASSIFY` or `REPLAN_REQUIRED` from one item's architect drops only that item, which continues as its own route, and the wave proceeds with the remainder when at least two items are left. An `INTERVIEW_ROUND` pauses the whole wave. Relay questions one at a time in the item's order and keep each item's transcript separate.
- **Step 2** is mandatory even when the plan looks obvious. Pass all N roadmap files, the roadmap index, and any settled user decisions. No build is dispatched until the step-2 record's status is `WAVE_READY` with every edge classified or pruned, every item placed in a layer, and every `itemId` unique. A `REPLAN_REQUIRED` from `wave-planner-agent` returns the wave to step 1 for the named items; that is a different scope from an item architect's `REPLAN_REQUIRED` at step 1, which drops only that item. Step 2 ends at the Plan Confirmation Gate in `orchestrator-agent.md`: present the item plans, the layers, and the expected assembly-fix cost, then suspend with `AWAITING PLAN APPROVAL` and wait for the user's decision before step 3.
- **Step 3** creates one worktree per item with `git worktree add -b item/<itemId> <path> <baseCommit>`, records that branch name in wave state, and records each item's baseline at its `baseCommit` before building — the item's own delta gate, measured on that worktree, which is not the per-workspace wave-base baseline. The dispatched `build-agent` re-reads that baseline and runs the item's own tests plus the delta gate inside the worktree; you never execute a gate yourself. Each dispatch sets `cwd` to that worktree. The delta gate is the same suite set run before and after the item's change; new failures fail the item, pre-existing failures do not. The builder does not commit: review at step 6 reads its working tree. Build agents never merge, rebase, cherry-pick, push, or clean up worktrees.
- **Step 4** runs only when that item has a documentation trigger. The document dispatch receives the item's path list from the planner's attribution, may edit only those paths, and sets `cwd` to the item's worktree. It operates before review, so the documentation lands in the item's own commit. No document stage runs after assembly.
- **Step 5** formats each item inside its own worktree, in parallel, before review, with `cwd` set to that worktree. No formatting runs after assembly.
- **Step 6** reviews each item against its own plan and blast radius, diffing the item's working tree against `baseCommit` including untracked files, with `cwd` set to that worktree. A commit-range diff would be empty because the builder never commits.
- **Step 7** dispatches one `commit-agent` per item with `workType: wave`, `cwd` set to that item's worktree, that worktree's `expectedSnapshot`, and that worktree's records; `documentRequired` is decided per item, and the wave planner record is always in `priorRecords`. Each dispatch carries exactly one item's files apart from mandatory shared generated artifacts. No combined commit exists.
- **Step 8** is your assembly history operation: a serial `git cherry-pick` of the already-reviewed item commits onto the wave branch in DAG order, executed inside the assembly worktree. Cherry-pick preserves each item's message, so the final history has exactly one commit per item. A conflict is never resolved in an item worktree: it opens the Follow-up Route at the wave branch's last good assembly commit. The orchestrator never resolves a conflict and never amends an item commit.
- **Generated files.** A file a repository hook regenerates on every commit, such as the git-cliff `CHANGELOG.md`, is a mandatory shared artifact that every item commit carries. It is excluded from the step-7 "exactly one item's files" rule, `wave-planner-agent` must list it, and a step-8 conflict on one is resolved only through the Follow-up Route. Because every item commit regenerates it from the same wave base, a repository with such a hook conflicts on every item after the first: for an N-item wave, budget up to N-1 assembly-fix rounds, report that cost at the Plan Confirmation Gate, and prefer smaller waves there. If the repository can move that generator out of the commit hook, recommend it as its own follow-up route rather than smuggling it into the wave.
- **Step 9** dispatches one test-agent per workspace, not per item: workspaces have disjoint suites, runners, and baselines. It runs on the assembled tree with `cwd` set to the assembly worktree, and it is verification-only: that dispatch may not add or change tests and may not fix production code, and it returns missing coverage to the owning item's worktree before step 7, or through the Follow-up Route when it is discovered later. Step 9 is a delta gate with its own owner: it receives the per-workspace baselines recorded on `<waveBase>` before step 3 — not the per-item worktree baselines, which measure a different tree — and applies the same delta rule as step 3. New failures fail the wave; pre-existing failures are the zero point and are recorded, not fixed. The owner of an assembled-tree failure is the item whose recorded blast radius contains the failing test file or the paths it exercises; a failure no item owns is a planning defect that returns to `wave-planner-agent`.
- **Step 10** is the last stage that inspects content. It reviews cross-item surfaces only and records the assembled `treeHash` with `recordedAt`, with `cwd` set to the assembly worktree. No stage may write on the assembled tree after step 7 except a follow-up worktree, so nothing writes after it. If step 9 or step 10 writes anything, the item review for the touched files is invalidated and must be re-run.
- **Step 11** verifies the evidence and reports readiness. It creates no commit, and any post-assembly gate re-run is dispatched to `test-agent` as a verification-only run or to `build-agent` when content must change, never executed by the orchestrator.
- **Layers order assembly, not build.** `contract`, `collision`, and `evidence` edges decide the step-8 order; every item builds and commits in parallel. A `contract` edge makes the consuming item's commit land after the defining item's in the assembly order, while a recorded interface freeze still lets both items build at the same time.
- **A `collision` edge forbids same-wave inclusion.** Two items that both need the same hot file may not be in one wave unless `wave-planner-agent` splits them into separate items. Drop the extra item to its own route; layer assignment never substitutes for that split.
- If quarantine or replan drops the wave below two items, collapse the remainder to single-item routes instead of continuing a degenerate wave.

The Follow-up Route below is conditional: it runs after a step-8 conflict, a step-9 failure, or a step-10 `INTEGRATION_FINDINGS`, and it adds no fixed step to the happy path.

## Follow-up Route (post-assembly)

This is the only legal repair path once item commits exist. It applies to a step-9 test failure, a step-10 `INTEGRATION_FINDINGS`, or a step-8 cherry-pick conflict.

- Base: the wave branch head at the last good assembly commit. Create a fresh worktree there and pass its path as `cwd` on every dispatch in this route:
  - `git worktree add -b followup/<itemId> <path> <base>` for a step-9 or step-10 repair.
  - `git worktree add -b assembly-fix/<itemId> <path> <base>` for a step-8 conflict.
  Record its path, branch, and base in wave state.
- `build-agent` repairs in that worktree. `formatter-agent` and `code-review-agent` run there too, scoped to that item.
- `commit-agent` creates exactly one commit on the branch that worktree was created with. This is a follow-up commit, not an item commit, and it is an explicit carve-out from the "one commit per item" and "each commit contains exactly one item's files" rules.
- Cherry-pick that follow-up commit onto the wave branch. A step-8 conflict on a mandatory shared generated artifact resumes the interrupted cherry-pick range afterwards.
- The integration review re-runs on the updated assembled tree and records a new `treeHash`.
- A wave with an open follow-up is not reported ready: the readiness report requires a current `INTEGRATION_PASS` for the final `treeHash`. This keeps the "never report success with unresolved work" rule intact rather than suspending it.

## Failure routing and quarantine

Cluster failures by root cause before dispatching any repair. One dispatch per root cause, not one per failing check.

- Wrong or missing test: `test-agent` while the item is still pre-commit, or the Follow-up Route after step 7, where `build-agent` makes the repair and `commit-agent` lands it.
- Production defect: `build-agent` for the owning item.
- Sibling breakage after assembly: `build-agent` for the item the integration review names as owner. A finding with no identifiable owner is a planning defect and returns to `wave-planner-agent`.
- Assembled-tree test failure: use the step-9 ownership rule rather than waiting for the step-10 integration review — the owner is the item whose recorded blast radius contains the failing test file or the paths it exercises, and a failure no item owns returns to `wave-planner-agent`.
- Any repair that must land after step 7 — a step-8 conflict, a step-9 failure, or a step-10 `INTEGRATION_FINDINGS` — runs through the Follow-up Route: one follow-up commit, assembled by cherry-pick, then a re-run of the touched item's review and the integration review. None of these rewrites, reverts, or amends an item commit, and none re-quarantines a committed item.
- Genuine spec conflict between items: `wave-planner-agent`, then the user through one `INTERVIEW_ROUND` question.
- Pre-existing red baseline: nobody. It is the delta gate's zero point and must be recorded, not fixed.
- Environment or tooling problem: `wave-planner-agent` for scheduling; the item stays blocked, never silently dropped.

Repairs are capped per item: the item is quarantined after the third failed repair round.

Quarantine is pre-commit only. An item may be quarantined at any point before step 7 creates its commit; record it `QUARANTINED` in wave state, drop it from the wave, keep its branch and all its records, and report it as an explicit follow-up with the failing evidence. Quarantine is transitive: an item that depends on a quarantined item through a `contract` or `collision` edge is quarantined too. Once an item is committed at step 7 and assembled at step 8, it is never quarantined and never reverted: a failure there becomes the Follow-up Route on the committed content, recorded as merged and blocked with follow-up. Never defer a quarantined item silently, never let a specialist declare it, and never record one item as both committed and quarantined. Report every quarantine as it happens; it needs no user confirmation.

## Invalidation

Pre-commit repairs stay inside the owning item's worktree. After a repair to item A before step 7, re-run A's own gate, its delta gate, its formatter pass, its document pass when the repair changes documented behavior, and its review, then commit. Nothing outside that worktree is invalidated, because document and formatter writes happen before review inside the worktree.

A post-assembly repair that touches an item's files requires that item's review to be re-run in the follow-up worktree, and the integration review to be re-run. Dispatch the affected gate to `test-agent` as a verification-only run or to `build-agent` when content must change; never execute a gate yourself. A post-assembly change to an already-committed item goes through the Follow-up Route as one follow-up commit on the committed content and never rewrites history. No stage may write on the assembled tree after step 7; only a follow-up worktree is writable, and if step 9 or step 10 writes anything, the item review for the touched files is invalidated and must be re-run.

The readiness report is blocked until a current `INTEGRATION_PASS` record exists; item commits and cherry-picks do not invalidate it, only a content change does. A follow-up commit is a content change, so it requires a fresh integration review of the updated tree. State the cascade in wave state so a later stage can see which evidence is stale.

## Prohibited in a wave

- Do not resolve a cherry-pick conflict yourself, amend a commit, or reorder assembly away from the planner's DAG order; a conflict opens the Follow-up Route for the owning `build-agent`.
- Do not execute a post-assembly gate yourself; dispatch it to `test-agent` or `build-agent`.
- Do not let any stage write on the assembled tree after step 7; post-assembly repair happens only in a fresh follow-up worktree.
- Do not quarantine an item after its commit exists, and do not revert committed content.
- Do not start a wave with fewer than two items, more than eight items, overlapping deployables, a `collision` pair inside one wave, an unfrozen `contract` edge, or an unclassified edge.
- Do not let a quarantined item vanish from the report, and do not quarantine work a specialist has not failed.
- Do not substitute the integration review for per-item review, or per-item review for the integration review.
- Do not compare a worktree snapshot with an assembled-tree snapshot, and do not replace a snapshot to silence the guard.
- Do not dispatch a wave stage without `cwd` set to that stage's worktree.
