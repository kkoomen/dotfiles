# Wave route

Read this before dispatching any wave stage. `AGENTS.md` holds the wave invariants and `orchestrator-agent.md` holds the classification and edge taxonomy; this file owns the scheduler, its state, and its repair paths.

A wave is a **slot scheduler**, not a fixed batch. The number of roadmap items in scope never bounds it and never forces a split into sequential waves: the orchestrator keeps N slots busy and refills a slot from the ready queue the moment that slot's item commits, until the queue is empty. A 40-item roadmap and a 3-item roadmap run the same way, and a slow item never idles the other slots.

## Required context

- Own `.pi/state/<waveId>.json` in addition to the per-stage task state, and use one `taskId` for the entire wave — the wave ID itself — passed unchanged to every dispatch of every item and stage, because the launcher rejects any `priorRecords` entry whose taskId differs from the dispatching contract.
- Record in state: the scope (version, track, roadmap index), the wave branch and assembly worktree, the per-workspace baseline on `<waveBase>`, and `slots[]` — for each slot its current `itemId`, `worktreePath`, branch `item/<itemId>`, its own `baseCommit`, its start time, and its stage. Also record every item's roadmap file, workspace, commit hash, repair-round count, record paths, and quarantine state; the pruned DAG with edge kinds and prune reasons; per-item path attribution (including documentation paths) and blast radius; any open follow-up (branch, base, commit, repair-round count); and the current integration-review record (`status`, `treeHash`, `recordedAt`, covered items).
- `itemId` must be a valid Git ref component and unique inside the wave. Namespace it by track when two tracks can produce the same file name — `server/01-handler-guards`, never a bare `01-handler-guards` — because it becomes both a branch name and a wave-state key.
- Pass `cwd` on every wave dispatch, equal to that stage's `worktreePath`. The contract field tells the agent where to work; the launcher's `cwd` argument is what snapshots, review digests, check-log paths, and the process working directory actually use. Never set one without the other.
- Never resolve a conflict, never amend, and never merge content on an item's behalf. The history operations you perform are the serialized cherry-pick of an already-reviewed item commit onto the wave branch, and the post-assembly follow-up cherry-picks of the Follow-up Route. A cherry-pick conflict stops that cherry-pick and opens the Follow-up Route.
- Post-assembly gate re-runs are dispatched to `test-agent` as verification-only runs, or to `build-agent` when content must change; never executed by the orchestrator.
- Snapshots are per scope: an item's worktree snapshot guards only that item's stages; the assembled tree's snapshot guards the final gates. Never compare a worktree snapshot to an assembled-tree record.
- If the repository does not ignore `.pi/worktrees/`, place worktrees outside the repo and record that path.

## Scheduler

- **Slots.** `N` defaults to 4 and may be raised to at most 8, because one `subagent` parallel call accepts at most 8 tasks and runs 4 concurrently. Set N once at the start, record it, and keep it for the run. The roadmap is never capped, split by count, or refused for being large.
- **Wave base and assembly worktree.** Before any worktree exists, fix `<waveBase>` as `git rev-parse HEAD` on a clean tree and record it. Create the one assembly worktree with `git worktree add -b <waveId> <assemblyPath> <waveBase>` and run every cherry-pick, the final gates, and the integration review there, never in the user's main checkout, which may hold uncommitted work. Record the per-workspace baseline suite result on `<waveBase>`: that is the zero point the final gate compares against.
- **Ready queue.** All `[ ]` items in the approved scope, minus items that are not ready. Re-evaluate the predicate on every slot refill — never freeze the queue at the start.
- **Readiness predicate.** An item is ready when every one of these holds:
  - No `contract` edge from a producer whose commit is not yet assembled. A consumer starts only after the defining item's commit is on the wave branch, because it needs that code, schema, or file format to exist. An interface freeze records the contract for planning; it does not let the consumer start early, and it never substitutes for the producer's commit.
  - No `collision` edge with an item that is currently in flight. A `collision` with an already-assembled item does not block: the new item branches from a head that already contains that change, so the same file is edited forward, not contested.
  - No `evidence` edge with an in-flight item that shares a single mutable verification resource — one emulator, one shared database, one fixed port. A merely shared suite runner does not block, because each item runs it in its own worktree.
  - A `runtime` edge never blocks: it orders rollout and reporting only.
- **Slot start.** In this order, and never partially:
  1. `baseCommit` = the wave branch head right now (`git rev-parse <waveId>`). Every item gets its own base; there is no shared item base.
  2. `git worktree add -b item/<itemId> <path> <baseCommit>`, with the branch name recorded in state.
  3. Record the item's baseline at that `baseCommit` inside the worktree — its own delta gate zero point, which is not the wave-base baseline.
  4. Dispatch the item route inside the slot, with `cwd` set to that worktree.
- **Stage-aligned batches.** Keep the slots in lockstep by stage rather than by item. For each stage, make **one** `subagent` call whose `tasks[]` holds one entry per slot that needs that stage, then judge each result separately. Dispatching slot 1's build, waiting, then slot 2's build is a scheduling defect: it serializes the wave and defeats the whole route. A one-entry `tasks[]` is correct only when exactly one slot is active. A slot refilled mid-run joins the next round at the earliest stage it still needs, usually its plan validation or build. A slot must never be blocked because another slot's item is at a different stage.
- **Concurrency floor.** While the ready queue holds at least N ready items, all N slots must be non-idle and their current-stage dispatches must be in flight together. Record the batch size for every round in state. A round whose batch is smaller than the number of active slots is a defect to correct immediately, not a slow run.
- **Refill.** When an item's commit is assembled onto the wave branch, remove that item's worktree, mark the slot idle, and immediately start the highest-priority ready item. Never wait for a round to finish. Priority is roadmap order unless an edge or a collision says otherwise.
- **Rolling assembly.** A commit is cherry-picked the moment it exists, one at a time, serialized. There is no assembly phase, no layer, and no global merge order: order is emergent from readiness. This is also why a repository hook that regenerates a shared artifact on every commit no longer conflicts — each item regenerates from a head that already contains every earlier item's entry — so the previous N-1 assembly-fix budget does not apply. Report any residual conflict cost instead of budgeting for it.
- **Drain.** The run ends when the ready queue is empty and every slot is idle, or when every item left is blocked or quarantined. Then run the final gates below. If anything is blocked, report it explicitly instead of reporting readiness.

## Slot route

```
architect-large-agent   validate the item's existing plan   workType: large
build-agent             implement + item tests + delta gate  workType: wave
document-agent          only when triggered                   workType: wave
formatter-agent         mechanical formatting and lint       workType: wave
code-review-agent       item scope, working tree vs baseCommit
commit-agent            one commit on item/<itemId>, then assemble
```

- **Architect.** Validate that the item's existing `# Plan` is complete and implementable and return `PLAN_READY`; it rewrites the plan only when the plan is genuinely unimplementable. It may edit only that item's own roadmap feature file. An `INTERVIEW_ROUND` pauses the whole run, because a backfill is not allowed to turn an open product decision into a silent assumption; relay the single question and resume.
- **Build.** Re-read the item's baseline, run the item's own tests plus the delta gate inside the worktree, and never commit: review reads the working tree. Build agents never merge, rebase, cherry-pick, push, or clean up worktrees.
- **Document and formatter.** Both run before review, inside the item's worktree, so the documentation and the formatting land in the item's own commit. The document dispatch may edit only that item's attributed paths. Nothing documents or formats after assembly.
- **Review.** Diff the working tree against that item's `baseCommit`, including untracked files; a commit-range diff would be empty.
- **Commit.** One `commit-agent` per item with `workType: wave`, that worktree's `expectedSnapshot`, and that worktree's records; `documentRequired` is decided per item, and the wave planner record is always in `priorRecords`. The dispatch carries exactly one item's files apart from mandatory shared generated artifacts.
- **Slot independence.** Quarantine, failure, or a blocked item frees its slot; the scheduler never waits for that item before admitting the next ready one.

## Assembly

- Cherry-pick exactly one commit at a time onto the wave branch, inside the assembly worktree, serialized against every other slot. Announce the item in state before the cherry-pick and record the resulting head after it.
- A conflict is never resolved in an item worktree and never by amending an item commit. It opens the Follow-up Route at the wave branch head, and that item's slot stays busy with the repair until the follow-up commit is assembled.
- A cherry-pick that merges content cleanly is not a validation event: the item's own review and gates already ran against its base. Content changed by a follow-up, however, invalidates that item's review for the touched files.

## Final gates

Run only when the queue is drained and every slot is idle.

- **Per-workspace suite.** One `test-agent` per workspace, not per item, on the assembled head with `cwd` set to the assembly worktree, verification-only: it may not add or change tests and may not fix production code. Compare against the per-workspace baseline recorded on `<waveBase>`; new failures fail the run, pre-existing failures are the zero point and are recorded, not fixed. The owner of a failure is the item whose recorded blast radius contains the failing test file or the paths it exercises; a failure no item owns returns to `wave-planner-agent`.
- **Integration review.** `integration-review-agent` reviews cross-item surfaces only, with `cwd` set to the assembly worktree, and records the assembled `treeHash` with `recordedAt`. It is the last stage that inspects content, and nothing writes after it.
- **Readiness report.** Verify the evidence and report. It creates no commit, and any gate re-run is dispatched to `test-agent` as verification-only, or to `build-agent` when content must change.

## Follow-up Route (post-assembly)

This is the only legal repair path once an item's commit is assembled. It applies to a final-gate test failure, an `INTEGRATION_FINDINGS`, or a cherry-pick conflict.

- Base: the wave branch head at the last good assembly commit. Create a fresh worktree there and pass its path as `cwd` on every dispatch in this route:
  - `git worktree add -b followup/<itemId> <path> <base>` for a gate failure or integration finding.
  - `git worktree add -b assembly-fix/<itemId> <path> <base>` for a cherry-pick conflict.
  Record its path, branch, and base in wave state, and hold the owning item's slot for it.
- `build-agent` repairs in that worktree. `formatter-agent` and `code-review-agent` run there too, scoped to that item.
- `commit-agent` creates exactly one commit on the branch that worktree was created with. This is a follow-up commit, not an item commit, and it is an explicit carve-out from the one-commit-per-item and one-item's-files rules.
- Cherry-pick that follow-up commit onto the wave branch. A conflict on a mandatory shared generated artifact is resolved the same way and resumes the interrupted cherry-pick afterwards.
- The integration review re-runs on the updated assembled tree and records a new `treeHash`.
- A wave with an open follow-up is not reported ready: the readiness report requires a current `INTEGRATION_PASS` for the final `treeHash`.

## Failure routing and quarantine

Cluster failures by root cause before dispatching any repair. One dispatch per root cause, not one per failing check.

- Wrong or missing test: `test-agent` while the item is pre-commit, or the Follow-up Route after assembly, where `build-agent` repairs and `commit-agent` lands it.
- Production defect: `build-agent` for the owning item.
- Sibling breakage after assembly: `build-agent` for the item the integration review names as owner. A finding with no identifiable owner returns to `wave-planner-agent`.
- Assembled-tree test failure: use the ownership rule in *Final gates* rather than waiting for the integration review.
- Genuine spec conflict between items: `wave-planner-agent`, then the user through one `INTERVIEW_ROUND` question.
- Pre-existing red baseline: nobody. It is the delta gate's zero point and must be recorded, not fixed.
- Environment or tooling problem: `wave-planner-agent` for scheduling; move the item to the back of the ready queue and keep the other slots running.

Repairs are capped per item: the item is quarantined after the third failed repair round.

Quarantine is pre-assembly only. An item may be quarantined at any point before its commit exists; record it `QUARANTINED` in wave state, keep its branch and all its records, free its slot, and report it as an explicit follow-up with the failing evidence. Quarantine is transitive: an item that depends on a quarantined item through a `contract` edge is never ready, and must be reported as blocked rather than silently dropped. A `collision` or `evidence` edge does not propagate quarantine. Once an item's commit is assembled it is never quarantined and never reverted: a failure there becomes the Follow-up Route, recorded as merged and blocked with follow-up. Never let a specialist declare quarantine, and never record one item as both committed and quarantined. Report every quarantine as it happens; it needs no user confirmation.

## Approval scope

The Plan Confirmation Gate is asked **once per run, for the scope**, not once per item. Present the roadmap scope, the ready queue, N, the expected serialization from `contract`, `collision`, and `evidence` edges, and any item that cannot become ready. Approval of that batch authorizes every item admitted to a slot afterwards from the same recorded scope, which is what makes backfill possible; without it the run would stop for approval on every refill.

- A backfilled item never re-opens the gate on its own.
- Re-open the gate only for a new item outside the approved scope, a plan that must change user-visible behavior beyond its roadmap file, or a genuine `INTERVIEW_ROUND` decision.
- Record the approval wording in state before the first slot starts.

## Invalidation

Pre-commit repairs stay inside the owning item's worktree. After a repair to item A before its commit, re-run A's own gate, its delta gate, its formatter pass, its document pass when the repair changes documented behavior, and its review, then commit. Nothing outside that worktree is invalidated, because document and formatter writes happen before review inside the worktree.

A post-assembly repair that touches an item's files requires that item's review to be re-run in the follow-up worktree, and the integration review to be re-run. Dispatch the affected gate to `test-agent` as a verification-only run or to `build-agent` when content must change; never execute a gate yourself. A post-assembly change to an already-committed item goes through the Follow-up Route as one follow-up commit and never rewrites history. No stage may write on the assembled tree after the integration review; only a follow-up worktree is writable.

The readiness report is blocked until a current `INTEGRATION_PASS` record exists for the final `treeHash`. Item commits and cherry-picks preserve content and do not invalidate it; a follow-up commit changes content and does. State the cascade in wave state so a later stage can see which evidence is stale.

## Prohibited in a wave

- Do not cap, split, or refuse a wave because the roadmap is large. The slot count is fixed; the queue is not.
- Do not wait for a slow item before refilling an idle slot.
- Do not resolve a cherry-pick conflict yourself, amend a commit, or reorder assembly by a precomputed merge order; order is emergent, and a conflict opens the Follow-up Route for the owning `build-agent`.
- Do not execute a post-assembly gate yourself; dispatch it to `test-agent` or `build-agent`.
- Do not let any stage write on the assembled tree after the integration review.
- Do not quarantine an item after its commit is assembled, and do not revert committed content.
- Do not start an item whose `contract` producer is unassembled, whose paths collide with an in-flight item, or whose single mutable verification resource is already held.
- Do not let a blocked or quarantined item vanish from the report, and do not quarantine work a specialist has not failed.
- Do not substitute the integration review for per-item review, or per-item review for the integration review.
- Do not compare a worktree snapshot with an assembled-tree snapshot, and do not replace a snapshot to silence the guard.
- Do not dispatch a wave stage without `cwd` set to that stage's worktree.
