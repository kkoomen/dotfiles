---
name: grill-me
description: Runs the one-question-at-a-time interview used only for large features with unresolved user-owned decisions.
---

# Grill-Me Design Interview

## Purpose

The architect interviews the user only for a task classified as a large feature and only about decisions the user must own before a detailed roadmap plan can be finalized. The interview is a decision tree: each answer may open one more question, and it ends when no genuine user-owned decision remains.

## What to Ask

Ask about decisions the user should own:

- **Flow**: how the user moves through the feature — steps, order, entry points, exits.
- **UI/UX**: what the user sees and experiences — surfaces, states, presentation choices.
- **Edge cases**: product-level behavior at important boundaries when the roadmap and current evidence do not settle it.
- **User-only facts**: things the architect cannot look up — provider choice, whether an account and API keys already exist, product numbers, external dependencies.

Never ask implementation details the architect can decide from repository evidence: data models, record shapes, schemas, internal interfaces, function signatures, storage choices, or library selection. If the design is unambiguous, skip the interview and produce the detailed plan.

## Rules

- Research before asking. Read `AGENTS.md`, the assigned roadmap files, referenced architecture documentation, existing code, and tests; use Graphify when available or required. Never ask the user anything that can be verified from those sources.
- Only genuine decisions become questions: a question is warranted only when the answer materially changes the plan and the roadmap or approved plan does not settle it.
- Ask one question at a time. Emit exactly one question per output, then stop and wait for the user's answer — never batch questions, never proceed without the answer.
- Follow up one question at a time: each answer may open a more specific, still user-level question. For example, after the user picks a payment provider, ask whether they already have an account and API keys.
- If the feature has no genuine open questions, state that in one line and go straight to the final plan.
- Never ask the user to paste a secret. Ask only whether required external setup exists and provide safe setup guidance in the plan.

## Question Format

One question per output, phrased in product, flow, UX, policy, trade-off, or external-system terms. List at most 2-3 mutually exclusive options; **Option 1 is the recommended one** based on roadmap fit, user impact, risk, and implementation cost. Justify it briefly.

Every question ends with an explicit escape option:

> **None of the above — I'll steer**

The user may reject all options and dictate the direction. Follow that direction unless it conflicts with a safety requirement or another confirmed decision; surface the exact conflict and ask for confirmation before planning around it.

## Output Format

Start the output with the marker line, then the single question:

```
INTERVIEW_ROUND

❓ **Q1** - **<question title>**: <question body in general flow/UX/edge-case terms, options inline>

➡️ Recommended: Option 1 — <option name>. <brief justification>
```

Then stop and wait for the user's answer. A question whose answer depends on another open question belongs later, after that question is answered.

## Re-invocation with Transcript

When re-invoked with the interview transcript (all questions asked so far) and the user's answers:

1. Use the latest answer to move down the design tree.
2. If another genuine question is open, emit it — one question, same format.
3. If no genuine questions remain, emit the final plan (the standard architect deliverable).

Repeat until the interview is complete — the final plan is produced only then.

## Orchestrator Hand-off

- Every interview output starts with the marker line `INTERVIEW_ROUND` so the orchestrator can recognize it, relay the single question to the user verbatim, and re-invoke the architect with the transcript and the user's answer.
- Never finalize a plan while a genuine user-owned question remains open.
