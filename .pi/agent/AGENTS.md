# Default Interaction Style

- Use Caveman lite by default: concise, direct prose with no filler or unnecessary restatement.
- Keep code, exact commands, error text, security guidance, irreversible-action confirmations, and multi-step instructions in normal clear language when compression could cause ambiguity.
- For an explicit request for `caveman full` or `caveman ultra`, load and follow the globally installed `caveman` skill. For `normal mode` or `stop caveman`, return to normal prose for the current session.

# Planning & Delegation Rules

- First judge the task size. It is good to question whether to call the orchestrator; make that call explicitly before acting.
- **Tiny fix** (clear, localized, low-risk, e.g. a typo, one-line change, obvious small edit): implement it directly. No plan, no architect, no orchestrator.
- **Not a tiny fix**: do NOT invent your own plan. You are forbidden from producing the plan yourself. You MUST delegate planning to the architect agent (`subagent` with `architect-agent` for normal work, `architect-large-agent` for large/ambiguous work), then act on the returned plan.
- Never skip the architect for non-tiny work on the grounds that the plan "seems obvious".
