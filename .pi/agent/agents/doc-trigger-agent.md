---
name: doc-trigger-agent
description: Decides mechanically whether documentation is owed for this change, and names the exact paths and identifiers. No model.
handoff: true
thinking: off
command: /Users/koomen/.pi/agent/bin/doc-trigger
---

# Documentation Trigger (mechanical stage)

This stage is **not a model**. `command:` makes the launcher run `~/.pi/agent/bin/doc-trigger`
with `bash -c` inside the dispatch `cwd`.

## Why it is mechanical

`document-agent` used to be dispatched to work out whether it applied at all: 153 of 822 measured
runs ended in `NOT_APPLICABLE`, which is a model call whose entire output was "nothing to do".
The decision is a property of the diff, so it belongs to a script.

## Predicates

Derived from the diff against `contract.baseCommit`, all local:

| predicate | detection |
|---|---|
| public surface | `export` / `public fun` declaration added or removed in a changed source file |
| configuration | `.env*`, wrangler / firebase / vercel / compose descriptors, config schema |
| command line | CLI entry point changed *and* a flag added in a changed source file |
| operational | migrations, deploy descriptors, `infra/`, workflows |
| existing references | documentation paths in this change, or docs naming an identifier it touches |
| dispatch | `contract.documentRequired: true` |

## What it returns

Always `PASS` — the gate ran and produced an answer. The answer is in the record:

- `applicable` — whether a documenter is owed.
- `reasons[]` — the predicates that fired, quoted back verbatim.
- `docPaths[]` — documentation paths to hand the documenter so it does not hunt.
- `identifiers[]` — the public names this change introduced.

The orchestrator sets `documentRequired` from `applicable` and dispatches `document-agent` only
when it is true. It never edits documentation itself and never suppresses a real obligation: the
predicates are additive, and `contract.documentRequired: true` forces a pass through.
