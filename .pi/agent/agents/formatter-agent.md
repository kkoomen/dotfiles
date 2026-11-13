---
name: formatter-agent
description: Runs the repository's own format, lint, and type-check commands and reports their exact evidence. Mechanical, no model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/mechanical-gate
---

# Formatter Agent (mechanical stage)

This stage is **not a model**. `command:` in the frontmatter makes the launcher execute
`~/.pi/agent/bin/mechanical-gate` with `bash -c` inside the dispatch `cwd`, and the script
prints the handoff JSON itself. The launcher records it exactly like a model stage: same
record shape, same `snapshot`, same `checks[]` log verification, same route evidence.

## Why it is mechanical

Running the repository's formatter, linter, and type checker is tool orchestration, not
judgment. A model here cost real money for zero decisions, and because the stage *writes*, a
re-run invalidated the review that followed it, which is why the review kept re-running. The
commands are deterministic: the exit code already answers the question.

Do not convert this stage back to a model. If a lint finding needs judgment, the script
returns `FAIL` and the orchestrator routes it to `build-agent` — which is where a semantic
fix belongs anyway.

## What it runs

Discovery, in order:

1. `<worktree>/.pi/mechanical.json` — `{"write": ["pnpm format"], "check": ["pnpm lint"]}`.
2. `package.json` scripts: `format` as a write step; `format:check`, `lint`, `typecheck`,
   `types:check` as check steps; `npx --no-install tsc --noEmit` when only a `tsconfig.json`
   exists. The package manager is detected from the lockfile.
3. Nothing configured → `NOT_APPLICABLE` with the evidence used. It never installs tools.

Write steps run before check steps, so the reviewer always sees the final formatted tree.
The script reports every file a configured tool rewrote in `files[]`.

## Handoff

- `PASS` — every discovered step exited 0. `checks[]` carries the exact command, exit code,
  and a log path under `PI_STAGE_DIR` that `validateCheckEvidence` can open.
- `FAIL` — the first non-zero step, named in `summary`, with all executed checks in evidence.
  The owning stage fixes the cause; never suppress or weaken a rule.
- `NOT_APPLICABLE` — no format/lint/typecheck command exists, or `PI_MECHANICAL_DISABLE=1`.

## Constraints

- Scope is the dispatch worktree only: `cwd` = `worktreePath`. It never touches the primary
  checkout, another route's worktree, a sibling item's worktree, or the assembled tree.
- It never changes behavior, tests, dependencies, roadmap files, or Git history. It only runs
  the tools the repository already declares.
- It does not commit. `commit-agent` consumes its `snapshot` as `expectedSnapshot`.

## Configuration

| Env | Meaning |
|---|---|
| `PI_MECHANICAL_DISABLE=1` | Skip the stage and report `NOT_APPLICABLE`. |
| `PI_STAGE_CONTRACT` | JSON contract, supplied by the launcher. |
| `PI_STAGE_DIR` | Private directory for command logs, supplied by the launcher. |
