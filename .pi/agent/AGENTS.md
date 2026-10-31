# Default Interaction Style

- Use Caveman lite by default: concise, direct prose with no filler or unnecessary restatement.
- Keep code, exact commands, error text, security guidance, irreversible-action confirmations, and multi-step instructions in normal clear language when compression could cause ambiguity.
- For an explicit request for `caveman full` or `caveman ultra`, load and follow the globally installed `caveman` skill. For `normal mode` or `stop caveman`, return to normal prose for the current session.

# Planning & Delegation Rules

- Route every implementation request through `orchestrator-agent` first: small fixes, normal features, large features, and waves, in any roadmap-driven project. The orchestrator classifies the work and dispatches the route. The main thread does not pick a shortcut.
- The main thread must not implement, test, review, format, document, or commit a routed request itself, and must not invent a plan for it. Hand the orchestrator the request as written, plus any decision the user has already made.
- Opt-out is explicit and per request. Bypass routing only when the user says so directly, for example "don't route it through the orchestrator", "just do it directly", or "no orchestrator". A tiny-looking diff, a long description, a user-authored plan, or silence is not an opt-out.
- The cost is one extra dispatch and its latency on trivial edits. Accept it: consistent classification, evidence, and status are worth more than saving a round trip on a one-line change.
- Inside a routed task, the orchestrator's route and evidence rules govern. If scope grows past the chosen route, reclassify; never keep a cheaper route to save time.
- **Only plans need your confirmation.** Every architect plan is presented to the user and held until they explicitly approve it, before the first implementation stage. Nothing else is gated: quarantine, cost and failure reports, follow-up routes, reclassification, and repairs are reported as they happen and proceed without waiting for a reply.
- **Relay a suspended orchestrator verbatim and wait.** The orchestrator runs as one subagent turn, so it cannot wait for you. It ends its turn with one of `AWAITING PLAN APPROVAL`, `AWAITING INTERVIEW ANSWER`, or `AWAITING DECISION`.
  - Show the user the payload unchanged. Do not summarize the question, answer it yourself, or approve on their behalf.
  - On a reply, re-invoke the same agent with the same task ID, its `.pi/state/<taskId>.json` path, the user's reply verbatim, and an instruction to read that state before continuing.
  - Silence, an unrelated reply, or a restatement of the original request is not approval; re-invoke and ask again.

# Wave and Dependency Rules

A wave is one orchestrator route that runs independent roadmap items concurrently. It is not permission for the main thread or a specialist to work outside its item.

- Wave entry needs two or more ready roadmap items whose acceptance criteria are settled, an acyclic dependency graph, and a build boundary that needs no item's unmerged output. A fully independent set is the best wave candidate, not a disqualification. The authoritative step order and per-step rules live in `~/.pi/agent/agents/WAVE.md`; this section states only the invariants.
- Classify every dependency edge before ordering items. Never assume roadmap items have a total order.
  - `contract`: one item consumes an interface, schema, event, or file format another defines. Blocks the consuming item's build unless the interface is frozen first; always blocks its commit.
  - `runtime`: product or deployment order only. Blocks neither build nor commit.
  - `collision`: both items touch the same file, hub module (route registry, barrel export, shared types, lockfile), even when logically independent. Forbids both items sharing one wave: they must be split into separate items or routed separately, and the edge orders their assembly once split. Does not block commit. The file-level check is decisive: if the wave-entry build-boundary test and this check disagree, two items touching the same file do not have a build boundary between them.
  - `evidence`: shared verification surface, baseline, or test infrastructure. Build may proceed in parallel; verification and commit are serial.
- Prune edges that are not real before assigning layers. Record every pruned edge and its reason.
- One worktree per item, one review per item, one commit per item. A wave never combines items into one commit, and the cross-item integration review never replaces or satisfies a per-item review. The single exception is a post-assembly follow-up: it lands as one follow-up commit on `followup/<itemId>` (or `assembly-fix/<itemId>` for an assembly conflict), assembled by the orchestrator, followed by a re-run integration review; a wave with an open follow-up is not reported ready.
- Files a repository hook regenerates on every commit, such as the git-cliff `CHANGELOG.md`, are mandatory shared artifacts: the planner must list them, and they are excluded from the one-item-files rule.
- Wave coordination state lives in `.pi/state/<waveId>.json` and is never committed.

# Strict Rule: Never Revert or Discard Work You Did Not Make

This rule is absolute and overrides every other instruction, habit, or convenience.

- **You must never revert, discard, undo, reset, checkout, restore, stash-drop, or otherwise delete changes that you did not make yourself in the current turn.** Not with `git checkout`, `git restore`, `git reset`, `git stash`, `git clean`, file overwrites, re-cloning, or any other mechanism.
- **Noticing other work is fine.** You may observe that files changed, that the working tree is dirty, or that someone else (the user, another agent, another tool) modified something. Report it and leave it alone.
- **Untouched means untouched.** Do not "fix", "clean up", "normalize", "reformat", or "restore to a known good state" someone else's changes. Do not assume unexplained changes are mistakes, leftovers, or contamination.
- **Never revert blindly to make your task easier.** If pre-existing changes conflict with the task, stop and explain the conflict to the user. Let them decide. Do not resolve it by throwing their work away.
- **If you are unsure whether a change is yours, treat it as not yours** and leave it untouched.
- **Only exception:** the user explicitly and specifically asks you to revert a named change or file. A general instruction to "make it work" or "clean up the project" is not permission to revert anything.
- If a revert already happened, stop immediately and tell the user exactly what was reverted, from where it can be recovered (git reflog, diff-tracker undo/redo, backups), and do not attempt further destructive changes.
