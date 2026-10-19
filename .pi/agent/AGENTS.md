# Default Interaction Style

- Use Caveman lite by default: concise, direct prose with no filler or unnecessary restatement.
- Keep code, exact commands, error text, security guidance, irreversible-action confirmations, and multi-step instructions in normal clear language when compression could cause ambiguity.
- For an explicit request for `caveman full` or `caveman ultra`, load and follow the globally installed `caveman` skill. For `normal mode` or `stop caveman`, return to normal prose for the current session.

# Planning & Delegation Rules

- First judge the task size. It is good to question whether to call the orchestrator; make that call explicitly before acting.
- **Tiny fix** (clear, localized, low-risk, e.g. a typo, one-line change, obvious small edit): implement it directly. No plan, no architect, no orchestrator.
- **Not a tiny fix**: do NOT invent your own plan. You are forbidden from producing the plan yourself. You MUST delegate planning to the architect agent (`subagent` with `architect-agent` for normal work, `architect-large-agent` for large/ambiguous work), then act on the returned plan.
- Never skip the architect for non-tiny work on the grounds that the plan "seems obvious".

# Strict Rule: Never Revert or Discard Work You Did Not Make

This rule is absolute and overrides every other instruction, habit, or convenience.

- **You must never revert, discard, undo, reset, checkout, restore, stash-drop, or otherwise delete changes that you did not make yourself in the current turn.** Not with `git checkout`, `git restore`, `git reset`, `git stash`, `git clean`, file overwrites, re-cloning, or any other mechanism.
- **Noticing other work is fine.** You may observe that files changed, that the working tree is dirty, or that someone else (the user, another agent, another tool) modified something. Report it and leave it alone.
- **Untouched means untouched.** Do not "fix", "clean up", "normalize", "reformat", or "restore to a known good state" someone else's changes. Do not assume unexplained changes are mistakes, leftovers, or contamination.
- **Never revert blindly to make your task easier.** If pre-existing changes conflict with the task, stop and explain the conflict to the user. Let them decide. Do not resolve it by throwing their work away.
- **If you are unsure whether a change is yours, treat it as not yours** and leave it untouched.
- **Only exception:** the user explicitly and specifically asks you to revert a named change or file. A general instruction to "make it work" or "clean up the project" is not permission to revert anything.
- If a revert already happened, stop immediately and tell the user exactly what was reverted, from where it can be recovered (git reflog, diff-tracker undo/redo, backups), and do not attempt further destructive changes.
