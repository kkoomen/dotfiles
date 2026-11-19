---
name: memory-lint-agent
description: Checks that memory files stay injectable — five-field entries, resolving evidence, valid scope globs, no duplicates, no secrets, 60-line cap. No model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/memory-lint
---

# Memory Lint (mechanical stage)

This stage is **not a model**. `command:` makes the launcher run `~/.pi/agent/bin/memory-lint`
with `bash -c` inside the dispatch `cwd`.

## Why this exists

A memory file is injected back into prompts on every matching turn. A malformed line is therefore not
cosmetic: a six-field entry becomes injected text nobody wrote, an unresolvable citation becomes a
claim the next repair trusts for no reason, and an unbounded file is a context leak that never fails a
build. None of that is visible by reading the file, and none of it needs a model to detect.

## Inputs

1. `contract.memoryFiles` — the memory file paths the dispatch named (project file first, then the
   global file). Absent or empty means the two writable roots are linted.
2. Direct mode (`memory-lint --repo <dir>`) reads the project memory file and
   `~/.pi/agent/memory/global.md`. The project file resolves from the **repository root**, never from
   a route worktree or a subdirectory, so every worktree of one repository shares and lints the same
   file. Resolution is git-first (for a linked worktree, the primary checkout that owns `.git`), and
   otherwise the **outermost** ancestor owning a `.pi` directory — not the nearest, because a real
   worktree carried `.pi/npm/.gitignore` and a nearest-`.pi` rule stopped there, silently disabling
   injection and this gate.

## Blocking

- The file is over the 60-line cap (`MAX_LINES` in `bin/lib/memory.mjs`).
- An entry is not exactly `claim | evidence | scope | created | hits`.
- An entry cites no evidence, or a cited path does not resolve to a file.
- A scope glob does not compile, or the scope is empty.
- `created` is not an ISO date (or is in the future), or `hits` is not a positive integer.
- Two entries share a claim after normalization.
- An entry carries a credential shape.

## Rules

- Never edits a memory file. Fix the entry through `bin/memory-promote`, or remove it with
  `bin/memory-prune`; a hand-edited entry is what this stage exists to catch.
- The stage runs directly after `build`, and a FAIL rewinds the route to `build` (the stage that owns
  the memory file). Because the repair target precedes the gate, the repaired tree is linted again on
  the next dispatch — a route can never reach commit with the memory file unlinted.
- `--explain --cwd <dir> --prompt <text>` prints the exact selection the extension would inject, with
  scores; use it to answer "why did that memory appear" without guessing.
