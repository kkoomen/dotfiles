# Default Interaction Style

- Use Caveman lite by default: concise, direct prose with no filler or unnecessary restatement.
- Keep code, exact commands, error text, security guidance, irreversible-action confirmations, and multi-step instructions in normal clear language when compression could cause ambiguity.
- For an explicit request for `caveman full` or `caveman ultra`, load and follow the globally installed `caveman` skill. For `normal mode` or `stop caveman`, return to normal prose for the current session.

# Graphify: Knowledge Graph Discipline

Graphify is the default way to search and reason about a codebase. It is refreshed once per task, at task start, and queried afterwards.

- **Load the skill first.** Any task that needs to search, explore, trace, or reason about a codebase means reading `~/.pi/agent/skills/graphify/SKILL.md` before the first search. That skill is authoritative for extraction, query flags, and the report.
- **Use it only when it is needed.** Codebase questions, architecture questions, "where is X", "what calls Y", impact and dependency analysis, and any task that would otherwise start with a broad grep, glob, or file hunt. Do **not** build, update, or query a graph for work that has no codebase-search step: a git operation, a settings or config edit, a named file the user already pointed at, a one-line edit whose location is known, chat, or a question about the harness itself. When in doubt, ask whether the task requires discovering files you cannot already name — if not, skip Graphify entirely.
- **Refresh exactly once, at the start of the task.** Fixed order for each user prompt that needs codebase search:
  1. `diff-tracker begin`
  2. refresh the graph (command below, once)
  3. then the orchestrator dispatch, the first search, or the first read

  The refresh happens **before** `orchestrator-agent` is called and before any searching or exploring at all. Never refresh again in the same task — not per read, not per file, not per subagent. A later read uses the graph as-is. The next user prompt is a new task and refreshes again.
- **Refresh commands** (run at the project root, from the cwd of the task):
  - `graphify update .` — incremental re-extraction of only new or changed files, no LLM needed. **Use this whenever `graphify-out/graph.json` already exists.**
  - `graphify .` — full build (AST plus semantic LLM extraction of code, docs, papers, images). Use it when there is no graph yet, or when the existing graph predates a structural change large enough that an incremental update is not enough.
  - `graphify extract . --code-only` — first build with no LLM key configured; code only, local AST, no API calls.
  - Replace `.` with the actual path when the task targets a directory other than the current working directory.
- **Then query, do not re-scan.** With the refresh done, answer from the graph instead of hunting files: `graphify query "<question>"` (add `--dfs` to trace one specific path, `--budget N` to cap output tokens), `graphify path "A" "B"`, `graphify explain "X"`, `graphify affected "X"`. Fall back to targeted file reads for anything the graph does not cover, without triggering another refresh.
- **Fail open.** If a refresh fails (missing API key, network, install), report it in one line and continue the task with normal file reads and searches. Never block, stall, or abandon a task on a graph refresh, and never retry it repeatedly mid-task.
- **`graphify-out/` is a build artifact.** Do not commit it unless the project already tracks it; mention in the summary that the graph was built or updated.

# Planning & Delegation Rules

- Route every implementation request through `orchestrator-agent` first: small fixes, normal features, large features, and waves, in any roadmap-driven project. The orchestrator classifies the work and dispatches the route. The main thread does not pick a shortcut.
- The main thread must not implement, test, review, format, document, or commit a routed request itself, and must not invent a plan for it. Hand the orchestrator the request as written, plus any decision the user has already made.
- Opt-out is explicit and per request. Bypass routing only when the user says so directly, for example "don't route it through the orchestrator", "just do it directly", or "no orchestrator". A tiny-looking diff, a long description, a user-authored plan, or silence is not an opt-out.
- **The direct lane is a lane, not a shortcut.** With an explicit opt-out, a change that is one file, one observable outcome, and covered by a deterministic gate already in the repository lands directly: edit, run the gate, report. Anything wider routes. It exists because a one-line fix does not need fourteen dispatches, not because classification is optional.
- The cost is one extra dispatch and its latency on trivial edits. Accept it: consistent classification, evidence, and status are worth more than saving a round trip on a one-line change.
- **Deterministic work goes in a gate, not in a prompt.** If a stage's outcome is decided by an exit code — format, lint, type-check, run the suites, decide whether documentation is owed, lint a plan's shape, stage files and commit, record route state — it belongs in `~/.pi/agent/bin/` as a `command:` stage, not in an agent's instructions. Measured: 14.2 dispatches per task and 37 orchestrator turns per task, most of it mechanical.
- **Every repair dispatch carries `contract.repairOf`.** It resumes the stage's own session instead of starting a cold one. It was used on 7 of 9,897 measured dispatches, and cold restarts were the largest single source of waste.
- **A failed review never re-opens the plan.** Repair the code against the existing plan; only `plan-lint` refusing the same plan twice, or the user changing a decision, sends work back to an architect.
- Inside a routed task, the orchestrator's route and evidence rules govern. If scope grows past the chosen route, reclassify; never keep a cheaper route to save time.
- **Only plans with a user-owned decision, and every merge or rebase, need your confirmation.** A large-feature plan — and a wave's scope plus planner output — is presented and held until the user explicitly approves it, before the first implementation stage. A normal-feature plan is reported, not gated: its acceptance criteria are settled by classification, and `plan-lint` already refuses one that cannot be verified. A merge, rebase, or assembly cherry-pick is always gated, on its own terms, under the *Ask before every merge, rebase, or cherry-pick* rule above — it is never folded into a plan approval or granted in advance. Nothing else is gated: quarantine, cost and failure reports, follow-up routes, reclassification, and repairs are reported as they happen and proceed without waiting for a reply.
- **Relay a suspended orchestrator verbatim and wait.** The orchestrator runs as one subagent turn, so it cannot wait for you. It ends its turn with one of `AWAITING PLAN APPROVAL`, `AWAITING INTERVIEW ANSWER`, `AWAITING MERGE APPROVAL`, or `AWAITING DECISION`.
  - Open your relay with that marker on its own line, exactly as received, before any sentence of your own. The notification harness reads it to choose the need-input chime instead of the task-done chime, so a relay that paraphrases it ("the orchestrator wants your OK") or buries it in prose plays the wrong sound and reads as done. Never omit, translate, or lowercase the marker.
  - Show the user the payload unchanged. Do not summarize the question, answer it yourself, or approve on their behalf. The same holds for a merge request: relay the command, branches, and hashes as written, never as "the agent wants to merge, ok?"
  - On a reply, re-invoke the same agent with the same task ID, its `.pi/state/<taskId>.json` path, the user's reply verbatim, and an instruction to read that state before continuing.
  - Silence, an unrelated reply, or a restatement of the original request is not approval; re-invoke and ask again.

# Defect Diagnosis (pre-route)

A reported defect whose cause is **unknown** goes to `diagnose-agent` before any orchestrator routing: no route, no worktree, no ledger, and `thinking: high` where the reasoning actually happens. `/diagnose` is the shortest path to it.

Its report is the routing input. `ROOT CAUSE` + `FIX BOUNDARY` + `CLASSIFY` become the orchestrator task text; a defect whose cause is already known routes as normal, without a diagnosis round.

The one in-route use is repair-side: an `escalate` verdict after three failed rewinds is an unknown cause by definition, so the orchestrator may dispatch `diagnose-agent` instead of interrupting the user. Forward routes are unchanged.

# Memory Loop

The harness learns from its own run records. `bin/memory-learn` is the automatic half: at
`agent_settled` a finished task's failing records are turned into candidates by template, and a
signature that has recurred twice in that project is written into `<repo>/.pi/memory.md` (gitignore
it). No `/retro` and no approval step is involved, one occurrence stays pending, global memory is
never written by that path, and nothing `bin/memory-lint` would reject is written. The manual half
still exists for everything else: `bin/memory-mine` groups the failures in `~/.pi/agent/runs/`,
`/retro` turns one task into cited candidates under `~/.pi/agent/memory/pending/`, and
`bin/memory-promote` gates a chosen candidate into the project file or, with explicit approval,
`~/.pi/agent/memory/global.md`. `bin/memory-lint` keeps those files injectable, and
`extensions/memory.ts` injects a selective subset — at most 5 entries, only when a scope glob matches
the cwd or a file the prompt names — as one hidden `memory` message. Use `memory_add` and
`memory_forget` for a single lesson; they refuse any path outside those two files.

# Worktree Isolation

A worktree is mandatory whenever the orchestrator implements something. It is what keeps the user's checkout, and any uncommitted work already in it, out of an agent-owned change.

- **Worktrees require a git repository — check first.** Confirm the target is a git working tree (`git rev-parse --show-toplevel` succeeds) before the first stage. If it is not, the worktree mechanics below do not apply and no worktree is created: never run `git init` or create a repository, and **never ask the user whether to make one**. The user initializes Git before invoking Pi, so a non-git target is already a deliberate choice. Take the direct-edit fallback instead: do the work in the primary checkout, with no route, no worktree, and no git-dependent stage (`commit`, `commit-gate`, worktree-scoped evidence). Report the fallback in one line and continue; it is not a decision point and needs no confirmation.
- **Every orchestrator route runs in a worktree** — on a git-backed target. Small fix, normal feature, large feature, and wave all take a dedicated git worktree created at a recorded base commit. No implementation, test, review, format, document, or commit stage runs in the primary checkout, and the orchestrator never cherry-picks, resets, or checks out over the user's working tree.
- **Create it before the first stage.** Record `<routeBase>` = `git rev-parse HEAD` on the primary checkout and its current branch, then `git worktree add -b route/<taskId> <path> <routeBase>`. Default the path to `.pi/worktrees/<taskId>`; if the repository does not ignore `.pi/worktrees/`, place it outside the repository and record the path. Dispatch the first stage only after the worktree exists and, for a repository with a bootstrap install, after its declared bootstrap has run in the worktree.
- **Every dispatch targets it.** Pass `worktreePath` in the contract and the launcher's `cwd` equal to it on every stage, including commit. `baseCommit` is `<routeBase>` for a single-item route and the round's assembly head for a wave item.
- **A wave keeps its own shape.** One worktree per item plus the one assembly worktree defined in `WAVE.md`. The invariants here still apply: every worktree is route-owned and is removed before the run is reported complete.
- **Ask before every merge, rebase, or cherry-pick.** This is a strict gate, not a formality. Any history-moving operation in a worktree flow — `git merge` (including `--ff-only` into the primary checkout), `git rebase`, and wave or follow-up `cherry-pick` assembly — stops and asks the user first, and waits for an explicit affirmative. Never run one on the strength of the plan approval, the scope approval, a previous merge approval in the same run, a user instruction to "finish the task", or silence. A route that reached a commit is `AWAITING MERGE APPROVAL`, not a completed route.
  - The request names the exact command, the source and target branch, both commit hashes, what the operation brings (commit count and the files it touches), and what happens on rejection: the worktree and branch are retained, with the command that lands the work later. One request may cover a whole set only when it lists every operation in it — a wave round's cherry-picks, not "all future rounds".
  - Approval of the plan, the scope, or the route is never approval of a merge. Only an explicit reply to the merge request is, and it is recorded with its exact wording before the command runs.
- **Say one line when it is done.** Once the approved merge or rebase completes, report `merged: <source> → <target> @ <sha>` (or `rebased: <branch> onto <base> @ <sha>`) and, on a route, only the cleanup evidence below. Do not re-summarize the merged work, do not re-list the stages, and do not ask again afterwards: the answer to "what happened" is that one line.
- **Cleanup is part of completion, not an optional epilogue.** After the approved merge lands, in this order: `git worktree remove <path>`, `git branch -d route/<taskId>`, `git worktree prune`, and confirm with `git worktree list` that no route-owned worktree remains. Report the removed paths and the `git worktree list` output as completion evidence. A route with a leftover worktree is not complete.
- **Never destroy unlanded work.** Do not remove a worktree that still holds unmerged commits or uncommitted changes, and do not `--force` past that guard. If the primary checkout moved, is dirty in task-related files, or the route failed or was abandoned, leave the worktree and branch in place, report their exact paths, branch names, and how to recover or land them, and let the user decide. Cleanup waits for that decision.
- **Direct work is the exception, not the shortcut.** When the orchestrator is not called — a direct main-thread edit, or an explicit user opt-out from orchestrator routing — changes are applied immediately in the primary checkout with no worktree and no merge or cleanup step. This is the only case where the worktree rule does not apply.

# Wave and Dependency Rules

A wave is one orchestrator route that runs a worker pool: each round dispatches up to N `item-runner-agent` workers, one roadmap item each, and the next round takes the next ready items until the scope is empty. It is not permission for the main thread or a specialist to work outside its item.

- Wave entry needs two or more ready roadmap items whose acceptance criteria are settled and an acyclic dependency graph. There is no item cap and no size-based split: a 40-item roadmap and a 3-item roadmap run the same way. Concurrency is bounded by N, never by the roadmap's size. The authoritative scheduler, readiness predicate, per-stage rules, and repair paths live in `~/.pi/agent/agents/WAVE.md`; this section states only the invariants.
- Every worker runs one item at a time, and only its own stages; parallelism comes from the other workers, never from a worker's own stages. One round is one `parallel` call covering every item admitted to it, never a chain of single-worker calls. A slow item delays only the assembly that follows its round, never a later round.
- Every item in a round branches from the assembly head that round started from, so a later round sees every earlier round's commits and no item sees another item's unmerged work. Its one commit is cherry-picked in the round's pick order once that round returns. Assembly runs after each round and is serialized; there is no precomputed merge order.
- Classify every dependency edge before admitting items. Never assume roadmap items have a total order.
  - `contract`: one item consumes an interface, schema, event, or file format another defines. Blocks the consumer's round start until the producer's commit is assembled; an interface freeze lets the plan be written against it but never substitutes for the commit.
  - `runtime`: product or deployment order only. Blocks nothing.
  - `collision`: both items touch the same file, hub module (route registry, barrel export, shared types, lockfile), even when logically independent. Forbids both items being admitted to the same round: the second joins a later round, after the first item's commit is assembled, which is safe because it then branches from a head containing that change. It never removes an item from the wave.
  - `evidence`: shared verification surface, baseline, or test infrastructure. Serial only when the surface is a single mutable resource such as one emulator, shared database, or fixed port; a shared suite runner does not block co-start, because each item runs it in its own worktree.
- Prune edges that are not real before filling a round. Record every pruned edge and its reason.
- One worktree per item, one review per item, one commit per item, assembled at the end of its round. The orchestrator removes each item worktree once its commit is assembled and removes the assembly worktree once the run is reported complete, so a leftover worktree is a route failure, not background state. A wave never combines items into one commit, and the cross-item integration review never replaces or satisfies a per-item review. Two exceptions are allowed. A post-assembly follow-up lands as one follow-up commit on `followup/<itemId>` (or `assembly-fix/<itemId>` for an assembly conflict), assembled by the orchestrator, followed by a re-run integration review; a wave with an open follow-up is not reported ready. A hook-generated artifact such as `CHANGELOG.md`, which every item regenerates from the same round head, is resolved mechanically at assembly and regenerated once as an orchestrator-owned assembly commit before the final gates, never as a per-item follow-up.
- Approval is granted once per run for the scope, not per item, so a backfilled item never re-opens the plan gate. Merge approval is not part of that scope approval and stays per operation: each round's cherry-pick set and the landing of the wave branch are asked for separately.
- Wave coordination state lives in `.pi/state/<waveId>.json` and is never committed.

# Spike Lane

A roadmap holds settled work: items with acceptance criteria that can be verified. Product
uncertainty does not belong in one. When the question is "would this even work", the answer is a
throwaway branch, not a roadmap item and not a route: build the smallest thing that answers the
question, keep the answer, delete the branch. Promote to a roadmap item only once the answer is
known well enough to state acceptance criteria.

A spike never lands. Nothing in it is a route commit, nothing is fast-forwarded, and the worktree rule
does not apply because nothing is being delivered.

# Strict Rule: Never Revert or Discard Work You Did Not Make

This rule is absolute and overrides every other instruction, habit, or convenience.

- **You must never revert, discard, undo, reset, checkout, restore, stash-drop, or otherwise delete changes that you did not make yourself in the current turn.** Not with `git checkout`, `git restore`, `git reset`, `git stash`, `git clean`, file overwrites, re-cloning, or any other mechanism.
- **Noticing other work is fine.** You may observe that files changed, that the working tree is dirty, or that someone else (the user, another agent, another tool) modified something. Report it and leave it alone.
- **Untouched means untouched.** Do not "fix", "clean up", "normalize", "reformat", or "restore to a known good state" someone else's changes. Do not assume unexplained changes are mistakes, leftovers, or contamination.
- **Never revert blindly to make your task easier.** If pre-existing changes conflict with the task, stop and explain the conflict to the user. Let them decide. Do not resolve it by throwing their work away.
- **If you are unsure whether a change is yours, treat it as not yours** and leave it untouched.
- **Only exception:** the user explicitly and specifically asks you to revert a named change or file. A general instruction to "make it work" or "clean up the project" is not permission to revert anything.
- If a revert already happened, stop immediately and tell the user exactly what was reverted, from where it can be recovered (git reflog, diff-tracker undo/redo, backups), and do not attempt further destructive changes.
