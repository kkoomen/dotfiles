# Wave route

Read this before dispatching any wave round. `AGENTS.md` holds the wave invariants and `orchestrator-agent.md` holds the classification and edge taxonomy; this file owns the round scheduler, its state, and its repair paths.

A wave is a **worker pool**, not a stage pipeline and not a fixed batch. Each round dispatches up to N `item-runner-agent` workers, one roadmap item each; every worker runs its item's whole chain inside its own worktree and returns one commit. The orchestrator cherry-picks those commits onto the wave branch, deletes the worktrees, and starts the next round from the new head. A 40-item roadmap and a 3-item roadmap run the same way, and a slow item never blocks a later round.

## Required context

- Own `.pi/state/<waveId>.json` in addition to the per-stage task state, and use one `taskId` for the entire wave — the wave ID itself — passed unchanged to every dispatch of every item and stage, because the launcher rejects any `priorRecords` entry whose taskId differs from the dispatching contract.
- Record in state: the scope (version, track, roadmap index), the wave branch and assembly worktree, the per-workspace baseline on `<waveBase>`, and `rounds[]` — for each round its `hand` (the wave branch head at dispatch), its ordered item list, and each item's `itemId`, `worktreePath`, branch `item/<itemId>`, `baseCommit`, start time, and outcome. Also record every item's roadmap file, workspace, commit hash, repair-round count, record paths, and quarantine state; the pruned DAG with edge kinds and prune reasons; per-item path attribution (including documentation paths) and blast radius; any open follow-up (branch, base, commit, repair-round count); and the current integration-review record (`status`, `treeHash`, `recordedAt`, covered items).
- `itemId` must be a valid Git ref component and unique inside the wave. Namespace it by track when two tracks can produce the same file name — `server/01-handler-guards`, never a bare `01-handler-guards` — because it becomes both a branch name and a wave-state key.
- Pass `cwd` on every wave dispatch, equal to that stage's `worktreePath`. The contract field tells the agent where to work; the launcher's `cwd` argument is what snapshots, review digests, check-log paths, and the process working directory actually use. Never set one without the other.
- Never resolve a conflict, never amend, and never merge content on an item's behalf. The history operations you perform are the serialized cherry-pick of an already-reviewed item commit onto the wave branch, and the post-assembly follow-up cherry-picks of the Follow-up Route. A cherry-pick conflict stops that cherry-pick and opens the Follow-up Route.
- Post-assembly gate re-runs are dispatched to `test-agent` as verification-only runs, or to `build-agent` when content must change; never executed by the orchestrator.
- Snapshots are per scope: an item's worktree snapshot guards only that item's stages; the assembled tree's snapshot guards the final gates. Never compare a worktree snapshot to an assembled-tree record.
- If the repository does not ignore `.pi/worktrees/`, place worktrees outside the repo and record that path.
## Rounds

- **N.** `N` is 8, set once at the start and recorded in state. It is the only concurrency number: the launcher's per-call task limit and worker limit must both equal it, and a wave never caps, splits, or refuses scope because the roadmap is large.
- **Capacity.** `N` bounds one round, not the machine. Each worker spawns its own stage processes, so `N` = 8 means up to 8 worker processes plus 8 nested stage processes at once, plus one bootstrap install per worktree. Confirm the host and the provider quota tolerate that before the first round; if they do not, lower `N` and both launcher limits with it. Never lower it mid-wave.
- **Planner output.** The planner's deliverable is its `summary`, which is exactly the field `context-guard` shortens first when a report is large. Read the planner's `RUN_RECORD` for the full `Items`, `Edges`, `Pruned edges`, `Ready queue`, and `Wave constraints` blocks; treat the injected preview as a pointer, never as the plan.
- **Wave base and assembly worktree.** Before any worktree exists, fix `<waveBase>` as `git rev-parse HEAD` on a clean tree and record it. Create the one assembly worktree with `git worktree add -b <waveId> <assemblyPath> <waveBase>` and run every cherry-pick, the final gates, and the integration review there, never in the user's main checkout, which may hold uncommitted work. Record the per-workspace baseline suite result on `<waveBase>`: that is the zero point the final gate compares against.
- **Ready queue.** Every in-scope item not yet committed, not quarantined, and not blocked. Recompute it at every round; never freeze it at the start.
- **Readiness predicate.** An item is ready when all of these hold:
  - No `contract` edge from a producer whose commit is not yet on the wave branch. A consumer needs the defining item's code, schema, or format to exist, so it starts in a round that begins after that commit is assembled. An interface freeze records the contract for planning; it never lets the consumer start early.
  - No `collision` edge with an item already picked for the current round. A `collision` with an already-assembled item does not block: the next round branches from a head that already contains that change, so the same file is edited forward, not contested.
  - No `evidence` edge with an item already picked for the current round that needs the same single mutable verification resource — one emulator, one shared database, one fixed port. A merely shared suite runner does not block, because each worker runs it in its own worktree.
  - A `runtime` edge never blocks: it orders rollout and reporting only.
- **Pick order.** Order the ready set by blast radius descending — largest change first — then by roadmap order. Largest-first keeps the round's slowest item from starting late, which is the only lever that shortens the barrier.
- **Round start.** In this order, and never partially:
  1. Read `hand` = the wave branch head.
  2. Walk the ready set against `hand` in pick order, admitting an item only while it has no `collision` and no single-mutable-resource `evidence` edge to an item already admitted to this round, and stop at `N` items. Admission must be incremental: computing the set once and taking the first `N` would admit two colliding items, because those two predicates are evaluated against what the round has already taken.
  3. Create one worktree per picked item with `git worktree add -b item/<itemId> <path> <hand>` and record the branch in state. Every item in the round shares `hand` as its `baseCommit`. A fresh worktree has no `node_modules`, so run the repository's declared bootstrap in it before dispatch — `pnpm install --frozen-lockfile --prefer-offline` for a pnpm workspace — serially, and record its exit status. A worktree whose bootstrap fails is not dispatched; without this step every gate fails for the wrong reason and the builder misreads a missing dependency as a red baseline.
  4. Dispatch **one** `subagent` call whose `tasks[]` holds one `item-runner-agent` entry per picked item, each with `cwd` set to that item's worktree and a contract carrying the wave `taskId`, `itemId`, `round`, `worktreePath`, and `baseCommit`.
- **Barrier.** That call returns only when every worker in it has returned, so a round is as long as its slowest item and a worker that finishes early waits for the round. Do not shrink `N` to soften this, do not dispatch workers one at a time, and do not poll for partial results: there are none. Shorten the barrier with pick order instead. A round in which any worker failed reports the whole call as an error; treat that flag as informational and decide each item's outcome from its own record. One failed item is not a failed round.
- **Assembly, then refill.** After the call returns, cherry-pick every returned commit onto the wave branch one at a time in pick order, remove each worktree as its commit lands (`git worktree remove <path>`, then `git branch -d item/<itemId>`), record each head, then start the next round immediately. Never wait for a slow item across rounds, and never hold an unfinished round open.
- **Drain.** Every round runs until the ready queue holds no admissible item. Then declare the queue drained only when no round is in flight, and run the final gates. If anything is blocked or quarantined, report it explicitly instead of reporting readiness.

## Worker route

Each `item-runner-agent` owns its item's whole chain, dispatched serially inside its own worktree with `cwd` set to that worktree:

```
architect-large-agent   validate the item's existing plan      workType: large
build-agent             implement + item tests + delta gate     workType: wave
document-agent          only when triggered                      workType: wave
formatter-agent         mechanical formatting and lint          workType: wave
code-review-agent       item scope, working tree vs baseCommit  workType: wave
commit-agent            one commit on item/<itemId>             workType: wave
```

`item-runner-agent.md` owns the per-stage rules, the repair loop, and its handoff. From here the invariants are:

- **Serial inside a worker.** Stages run one at a time because each consumes the previous one's output. Parallelism comes from the other workers, never from a worker's own stages.
- **Same taskId, same cwd.** Every stage the worker dispatches carries the wave `taskId` and `cwd` = its worktree, or the launcher rejects its records and resolves its snapshots against the wrong tree.
- **No history.** The worker commits through `commit-agent` and returns the hash; it never cherry-picks, merges, or amends, and never writes state.
- **Repair stays inside the worktree.** A review or gate failure returns to build, then re-runs formatter and review, capped at three failed rounds before the orchestrator quarantines the item.
- **`documentRequired` is always explicit.** The commit dispatch sets it `true` when the document stage ran and `false` when the item was checked and has no documentation trigger, because the launcher treats an absent value as `true`.
- **No per-item `test-agent`.** A wave item is classified as a large feature, but its independent test stage is deliberately replaced by the per-workspace verification-only suite on the assembled head: the same surface, once per workspace instead of once per item. An item that genuinely needs a test-design pass must say so in its plan; do not add the stage back per item.
- **Worker independence.** A worker that fails returns immediately and frees the next round's capacity; the scheduler never waits for it and never shrinks N because one item is slow.

## Assembly

- After every round, cherry-pick exactly one commit at a time onto the wave branch, in the round's pick order, inside the assembly worktree, serialized against every other cherry-pick. Announce the item in state before the cherry-pick and record the resulting head after it.
- A conflict on a path the planner listed as a mandatory shared artifact is mechanical, not a content conflict: every item in the round regenerated it from the same base, so keep the wave-branch copy (`git checkout --ours <path>`, `git add <path>`), continue the cherry-pick, and regenerate that artifact in the assembly worktree once, before the final gates, with the repository's declared command. If regeneration changes it, the orchestrator lands that as one assembly-artifact commit covering the whole wave. It carries no item's content and needs no per-item review, because the generator derives it from the commit messages already on the branch. This is the only history write outside the Follow-up Route, and it happens before the integration review so that review's `treeHash` covers it.
- Any other conflict is never resolved in an item worktree and never by amending an item commit. It opens the Follow-up Route at the wave branch head, and the repair runs outside the worker pool, so it consumes no round capacity until the follow-up commit is assembled.
- A cherry-pick that merges content cleanly is not a validation event: the item's own review and gates already ran against its base. Content changed by a follow-up, however, invalidates that item's review for the touched files.

## Final gates

Run only when the queue is drained and no round is in flight.

- **Per-workspace suite.** One `test-agent` per workspace, not per item, on the assembled head with `cwd` set to the assembly worktree, verification-only: it may not add or change tests and may not fix production code. Compare against the per-workspace baseline recorded on `<waveBase>`; new failures fail the run, pre-existing failures are the zero point and are recorded, not fixed. The owner of a failure is the item whose recorded blast radius contains the failing test file or the paths it exercises; a failure no item owns returns to `wave-planner-agent`.
- **Integration review.** `integration-review-agent` reviews cross-item surfaces only, with `cwd` set to the assembly worktree, and records the assembled `treeHash` with `recordedAt`. It is the last stage that inspects content, and nothing writes after it.
- **Readiness report.** Verify the evidence and report. It creates no commit, and any gate re-run is dispatched to `test-agent` as verification-only, or to `build-agent` when content must change.

## Follow-up Route (post-assembly)

This is the only legal repair path once an item's commit is assembled. It applies to a final-gate test failure, an `INTEGRATION_FINDINGS`, or a cherry-pick conflict.

- Base: the wave branch head at the last good assembly commit. Create a fresh worktree there and pass its path as `cwd` on every dispatch in this route:
  - `git worktree add -b followup/<itemId> <path> <base>` for a gate failure or integration finding.
  - `git worktree add -b assembly-fix/<itemId> <path> <base>` for a cherry-pick conflict.
  Record its path, branch, and base in wave state. The item occupies no worker capacity while it is repaired; the next round fills that capacity normally.
- `build-agent` repairs in that worktree. `formatter-agent` and `code-review-agent` run there too, scoped to that item.
- `commit-agent` creates exactly one commit on the branch that worktree was created with, dispatched with `workType: wave` and the launcher's wave stage set: build, review, formatter. It also needs an explicit `documentRequired` — `true` when the follow-up re-ran the document stage, `false` when documented behavior did not change — because the launcher treats an absent value as `true` and would otherwise fail the commit on a missing document record. This is a follow-up commit, not an item commit, and it is an explicit carve-out from the one-commit-per-item and one-item's-files rules.
- Cherry-pick that follow-up commit onto the wave branch. A conflict on a mandatory shared generated artifact is resolved the same way and resumes the interrupted cherry-pick afterwards.
- The integration review re-runs on the updated assembled tree and records a new `treeHash`.
- A wave with an open follow-up is not reported ready: the readiness report requires a current `INTEGRATION_PASS` for the final `treeHash`.

## Worktree cleanup

A wave owns every worktree it creates and removes all of them before the run is reported complete. This is part of the route, not an epilogue.

- Remove each item worktree (`git worktree remove <path>`) as its commit is assembled, and delete its `item/<itemId>` branch once merged with `git branch -d item/<itemId>`. Record the removal next to the item's outcome in wave state.
- Remove a follow-up worktree (`followup/<itemId>` or `assembly-fix/<itemId>`) once its commit is assembled and the integration review has re-run. Keep its branch until the user lands or drops it.
- Remove the assembly worktree after the readiness report: `git worktree remove <assemblyPath>`, then `git worktree prune`, then confirm with `git worktree list` that only the primary checkout remains. Keep the wave branch itself; deleting it would discard assembled work.
- Never remove a worktree holding unmerged commits or uncommitted changes, and never `--force` past that guard. A quarantined item's worktree and branch are part of its recorded evidence: retain them, report their exact paths and branch name with the failing evidence, and let the user decide.
- A wave with a leftover worktree that was not reported as retained is not reported ready.

## Failure routing and quarantine

Cluster failures by root cause before dispatching any repair. One dispatch per root cause, not one per failing check.

- Wrong or missing test: `test-agent` while the item is pre-commit, or the Follow-up Route after assembly, where `build-agent` repairs and `commit-agent` lands it.
- Production defect: `build-agent` for the owning item.
- Sibling breakage after assembly: `build-agent` for the item the integration review names as owner. A finding with no identifiable owner returns to `wave-planner-agent`.
- Assembled-tree test failure: use the ownership rule in *Final gates* rather than waiting for the integration review.
- Genuine spec conflict between items: `wave-planner-agent`, then the user through one `INTERVIEW_ROUND` question.
- Pre-existing red baseline: nobody. It is the delta gate's zero point and must be recorded, not fixed.
- Environment or tooling problem: `wave-planner-agent` for scheduling; move the item to the back of the ready queue and keep the other workers running.

Repairs are capped per item: the item is quarantined after the third failed repair round.

Quarantine is pre-assembly only. An item may be quarantined at any point before its commit exists; record it `QUARANTINED` in wave state, keep its branch and all its records, and report it as an explicit follow-up with the failing evidence. Quarantine is transitive: an item that depends on a quarantined item through a `contract` edge is never ready, and must be reported as blocked rather than silently dropped. A `collision` or `evidence` edge does not propagate quarantine. Once an item's commit is assembled it is never quarantined and never reverted: a failure there becomes the Follow-up Route, recorded as merged and blocked with follow-up. Never let a specialist declare quarantine, and never record one item as both committed and quarantined. Report every quarantine as it happens; it needs no user confirmation.

## Approval scope

The Plan Confirmation Gate is asked **once per run, for the scope**, not once per item. Present the roadmap scope, the ready queue, N, the expected serialization from `contract`, `collision`, and `evidence` edges, and any item that cannot become ready. Approval of that scope authorizes every item admitted to a later round from it, which is what makes backfill possible; without it the run would stop for approval on every round.

- A backfilled item never re-opens the gate on its own.
- Re-open the gate only for a new item outside the approved scope, a plan that must change user-visible behavior beyond its roadmap file, or a genuine `INTERVIEW_ROUND` decision.
- Record the approval wording in state before the first round starts.

## Invalidation

Pre-commit repairs stay inside the owning item's worktree. After a repair to item A before its commit, re-run A's own gate, its delta gate, its formatter pass, its document pass when the repair changes documented behavior, and its review, then commit. Nothing outside that worktree is invalidated, because document and formatter writes happen before review inside the worktree.

A post-assembly repair that touches an item's files requires that item's review to be re-run in the follow-up worktree, and the integration review to be re-run. Dispatch the affected gate to `test-agent` as a verification-only run or to `build-agent` when content must change; never execute a gate yourself. A post-assembly change to an already-committed item goes through the Follow-up Route as one follow-up commit and never rewrites history. No stage may write on the assembled tree after the integration review; only a follow-up worktree is writable.

The readiness report is blocked until a current `INTEGRATION_PASS` record exists for the final `treeHash`. Item commits and cherry-picks preserve content and do not invalidate it; a follow-up commit changes content and does. State the cascade in wave state so a later stage can see which evidence is stale.

## Prohibited in a wave

- Do not cap, split, or refuse a wave because the roadmap is large. `N` bounds one round; it never bounds scope.
- Do not dispatch workers one at a time, poll a running round for partial results, or start a round while another is in flight.
- Do not resolve a cherry-pick conflict yourself except for the mechanical mandatory-shared-artifact resolution defined in *Assembly*; never amend a commit, never reorder assembly by a precomputed merge order, and send every other conflict to the Follow-up Route for the owning `build-agent`.
- Do not execute a post-assembly gate yourself; dispatch it to `test-agent` or `build-agent`.
- Do not let any stage write on the assembled tree after the integration review.
- Do not quarantine an item after its commit is assembled, and do not revert committed content.
- Do not start an item whose `contract` producer is unassembled, whose paths collide with an item already admitted to its round, or whose single mutable verification resource is already held.
- Do not let a blocked or quarantined item vanish from the report, and do not quarantine work a specialist has not failed.
- Do not substitute the integration review for per-item review, or per-item review for the integration review.
- Do not dispatch an `item-runner-agent` without `cwd` set to its worktree and the shared wave `taskId` in its contract.
- Do not compare a worktree snapshot with an assembled-tree snapshot, and do not replace a snapshot to silence the guard.
- Do not dispatch a wave stage without `cwd` set to that stage's worktree.
- Do not report a wave ready while a worktree it created still exists and was not explicitly reported as retained with its path, branch, and evidence.
