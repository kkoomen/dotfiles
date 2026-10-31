# Global Pi Agents

Reusable global agents for roadmap-driven delivery. Repository-specific architecture, package-manager, testing, formatting, documentation, and security rules belong in each repository's root `AGENTS.md`; these agent definitions apply those rules without assuming a particular stack. Every implementation request routes through the orchestrator first; only an explicit user opt-out bypasses it.

Every delegation uses Pi's `subagent` tool with `agentScope: "both"`. A project agent with the same name overrides the global role.

Project agents inherit the root `AGENTS.md` handoff-style rule: use Caveman lite for routine status and completion handoffs, while keeping safety-critical, ambiguous, or detailed planning communication in normal clear language.

## Handoffs, context, and tools

Specialists declare `handoff: true` and follow [HANDOFF.md](HANDOFF.md). The personal subagent extension supports the `contract` argument, explicit `thinking`, semantic stop statuses, durable full-output/usage records, and generated code snapshots. Restart Pi after updating that extension. Markdown settings alone do not implement these runtime features.

The orchestrator keeps ignored task state, dispatches one stage at a time, and reconciles every requirement and finding. Large plans stay in their assigned roadmap file; normal plans stay in the launcher's private stage artifact. Agents read canonical sources rather than passing copies of the conversation. Native auto-compaction is explicitly enabled; no extra summarizer agent or compressor hook is required.

Current reasoning policy: large architect `max`; normal architect, builder, tester, reviewer, wave planner, and integration reviewer `high`; orchestrator, documenter, committer `low`; formatter `off`. The launcher passes these settings even with a pinned model. Provider/model support still determines actual reasoning behavior.

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

- **Small fix:** localized, low-risk work with explicit behavior and no architectural or product decision. Route build → document when repository documentation rules trigger → formatter → commit. For documentation-only work, route document → formatter → commit.
- **Normal feature:** contained feature work using established patterns. Route architect-agent → build → code review → document when documentation triggers apply → formatter → commit.
- **Large feature:** cross-cutting, high-risk, migration-heavy, contract-changing, or genuinely ambiguous work. Route architect-large-agent → build → test → code review → document → formatter → commit. The large-feature architect runs the user interview and stores a full detailed plan in the assigned roadmap feature file. The documentation stage may justify non-applicability; it is not silently omitted.
- **Wave:** two or more independent large roadmap items run concurrently. Route architect-large-agent x N (parallel) → wave-planner-agent (`WAVE_READY` gate) → build-agent x N (one worktree each on `item/<id>`, no commit) → document-agent x N when triggered (inside each worktree) → formatter-agent x N (inside each worktree) → code-review-agent x N (one item each, working tree against `baseCommit`) → commit-agent x N (one commit per item on `item/<id>`) → orchestrator cherry-picks in DAG order → test-agent per workspace on the assembled tree (verification-only delta gate) → integration-review-agent (last content inspection) → readiness report (creates no commit). Requires a pruned dependency DAG of at least two layers and disjoint deployables. Every edge is `contract`, `runtime`, `collision`, or `evidence`; items are never assigned a blanket total order. Layers order assembly, not build: every item builds in parallel, and two items that need the same colliding hub file stay out of one wave unless the planner splits them. Files a repository hook regenerates on every commit, such as the git-cliff `CHANGELOG.md`, are mandatory shared artifacts excluded from the one-item-files rule. An item is quarantined after the third failed repair round; once committed, it is never reverted and a failure becomes a follow-up route on the committed content. **Follow-up route (post-assembly):** the only repair path once item commits exist, for a step-8 conflict, a step-9 failure, or a step-10 `INTEGRATION_FINDINGS` — a fresh worktree at the last good assembly commit, build-agent repair, formatter and code review in that worktree, exactly one follow-up commit on `followup/<itemId>` (or `assembly-fix/<itemId>` for a conflict), an orchestrator cherry-pick onto the wave branch, then a re-run integration review recording a new `treeHash`. A follow-up commit is not an item commit and is the explicit carve-out from one commit per item. A wave with an open follow-up is not reported ready: readiness requires a current `INTEGRATION_PASS` for the final `treeHash`.

A long description or detailed user-authored plan does not by itself make a task large. The orchestrator classifies by uncertainty, risk, breadth, and contract impact, and reclassifies when implementation reveals broader scope.

## Agent Responsibilities

- **orchestrator-agent:** classifies the task, selects the route, delegates stages, relays large-feature interview questions, and tracks evidence. It never performs a specialist stage itself.
- **architect-agent:** produces a concise plan for a normal feature. It never implements the plan.
- **architect-large-agent:** interviews user-owned decisions and produces the detailed roadmap plan for a large feature. It never implements the plan.
- **build-agent:** implements production changes and owns focused, valuable tests for its work. It never edits roadmaps, performs independent review, or commits.
- **test-agent:** performs the additional independent test-design and execution pass used for large features or when explicitly requested. It never changes production code.
- **code-review-agent:** independently reviews the complete implementation and tests. It never fixes or commits what it reviews.
- **formatter-agent:** applies only mechanical formatting and lint fixes using repository-defined commands. It never changes behavior.
- **document-agent:** updates user and maintainer documentation when implemented behavior creates a documentation obligation. It never changes production code or roadmap plans.
- **commit-agent:** verifies required stage evidence, stages only in-scope changes, and creates the focused commit or commits the route allows: one item commit in a wave, or one follow-up commit on `followup/<itemId>` or `assembly-fix/<itemId>` when repairing committed wave content. It never repairs earlier-stage work and never assembles or cherry-picks.
- **wave-planner-agent:** builds and prunes the inter-item dependency DAG, classifies every edge, and emits layers, interface freezes, per-item path attribution, per-item blast radius, and merge order. It writes no roadmap files; its artifact is orchestrator wave state. It never builds, reviews, or commits.
- **integration-review-agent:** reviews only cross-item surfaces of the assembled wave result: shared contracts, overlap zones, independently duplicated helpers, and assembled coherence. It is the last stage that inspects content. It never re-reviews an item and never fixes what it finds.
