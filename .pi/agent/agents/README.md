# Global Pi Agents

Reusable global agents for roadmap-driven delivery. Repository-specific architecture, package-manager, testing, formatting, documentation, and security rules belong in each repository's root `AGENTS.md`; these agent definitions apply those rules without assuming a particular stack. Every implementation request routes through the orchestrator first; only an explicit user opt-out bypasses it.

Every delegation uses Pi's `subagent` tool with `agentScope: "both"`. A project agent with the same name overrides the global role.

Worktree isolation is one rule for every orchestrator route, not a wave-only feature: small, normal, large, documentation, and wave all run in a dedicated worktree at a recorded base commit, and the orchestrator fast-forwards the commit, removes the worktree, and verifies `git worktree list` before reporting completion. Only work done without the orchestrator — a direct main-thread edit or an explicit opt-out — is applied immediately in the primary checkout.

Project agents inherit the root `AGENTS.md` handoff-style rule: use Caveman lite for routine status and completion handoffs, while keeping safety-critical, ambiguous, or detailed planning communication in normal clear language.

## Handoffs, context, and tools

Specialists declare `handoff: true` and follow [HANDOFF.md](HANDOFF.md). The personal subagent extension supports the `contract` argument, explicit `thinking`, semantic stop statuses, durable full-output/usage records, and generated code snapshots. Restart Pi after updating that extension. Markdown settings alone do not implement these runtime features. A `wave` task additionally reads [WAVE.md](WAVE.md), which owns the wave route, wave state, and repair paths.

The orchestrator keeps ignored task state, dispatches one stage per step and up to eight concurrent specialists per step (eight `item-runner-agent` workers in a wave round), and reconciles every requirement and finding. Large plans stay in their assigned roadmap file; normal plans stay in the launcher's private stage artifact. Agents read canonical sources rather than passing copies of the conversation. Native auto-compaction is explicitly enabled; no extra summarizer agent or compressor hook is required.

Current reasoning policy: large architect `max`; normal architect, builder, tester, reviewer, wave planner, and integration reviewer `high`; orchestrator and item runner `medium`; documenter and committer `low`; formatter `off`. The launcher passes these settings even with a pinned model. Provider/model support still determines actual reasoning behavior.

Use `rg` for scoped text searches, `ast-grep` for search-only structural queries, and `jq` for exact JSON projections. Do not add AST searches when a simple text search already answers the question. Browser automation is intentionally excluded from the DeepSeek specialist agents: its text snapshots do not replace tests, and the model cannot inspect its screenshots. Enable it only for an explicit task that needs text-only local browser interaction.

RTK is optional for noisy successful validation output. Preserve original commands and evidence, and read raw output whenever it is ambiguous or failed. No global rewrite hook is installed, and no source or review-diff filtering is authorized.

The personal launcher helper lives outside this repository. Stage records under the private Pi `runs` directory contain final output and usage, not entire transcripts; they are local and not automatically deleted. Do not put secrets in final reports. Never commit `.pi/state/` or `.pi/checks/`.

Compare total stage usage (input, output, cache reads/writes) and repair rates before claiming savings. RTK's output estimates are not total token usage, and a valid handoff is not proof of semantic correctness.

## Roadmap Convention

- Roadmap indexes live at `docs/roadmaps/<version>/<track>/00-roadmap.md`.
- Each checklist entry points to one feature file in the same directory and identifies whether it is complete.
- The orchestrator passes the exact roadmap index and feature-file paths to every agent that needs product or acceptance context.
- Only the architect may edit a roadmap feature file, and only for a large feature when the orchestrator explicitly assigns the detailed-plan task.

## Work Types and Routes

- **Small fix:** localized, low-risk work with explicit behavior and no architectural or product decision. Route build → document when repository documentation rules trigger → formatter → commit, all inside one route worktree on `route/<taskId>`. For documentation-only work, route document → formatter → commit in that same worktree.
- **Normal feature:** contained feature work using established patterns. Route architect-agent → plan approved → build → code review → document when documentation triggers apply → formatter → commit, all inside one route worktree on `route/<taskId>`.
- **Large feature:** cross-cutting, high-risk, migration-heavy, contract-changing, or genuinely ambiguous work. Route architect-large-agent → plan approved → build → test → code review → document → formatter → commit, all inside one route worktree on `route/<taskId>`. The large-feature architect runs the user interview and stores a full detailed plan in the assigned roadmap feature file. The documentation stage may justify non-applicability; it is not silently omitted.
- **Wave:** two or more independent large roadmap items run concurrently as a worker pool of N = 8, each worker owning one item inside its own worktree for one round, with the next round picking the next ready items until the scope is empty. The authoritative scheduler, readiness predicate, per-stage rules, dependency taxonomy, failure routing, and follow-up route live in [`WAVE.md`](WAVE.md); the list below is orientation, not the contract. Shape: wave-planner-agent (`WAVE_READY` gate) → one scope-level plan approval → repeat { pick up to N = 8 ready items → one `parallel` call of `item-runner-agent` workers, each running architect-large (plan validation) → build → document when triggered → formatter → code-review → commit inside its own worktree → cherry-pick the returned commits in pick order } until the queue drains → test-agent per workspace (verification-only delta gate) → integration-review-agent (last content inspection) → readiness report (no commit). There is no item cap and no fixed batch: roadmap size never forces sequential waves. Every edge is `contract`, `runtime`, `collision`, or `evidence`. An item is quarantined after the third failed repair round; a committed item is never reverted and its repair is a follow-up commit.

A long description or detailed user-authored plan does not by itself make a task large. The orchestrator classifies by uncertainty, risk, breadth, and contract impact, and reclassifies when implementation reveals broader scope.

Every architect plan is confirmed by the user before implementation starts: the orchestrator presents it, suspends with `AWAITING PLAN APPROVAL`, and waits for an explicit decision that the caller relays back (see the Plan Confirmation Gate and *Suspending for User Input* in [`orchestrator-agent.md`](orchestrator-agent.md)). Quarantine, cost and failure reports, follow-up routes, and reclassification are reported without waiting for a reply.

## Agent Responsibilities

- **orchestrator-agent:** classifies the task, selects the route, delegates stages, relays large-feature interview questions, and tracks evidence. It creates the route's worktree at a recorded base commit, dispatches every stage with `cwd` set to it, fast-forwards the resulting commit into the primary checkout, and removes the worktree before reporting completion. It never performs a specialist stage itself.
- **architect-agent:** produces a concise plan for a normal feature. It never implements the plan.
- **architect-large-agent:** interviews user-owned decisions and produces the detailed roadmap plan for a large feature. It never implements the plan.
- **build-agent:** implements production changes and owns focused, valuable tests for its work. It never edits roadmaps, performs independent review, or commits.
- **test-agent:** performs the additional independent test-design and execution pass used for large features or when explicitly requested. It never changes production code.
- **code-review-agent:** independently reviews the complete implementation and tests. It never fixes or commits what it reviews.
- **formatter-agent:** applies only mechanical formatting and lint fixes using repository-defined commands. It never changes behavior.
- **document-agent:** updates user and maintainer documentation when implemented behavior creates a documentation obligation. It never changes production code or roadmap plans.
- **commit-agent:** verifies required stage evidence, stages only in-scope changes, and creates the focused commit or commits the route allows: one item commit in a wave, or one follow-up commit on `followup/<itemId>` or `assembly-fix/<itemId>` when repairing committed wave content. It never repairs earlier-stage work and never assembles or cherry-picks.
- **item-runner-agent:** owns exactly one roadmap item for one round: dispatches its architect, build, document, formatter, review, and commit serially inside its own worktree, repairs within the allowed rounds, and returns one commit for the orchestrator to assemble. It is the only nested orchestrator, it shares the wave `taskId` with every stage it dispatches, and it never cherry-picks, merges, or writes state.
- **wave-planner-agent:** builds and prunes the inter-item dependency DAG, classifies every edge, and emits the ready-queue order, interface freezes, per-item path attribution, per-item blast radius, and mandatory shared artifacts. It writes no roadmap files; its artifact is orchestrator wave state. It never builds, reviews, or commits.
- **integration-review-agent:** reviews only cross-item surfaces of the assembled wave result: shared contracts, overlap zones, independently duplicated helpers, and assembled coherence. It is the last stage that inspects content. It never re-reviews an item and never fixes what it finds.
