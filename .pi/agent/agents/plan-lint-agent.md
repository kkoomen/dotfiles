---
name: plan-lint-agent
description: Checks the shape of an approved plan before implementation — observable outcomes, owning paths, failure conditions. No model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/plan-lint
---

# Plan Lint (mechanical stage)

This stage is **not a model**. `command:` makes the launcher run `~/.pi/agent/bin/plan-lint`
with `bash -c` inside the dispatch `cwd`.

## Why this exists instead of "more thinking"

The complaint behind it is real: plans that "didn't think it through" become repair rounds later.
Raising a reasoning level is a weak answer, because a vague plan reads the same at every level.
What actually predicts trouble is *shape*: a criterion that names an observable outcome, the module
that owns it, and the condition that would prove it unmet cannot be satisfied by interpretation.
That is checkable in milliseconds.

## Inputs

1. `contract.planFile` — a roadmap feature file; its `# Plan` section is used when present.
2. `contract.plan` — plan text inline.

A normal route's plan is lifted into `contract.plan` from the architect handoff summary before this
command runs, and a dispatch carrying neither field is refused before it starts. A FAIL from here is
therefore about the plan's shape, never about a plan that failed to arrive.

## Blocking

- No plan, or a plan too short to carry criteria.
- No acceptance criteria at all (no checklist item, numbered criterion, or AC/R-tagged line).
- No criterion names an owning path, or — with three or more criteria — fewer than 60% do.

## Non-blocking findings

- `F1.n` vague outcome wording ("handle", "support", "improve", "properly") with no failure
  condition.
- `F2.n` no failure condition at all: nothing states what would prove the criterion unmet.

## Rules

- Never edits the plan. A FAIL returns to the architect that owns the file, which is the only stage
  allowed to write it.
- Findings are advisory: they guide the architect, they do not block a route on style.
