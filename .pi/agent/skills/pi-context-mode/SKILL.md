---
name: pi-context-mode
description: >
  Persistent token-saving operating mode for long pi sessions. Delegation-first subagent use,
  compressed output contracts, read hygiene, compaction discipline. Trigger: "context mode",
  "save context", "long session", "token efficiency", "context budget".
---

# pi-context-mode

Operating discipline that stretches main-context budget across long sessions. Governs *workflow economics*: what to read, what to delegate, what to return. If caveman skill also active, caveman rules own prose style; this skill owns process.

## Persistence

ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. Off only: "stop context mode" / "normal mode".

Default: **full**. Switch: "context mode lite|full|ultra".

## Levels

| Level | What change |
|-------|-------------|
| lite | Delegation + read hygiene only. Normal prose |
| full | Lite + terse reporting, no tool-call narration, no decorative tables, no long raw output dumps |
| ultra | Full + one-line status per action, no restating file contents, no intermediate summaries |

## Rules

### 1. Delegate before you read
- "Where is X / who calls Y / what tests cover Z" → subagent, not inline file crawl.
- 3+ files of work in repo with `.pi/agents/` → project agents (agentScope: "project"), not main thread.
- Subagent output lands in main context verbatim. Always set compressed output contract: findings as `path:line — symbol — note`, totals line. No prose essays.
- Spawn parallel subagents for independent angles; aggregate in main thread.
- Small known-file edit: direct, no investigator first.

### 2. Read hygiene
- `grep`/`find` first. Then `read` with `offset`/`limit` at match lines.
- Never full-file read when target line known.
- Read skill files only when task matches description. Skill index already costs tokens every turn — do not add more.

### 3. Report economy
- After edit: changed paths + what changed + verification line. Do not echo whole file back.
- After investigation: findings list, not narrative.
- Quote shortest decisive line from errors. No log dumps unless asked.

### 4. Compaction discipline
- Context approaching limit → say so, suggest `/compact <focus>` with lossy summary focus.
- Propose `/new` session when task boundary crossed; old session stays in JSONL, revisitable via `/tree`.
- Warn before batches that will flood context (giant tool output, many full-file reads).

### 5. Prompt-cache awareness
- Keep prefix stable mid-session: no skill reloads, no context-file churn unless needed.
- Watch footer `R` vs `↑`. Cache miss streak → flag it.

### 6. Skills economy
- Load only skills matching current task. Niche skill for next task: load then, not now.

## Auto-Clarity

Drop mode for: security warnings, irreversible-action confirmations, multi-step destructive sequences, anything where compression risks misread. Full detail until clear part done. Resume after.

## Boundaries

Code, commits, PRs, commit messages: normal. "stop context mode" / "normal mode": revert. Level persists until changed or session end.
