---
description: Session diff tracking — list, show, undo, redo
argument-hint: "[list|show|undo|redo] [diff-id]"
---
The user invoked the diff-tracker command `/diff ${@:-list}`. Follow the diff-tracker skill at ~/.pi/agent/skills/diff-tracker/SKILL.md and execute the requested subcommand:

- `list` → run `diff-tracker list` (this session's diffs, oldest → newest, one line each)
- `show <id>` → run `diff-tracker show <id>`
- `undo <id>` → run `diff-tracker undo <id>` (reverse-apply; only when status is `applied`)
- `redo <id>` → run `diff-tracker redo <id>` (re-apply; only when status is `undone`)

`<id>` may be a full UUID, any unambiguous prefix, or the sequence number from `list`. Then complete the prompt with the skill's mandatory begin/end workflow.
