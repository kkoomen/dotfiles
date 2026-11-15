# Global Pi Agents

Reusable global agents for roadmap-driven delivery. Repository-specific architecture, package-manager, testing, formatting, documentation, and security rules belong in each repository's root `AGENTS.md`; these agent definitions apply those rules without assuming a particular stack. Every implementation request routes through the orchestrator first; only an explicit user opt-out bypasses it.

Every delegation uses Pi's `subagent` tool with `agentScope: "both"`. A project agent with the same name overrides the global role.

Worktree isolation is one rule for every orchestrator route, not a wave-only feature: small, normal, large, documentation, and wave all run in a dedicated worktree at a recorded base commit, and the orchestrator fast-forwards the commit, removes the worktree, and verifies `git worktree list` before reporting completion. Only work done without the orchestrator — a direct main-thread edit or an explicit opt-out — is applied immediately in the primary checkout.

Project agents inherit the root `AGENTS.md` handoff-style rule: use Caveman lite for routine status and completion handoffs, while keeping safety-critical, ambiguous, or detailed planning communication in normal clear language.

## Handoffs, context, and tools

Specialists declare `handoff: true` and follow [HANDOFF.md](HANDOFF.md). The one exception is `diagnose-agent` (`handoff: false`): it runs **before** the orchestrator, so no `taskId`, no `.pi/state/<taskId>.json` ledger, and no contract exist to hand off into. It returns a plain report instead, and that report is what the orchestrator later takes as its task text. The personal subagent extension supports the `contract` argument, explicit `thinking`, semantic stop statuses, durable full-output/usage records, and generated code snapshots. Restart Pi after updating that extension. Markdown settings alone do not implement these runtime features. A `wave` task additionally reads [WAVE.md](WAVE.md), which owns the wave route, wave state, and repair paths.

Three launcher behaviours are worth knowing because they change how a route behaves:

- **Warm repair.** A dispatch carrying `contract.repairOf` resumes the stage's own session for that `(taskId, agent, itemId)` under `runs/stage-sessions/`, instead of starting a cold process. Pass `repairOf` on every repair round; without it, a repair costs a full restart.
- **Command stages.** An agent whose frontmatter declares `command:` is not a model. The launcher runs that shell command in the dispatch `cwd` and records the JSON the command prints. `formatter-agent` uses this: format, lint, and type-check are deterministic tool calls, so paying a reasoning model for them was pure waste — and because the stage writes, each rerun invalidated the review behind it. See `bin/mechanical-gate`.
- **Accounting, not ceilings.** `runs/.spend.json` keeps a month-to-date total, shown by `/context-guard`, so cost claims stay checkable. Nothing is refused or interrupted because of it — there is no spend cap and no turn cap.

The orchestrator keeps ignored task state, dispatches one stage per step and up to eight concurrent specialists per step (eight `item-runner-agent` workers in a wave round), and reconciles every requirement and finding. Large plans stay in their assigned roadmap file; normal plans stay in the launcher's private stage artifact. Agents read canonical sources rather than passing copies of the conversation. Native auto-compaction is explicitly enabled; no extra summarizer agent or compressor hook is required.

Current reasoning policy on `deepseek-flash`, which supports exactly four levels — `off`, `low`, `high`, `max` (`minimal`, `medium`, and `xhigh` are unmapped on this model; Pi clamps `medium` up to `high` and `minimal` down to `low`, so never write them):

| level | agents |
|---|---|
| `max` | `architect-large-agent` — plan authoring is the one stage where a missed consideration costs a repair round, and the level costs $0.03/plan |
| `high` | `architect-large-brisk-agent` (second attempt only), `architect-agent`, `build-agent`, `test-agent` (design), `code-review-agent`, `integration-review-agent`, `diagnose-agent` |
| `low` | `orchestrator-agent`, `item-runner-agent`, `wave-planner-agent`, `document-agent` |
| `off` | every command stage: `formatter-agent`, `plan-lint-agent`, `test-gate-agent`, `doc-trigger-agent`, `commit-agent` |

The launcher passes these settings even with a pinned model. Provider/model support still determines
actual reasoning behavior.

Escalation, not prediction: the launcher resolves thinking from agent frontmatter
(`agent.thinking ?? defaults`), so a per-dispatch level needs a second agent. `architect-large-brisk-agent`
is that second agent — same body, `high` — and the orchestrator dispatches it only for a second plan
attempt. Never guess a level before the work; escalate after a failure says more thinking is needed.

Use `rg` for scoped text searches, `ast-grep` for search-only structural queries, and `jq` for exact JSON projections. Do not add AST searches when a simple text search already answers the question. Browser automation is intentionally excluded from the DeepSeek specialist agents: its text snapshots do not replace tests, and the model cannot inspect its screenshots. Enable it only for an explicit task that needs text-only local browser interaction.

RTK is optional for noisy successful validation output. Preserve original commands and evidence, and read raw output whenever it is ambiguous or failed. No global rewrite hook is installed, and no source or review-diff filtering is authorized.

The personal launcher helper lives outside this repository. Stage records under the private Pi `runs` directory contain final output and usage, not entire transcripts; they are local and not automatically deleted. Do not put secrets in final reports. Never commit `.pi/state/` or `.pi/checks/`.

Compare total stage usage (input, output, cache reads/writes) and repair rates before claiming savings. RTK's output estimates are not total token usage, and a valid handoff is not proof of semantic correctness.

## Deterministic gates and measurement

Everything that can be decided by an exit code is a command stage under `bin/`, invoked from agent
frontmatter (`command:`), never a model call. All of them print one handoff JSON object, write their
evidence under `PI_STAGE_DIR`, and exit 0 with the verdict in `status`.

| binary | stage | decides |
|---|---|---|
| `bin/mechanical-gate` | `formatter-agent` | format, lint, type-check over the changed set |
| `bin/plan-lint` | `plan-lint-agent` | whether a plan is verifiable at all |
| `bin/test-gate` | `test-gate-agent` | suite pass/fail against the base-commit delta, plus the coverage gap |
| `bin/doc-trigger` | `doc-trigger-agent` | whether documentation is owed, and which paths |
| `bin/commit-gate` | `commit-agent` | readiness, review scope, message shape and staleness, hygiene, the commit itself |
| `bin/route-engine` | orchestrator helper | stage order, contract assembly, ledger, advisory recording, repair decision. Exit `0` proceed, `2` usage/ledger error, `3` stop and read the verdict |
| `bin/route-cost` | measurement | cost, turns, dispatches, repair rate, cost per landed commit |
| `bin/gate-config` | configuration | where this repository's gate commands live; no file in the tree |

Two repository-level conventions keep them honest:

- **Repository gate configuration lives outside the tree**, resolved by `bin/gate-config` in this
  order: `PI_GATE_CONFIG`, `<repo>/.pi-mechanical.json` (only if a team wants it committed),
  **`<git-common-dir>/pi-gate.json`** (the default: shared by every worktree, never in the tree,
  invisible to anyone who does not use Pi), `~/.pi/agent/gates/<repo>.json`, and the legacy
  `<repo>/.pi/mechanical.json`. Keys: `write[]`, `check[]` (a string or
  `{command, wholeRepo, optional, advisory}`), `test[]`, and `"baseline": "base"` to measure suites
  against `baseCommit`. `optional` forgives a failure that names no changed file (a missing
  toolchain); `advisory` forgives one that names a changed file, for heuristic analysers such as
  knip or jscpd whose false positives no stage can repair. `advisory` does not forgive a timeout:
  a tool that never finished is a harness fault, not a recommendation, so it still fails the stage.
  `optional` keeps its longer-standing behaviour of treating a timeout like any other
  unattributable failure. Manage it with
  `gate-config show | path | install <file> | edit | remove`.
- **Every command has a 15-minute ceiling.** `PI_GATE_TIMEOUT_SECONDS` (or the config's
  `timeoutSeconds`) overrides it; a killed command is reported as a failure naming the timeout, never
  as a pass. Note that it kills the shell, so a detached daemon (a Gradle daemon) can outlive it.
- **`plan-lint` refuses the roadmap index.** `contract.planFile` must be the assigned feature file,
  not `00-roadmap.md`: linting an index's checklist would pass on entry lines and prove nothing.
- **A worktree without its bootstrap is `BLOCKED`, not failing.** A fresh worktree has no
  `node_modules` and no Android SDK; the formatter gate reports that as an environment problem naming
  the fix, because no file can be blamed for it.

`route-cost` is the source of truth for every claim about spend: it reads `runs/*/record.json`, which
the launcher already writes, and reports the same numbers that justified these gates (14.2 dispatches
per task, 2.6 build rounds per commit, 7 of 9,897 repairs using warm repair, top 10% of tasks holding
51% of cost).

## Roadmap Convention

- Roadmap indexes live at `docs/roadmaps/<version>/<track>/00-roadmap.md`.
- Each checklist entry points to one feature file in the same directory and identifies whether it is complete.
- The orchestrator passes the exact roadmap index and feature-file paths to every agent that needs product or acceptance context.
- Only the architect may edit a roadmap feature file, and only for a large feature when the orchestrator explicitly assigns the detailed-plan task.

## Work Types and Routes

- **Small fix:** localized, low-risk work with explicit behavior and no architectural or product decision. Route build → doc-trigger → formatter → commit, all inside one route worktree on `route/<taskId>`. `doc-trigger` answers the documentation question as a command stage; a real obligation means the change was not a small fix.
- **Normal feature:** contained feature work using established patterns. Route architect-agent → plan-lint → build → doc-trigger → formatter → code review → commit, all inside one route worktree on `route/<taskId>`. The plan is not user-gated: it carries no user-owned decision by definition.
- **Large feature:** cross-cutting, high-risk, migration-heavy, contract-changing, or genuinely ambiguous work. Route architect-large-agent → plan approved → plan-lint → build → test-gate → doc-trigger → document when owed → formatter → code review → commit, all inside one route worktree on `route/<taskId>`. The large-feature architect runs the user interview and stores a full detailed plan in the assigned roadmap feature file. The documentation stage may justify non-applicability; it is not silently omitted.
- **Wave:** two or more independent large roadmap items run concurrently as a worker pool of N = 8, each worker owning one item inside its own worktree for one round, with the next round picking the next ready items until the scope is empty. The authoritative scheduler, readiness predicate, per-stage rules, dependency taxonomy, failure routing, and follow-up route live in [`WAVE.md`](WAVE.md); the list below is orientation, not the contract. Shape: wave-planner-agent (`WAVE_READY` gate) → one scope-level plan approval → repeat { pick up to N = 8 ready items → one `parallel` call of `item-runner-agent` workers, each running architect-large (plan validation) → plan-lint → build → doc-trigger → document when owed → formatter → code-review → commit inside its own worktree → cherry-pick the returned commits in pick order } until the queue drains → test-gate-agent per workspace (command stage, delta gate) → integration-review-agent (last content inspection) → readiness report (no commit). There is no item cap and no fixed batch: roadmap size never forces sequential waves. Every edge is `contract`, `runtime`, `collision`, or `evidence`. An item is quarantined after the third failed repair round; a committed item is never reverted and its repair is a follow-up commit.

A long description or detailed user-authored plan does not by itself make a task large. The orchestrator classifies by uncertainty, risk, breadth, and contract impact, and reclassifies when implementation reveals broader scope.

A plan is confirmed by the user only when it carries a user-owned decision: every large-feature plan, and a wave's scope plus planner output. The orchestrator presents it, suspends with `AWAITING PLAN APPROVAL`, and waits for an explicit decision the caller relays back (see the Plan Confirmation Gate and *Suspending for User Input* in [`orchestrator-agent.md`](orchestrator-agent.md)). A normal-feature plan is reported, not gated — it has no unresolved decision, and `plan-lint` already refuses one that cannot be verified. Quarantine, cost and failure reports, follow-up routes, and reclassification are reported without waiting for a reply.

## Agent Responsibilities

- **diagnose-agent:** certifies the root cause of a defect with executed evidence before any fix is planned. Pre-route and repair-side only: it never lands a change, never edits the repo, and creates throwaway repros under `/tmp` only. It returns `SYMPTOM`/`REPRO`/`EVIDENCE`/`ROOT CAUSE`/`FIX BOUNDARY`/`CLASSIFY`, which become the orchestrator's task text. Never a stage in a forward route.
- **orchestrator-agent:** classifies the task, selects the route, delegates stages, relays large-feature interview questions, and tracks evidence. It creates the route's worktree at a recorded base commit, dispatches every stage with `cwd` set to it, fast-forwards the resulting commit into the primary checkout, and removes the worktree before reporting completion. It never performs a specialist stage itself.
- **architect-agent:** produces a concise plan for a normal feature. It never implements the plan.
- **architect-large-agent:** interviews user-owned decisions and produces the detailed roadmap plan for a large feature, at `max` thinking. It never implements the plan.
- **architect-large-brisk-agent:** the same role at `high`, dispatched only for a second plan attempt after a rejection, a second `plan-lint` refusal, or two repair rounds.
- **build-agent:** implements production changes and owns focused, valuable tests for its work. It never edits roadmaps, performs independent review, or commits.
- **test-agent:** reviews test *design* when `test-gate` reports uncovered changed behavior or the plan asks for it. Suite execution belongs to the command stage; test code is owned by `build-agent`. It never changes production code.
- **code-review-agent:** independently reviews the complete implementation and tests. It never fixes or commits what it reviews.
- **formatter-agent:** command stage (`bin/mechanical-gate`). Runs the repository's own format, lint, and type-check over the changed set, keeping only findings that name a changed file. Never changes behavior.
- **plan-lint-agent:** command stage (`bin/plan-lint`). Refuses a plan with no acceptance criteria, no owning paths, or mostly vague outcomes. Runs before build; a FAIL returns to the architect that owns the plan.
- **test-gate-agent:** command stage (`bin/test-gate`). Runs the suites, applies the delta rule against the base commit, and reports the changed files no test refers to. Never writes code or tests.
- **doc-trigger-agent:** command stage (`bin/doc-trigger`). Decides whether documentation is owed and names the paths and identifiers, so the documenter does not have to hunt and no model is paid to conclude "nothing to do".
- **document-agent:** updates user and maintainer documentation when implemented behavior creates a documentation obligation. `docs/` pages are onboarding material: general concepts, headings, tables, bullets, short paragraphs — never implementation detail. It never changes production code or roadmap plans.
- **commit-agent:** command stage (`bin/commit-gate`). Verifies required stage evidence, refuses content newer than the review, validates the builder's message (shape, specificity, staleness), scans for secrets and artifacts, stages only in-scope paths, and creates the focused commit or commits the route allows: one item commit in a wave, or one follow-up commit on `followup/<itemId>` or `assembly-fix/<itemId>` when repairing committed wave content. It never repairs earlier-stage work and never assembles or cherry-picks.
- **item-runner-agent:** owns exactly one roadmap item for one round: dispatches its architect, build, document, formatter, review, and commit serially inside its own worktree, repairs within the allowed rounds, and returns one commit for the orchestrator to assemble. It is the only nested orchestrator, it shares the wave `taskId` with every stage it dispatches, and it never cherry-picks, merges, or writes state.
- **wave-planner-agent:** builds and prunes the inter-item dependency DAG, classifies every edge, and emits the ready-queue order, interface freezes, per-item path attribution, per-item blast radius, and mandatory shared artifacts. It writes no roadmap files; its artifact is orchestrator wave state. It never builds, reviews, or commits.
- **integration-review-agent:** reviews only cross-item surfaces of the assembled wave result: shared contracts, overlap zones, independently duplicated helpers, and assembled coherence. It is the last stage that inspects content. It never re-reviews an item and never fixes what it finds.
