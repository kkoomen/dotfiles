---
name: diff-tracker
description: 'Session-scoped diff tracking for every prompt. This skill MUST be loaded and its workflow run for EVERY user prompt without exception: it snapshots the project at the start of the turn and records a UUID-keyed, undoable diff of all changes at the end. Works with or without Git initialized in the project (uses the git diff command either way). Diff commands (list/show/undo/redo) are invoked by the user via the "/diff" slash command. Diffs are scoped to the current Pi session only — a new session starts with an empty list.'
---

# diff-tracker

Records what changed in every prompt, scoped to the current Pi session.

- Storage: `~/.pi/diff-tracker/` (global Pi folder), keyed by the current session id (`PI_SESSION_ID`). A new Pi session starts with an empty diff list.
- Works with or without Git initialized in the project: snapshots live in a private Git repo under `~/.pi/diff-tracker/sessions/<session>/repos/` (work-tree = the project directory), so diffs are produced with the `git diff` command either way.
- Every diff gets a UUID and is stored as `diffs/<uuid>.diff` plus `diffs/<uuid>.json` metadata (created time, cwd, status, summary, stats).

## Mandatory workflow — EVERY prompt

For every user prompt, without exception:

1. **Before making any changes** (first thing in your turn, before the first file-modifying tool call): run

   ```
   diff-tracker begin
   ```

   (the script auto-detects the project dir and session; no arguments needed)

2. Do the work normally.
3. **After finishing all changes**, at the end of your turn: run

   ```
   diff-tracker end --summary "<one short line describing what this prompt changed>"
   ```

`end` compares the current state to the snapshot, stores the diff (only if something changed) and prints its id. If nothing changed, it prints "no changes" and stores nothing — that is fine, keep going.

If a restored session or an interrupted turn leaves no active snapshot and `end` errors, run `begin` first, then `end`.

## The /diff command

The user invokes diff commands with the `/diff` slash command:

| Command | What to run |
|---|---|
| `/diff` or `/diff list` | `diff-tracker list` — all diffs of the current session, oldest → newest, one line each (seq, id, time, status, summary, project) |
| `/diff show <id>` | `diff-tracker show <id>` — full diff + metadata |
| `/diff undo <id>` | `diff-tracker undo <id>` — reverse-apply the diff (only while its status is `applied`) |
| `/diff redo <id>` | `diff-tracker redo <id>` — re-apply an undone diff (only while its status is `undone`) |

`<id>` is the UUID (or any unambiguous prefix, or the sequence number). These commands are only invoked through the `/diff` slash command — do not map natural-language phrases like "diff list" to commands. They still go through the mandatory begin/end workflow above, so an undo's own file changes are recorded as a normal diff too.

## Script

`bin/diff-tracker` (also symlinked onto PATH as `diff-tracker`). Run it with no arguments for usage. Storage root can be overridden with `DIFF_TRACKER_DIR`; a session can be forced with `--session <id>`.

## Notes & limitations

- Scope: the project directory (cwd) of the prompt. Files outside it are not tracked.
- Files ignored by the project's `.gitignore` are not tracked; common heavy dirs (node_modules, .venv, dist, build, .next, .terraform, __pycache__, *.pyc, .DS_Store, ...) are always excluded (see `excludes`).
- Nested Git repos inside the project are not tracked.
- Undo/redo fail cleanly when the diff conflicts with later changes — tell the user to undo later diffs first or resolve manually.
- Binary files are supported.
- `list` order is generation order: oldest at the top, newest at the bottom.
