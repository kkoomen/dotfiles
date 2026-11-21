/** Shared, deterministic safeguards for the personal Pi subagent launcher. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * Bumped only when a handoff shape changes incompatibly. Records on disk carry
 * the version they were written with, so old evidence stays interpretable and a
 * stale record is never mistaken for a current one.
 */
export const HANDOFF_SCHEMA_VERSION = 1

export const success = new Set(['PASS', 'PLAN_READY', 'NOT_APPLICABLE', 'COMMITTED', 'WAVE_READY', 'INTEGRATION_PASS'])
export const stopped = new Set(['FAIL', 'BLOCKED', 'REPLAN_REQUIRED', 'RECLASSIFY', 'INTERVIEW_ROUND', 'INTEGRATION_FINDINGS'])
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Stage set per route, in execution order. `commit-agent` is validated against
 * this list: order documents the route as well as proving presence, because
 * every writing stage (document, formatter) must run before code review.
 */
export const ROUTE_STAGES = {
  small: ['build-agent', 'formatter-agent'],
  normal: ['architect-agent', 'plan-lint-agent', 'build-agent', 'formatter-agent', 'code-review-agent'],
  large: [
    'architect-large-agent',
    'plan-lint-agent',
    'build-agent',
    'test-gate-agent',
    'formatter-agent',
    'code-review-agent',
  ],
  wave: ['plan-lint-agent', 'build-agent', 'formatter-agent', 'code-review-agent'],
  documentation: ['document-agent', 'formatter-agent'],
}

/** Invalid settings fail visibly instead of silently changing reasoning effort. */
export function parseThinking(value) {
  if (value === undefined) return undefined
  if (!levels.has(value)) throw new Error(`Invalid agent thinking level: ${String(value)}`)
  return value
}

/** Explicit agent settings take precedence, even when a model is pinned. */
export function launchOptions(agent, defaults) {
  const model = agent.model ?? defaults.model
  const thinking = parseThinking(agent.thinking ?? defaults.thinkingLevel)
  return {
    model,
    thinking,
    args: [
      ...(model ? ['--model', model] : []),
      ...(thinking ? ['--thinking', thinking] : []),
      ...(agent.tools?.length ? ['--tools', agent.tools.join(',')] : []),
    ],
  }
}

/** Preserve every text block in the final assistant message. */
export function finalText(messages) {
  const message = messages.findLast((item) => item.role === 'assistant')
  return (
    message?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n') ?? ''
  )
}

/**
 * Every balanced top-level `{...}` in `text`, in order, ignoring braces inside
 * JSON strings. Lets a handoff survive a stray sentence or a code fence.
 */
function balancedObjects(text) {
  const objects = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const char = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          objects.push(text.slice(i, j + 1))
          i = j
          break
        }
      }
    }
  }
  return objects
}

/**
 * Parse the handoff from the final message.
 *
 * Agents are asked for one bare JSON object, but a sentence before it, a fenced
 * block, or a schema example earlier in the message used to fail the entire
 * stage ("Expected one JSON handoff object") and force a cold re-dispatch. Any
 * well-formed object is accepted; the last one carrying `status` wins, because
 * that is the handoff rather than an example.
 */
export function parseReport(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const candidates = [text.trim(), ...balancedObjects(text)]
  let fallback = null
  for (let index = candidates.length - 1; index >= 0; index--) {
    let parsed
    try {
      parsed = JSON.parse(candidates[index])
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    if ('status' in parsed) return parsed
    fallback ??= parsed
  }
  return fallback
}

/** Legacy text failures also stop chains; unrelated user agents keep their format. */
export function semanticFailure(text) {
  const status =
    parseReport(text)?.status ??
    text
      .trim()
      .replace(/^\*\*/, '')
      .match(/^([A-Z_]+)\b/)?.[1]
  return stopped.has(status) ? status : null
}

export function validateContract(contract) {
  if (!contract || !/^[\w.-]+$/.test(contract.taskId ?? ''))
    return 'Missing or invalid contract.taskId'
  const requirements = normaliseRequirements(contract.requirements)
  if (!requirements || requirements.length === 0)
    return 'Assign at least one requirement ID'
  if (requirements.some((entry) => !/^R\d+(?:\.\d+)*$/.test(entry.id)))
    return 'Requirement IDs must be R1, R2, R1.1, etc.'
  const ids = requirements.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length)
    return 'Duplicate assigned requirement ID'
  return null
}

/**
 * Requirement contracts carry meaning and ownership: `{ id, text, owner }`.
 *
 * Ledgers and older dispatches still carry bare ids. They are normalised here on read, never
 * migrated, so an in-flight route keeps working unchanged. Returns null for a shape that is not a
 * requirement at all, so a malformed contract fails by name instead of being guessed at.
 */
export function normaliseRequirements(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ id: entry.trim() })
      continue
    }
    if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim()) {
      out.push({
        id: entry.id.trim(),
        ...(typeof entry.text === 'string' && entry.text.trim() ? { text: entry.text.trim() } : {}),
        ...(typeof entry.owner === 'string' && entry.owner.trim() ? { owner: entry.owner.trim() } : {}),
      })
      continue
    }
    return null
  }
  return out
}

const STAGE_ALIASES = {
  architect: 'architect-agent',
  'architect-large': 'architect-large-agent',
  'plan-lint': 'plan-lint-agent',
  'memory-lint': 'memory-lint-agent',
  build: 'build-agent',
  test: 'test-agent',
  'test-gate': 'test-gate-agent',
  'doc-trigger': 'doc-trigger-agent',
  document: 'document-agent',
  formatter: 'formatter-agent',
  review: 'code-review-agent',
  commit: 'commit-agent',
}

/** True when `owner` names `agentName`, as an agent name or its stage alias. */
export function ownerMatchesAgent(owner, agentName) {
  if (typeof owner !== 'string' || !owner.trim()) return false
  const named = owner.trim().toLowerCase()
  const agent = String(agentName || '').toLowerCase()
  if (named === agent) return true
  if (named === agent.replace(/-agent$/, '')) return true
  return STAGE_ALIASES[named] === agent
}

/** Validate shape and completeness, not the truth of an agent's claims. */
export function validateReport(text, contract, agentName) {
  const report = parseReport(text)
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return 'Expected one JSON handoff object'
  if (report.taskId !== contract.taskId) return 'Handoff taskId does not match assignment'
  if (report.schemaVersion !== undefined && report.schemaVersion !== HANDOFF_SCHEMA_VERSION)
    return `Unsupported handoff schemaVersion ${String(report.schemaVersion)}; expected ${HANDOFF_SCHEMA_VERSION}`
  if (!success.has(report.status) && !stopped.has(report.status))
    return 'Missing or unknown handoff status'
  if (typeof report.summary !== 'string' || !report.summary.trim())
    return 'Missing summary or blocker explanation'
  if (stopped.has(report.status)) return report.status
  const expected = agentName.startsWith('architect-')
    ? ['PLAN_READY']
    : agentName === 'wave-planner-agent'
      ? ['WAVE_READY']
      : agentName === 'integration-review-agent'
        ? ['INTEGRATION_PASS']
        : agentName === 'commit-agent'
          ? ['COMMITTED']
          : agentName === 'item-runner-agent'
            ? ['PASS']
            : ['document-agent', 'formatter-agent'].includes(agentName)
              ? ['PASS', 'NOT_APPLICABLE']
              : ['PASS']
  if (!expected.includes(report.status))
    return `Status ${report.status} is not valid for ${agentName}`
  for (const key of ['requirements', 'checks', 'files', 'deviations', 'unresolved']) {
    if (!Array.isArray(report[key])) return `Missing ${key} array`
  }
  if (report.unresolved.length) return 'Success handoff contains unresolved blocking work'
  if (report.files.some((file) => typeof file !== 'string')) return 'files must contain paths'
  const assigned = normaliseRequirements(contract.requirements) ?? []
  const assignedIds = assigned.map((entry) => entry.id)
  const ownerById = new Map(assigned.map((entry) => [entry.id, entry.owner]))
  const ids = report.requirements.map((item) => item?.id)
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== assignedIds.length ||
    assignedIds.some((id) => !ids.includes(id))
  ) {
    return 'Missing, extra, or duplicate requirement coverage; reconcile the assignment before continuing'
  }
  const states = agentName.startsWith('architect-') || agentName === 'wave-planner-agent'
    ? ['planned']
    : agentName === 'build-agent'
      ? ['implemented']
      : ['document-agent', 'formatter-agent'].includes(agentName)
        ? ['verified', 'not_applicable']
        : ['verified']
  for (const requirement of report.requirements) {
    // A requirement that names another owner is legitimately out of this stage's scope: it reports
    // `not_applicable` with a reason instead of claiming `verified` or `implemented`. When no owner
    // is named, the per-agent state rules above stand unchanged.
    const owner = ownerById.get(requirement.id)
    const nonOwning = typeof owner === 'string' && owner.trim() && !ownerMatchesAgent(owner, agentName)
    const allowed = nonOwning ? [...states, 'not_applicable'] : states
    if (!allowed.includes(requirement.state))
      return `Unfinished or invalid state for ${requirement.id}`
    if (
      !Array.isArray(requirement.evidence) ||
      !requirement.evidence.length ||
      requirement.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())
    ) {
      return `Missing evidence or non-applicability reason for ${requirement.id}`
    }
  }
  for (const check of report.checks) {
    if (
      !check ||
      typeof check.command !== 'string' ||
      !check.command.trim() ||
      check.exitCode !== 0 ||
      typeof check.log !== 'string' ||
      !check.log.trim()
    ) {
      return 'Successful checks require exact command, exitCode=0, and evidence log path'
    }
  }
  if (agentName === 'test-agent' && report.checks.length === 0)
    return 'Test stage requires executed-check evidence'
  if (report.findings !== undefined) {
    if (!Array.isArray(report.findings)) return 'findings must be an array when present'
    for (const finding of report.findings) {
      if (!finding || typeof finding.id !== 'string' || !finding.id.trim())
        return 'Every finding needs a stable id'
      if (typeof finding.location !== 'string' || !finding.location.trim())
        return `Finding ${finding.id} needs an exact location`
      if (typeof finding.scenario !== 'string' || !finding.scenario.trim())
        return `Finding ${finding.id} needs a failure scenario`
    }
    const findingIds = report.findings.map((finding) => finding.id)
    if (new Set(findingIds).size !== findingIds.length) return 'Duplicate finding id'
  }
  return null
}

/** Referenced command evidence must exist; wrapper failures cannot be relabelled PASS. */export function validateCheckEvidence(text, cwd) {
  for (const check of parseReport(text)?.checks ?? []) {
    const file = path.resolve(cwd, check.log)
    try {
      if (!lstatSync(file).isFile()) return `Check evidence is not a file: ${file}`
      if (file.endsWith('.json')) {
        const evidence = JSON.parse(readFileSync(file, 'utf8'))
        if (evidence.rawLog !== undefined) {
          if (
            evidence.complete !== true ||
            evidence.exitCode !== 0 ||
            !lstatSync(evidence.rawLog).isFile()
          )
            return `Failed or incomplete command evidence: ${file}`
        }
      }
    } catch {
      return `Unreadable command evidence: ${file}`
    }
  }
  return null
}

/**
 * True for a path inside the repository-root `.pi/` directory.
 *
 * That directory is local agent state — project memory (`.pi/memory.md`), route state, check logs,
 * worktrees, caches — and never repository content. It must not enter a snapshot, or a memory write
 * during a route looks like a code change and invalidates a review that examined nothing new. Only
 * the root `.pi/`; a `.pi/` inside a package is ordinary project content.
 *
 * Deliberately kept local instead of imported from `bin/lib/gate.mjs`: this module is loaded by the
 * extension host and cannot depend on the gate CLI's module graph.
 */
const isLocalStatePath = (file) => /^\.pi\//.test(String(file ?? '').replace(/^\.\//, '').replace(/\\/g, '/'))

/** Hash HEAD, index, worktree diff and untracked contents without exposing code. */
export function codeSnapshot(cwd) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim()
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const hash = createHash('sha256')
  for (const args of [
    ['rev-parse', 'HEAD'],
    ['diff', '--no-ext-diff', '--binary', 'HEAD'],
    ['diff', '--no-ext-diff', '--cached', '--binary'],
    ['status', '--porcelain=v1', '-z'],
  ]) {
    hash.update(git(...args)).update('\0')
  }
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((file) => !isLocalStatePath(file))
    .sort()
  for (const file of untracked) {
    const fullPath = path.resolve(root, file)
    const stat = lstatSync(fullPath)
    hash.update(file).update('\0')
    if (stat.isSymbolicLink()) hash.update(readlinkSync(fullPath))
    else if (stat.isFile() && stat.size <= 64 * 1024 * 1024) hash.update(readFileSync(fullPath))
    else throw new Error(`Cannot safely snapshot untracked path: ${file}`)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Why a handoff needs one more turn in the same session, or null when it is acceptable.
 *
 * A stopped status (FAIL, BLOCKED, REPLAN_REQUIRED, ...) is a valid handoff and must never be
 * repaired away, and a parseable handoff keeps every other validator in charge. This is the
 * single decision the launcher makes before spending a repair turn instead of a whole stage.
 */
export function handoffRepairReason(text, contract, agentName, cwd) {
  if (semanticFailure(text)) return null
  return validateReport(text, contract, agentName) || validateCheckEvidence(text, cwd) || null
}

/** Ensure upstream stage records belong to this task and actually passed. */
export function validatePriorRecords(contract, cwd, agentName) {
  if (contract.expectedSnapshot && codeSnapshot(cwd) !== contract.expectedSnapshot)
    return 'Code changed since the supplied snapshot; refresh affected validation'
  const records = []
  for (const file of contract.priorRecords ?? []) {
    let record
    try {
      record = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return `Unreadable prior record: ${file}`
    }
    if (
      record.contract?.taskId !== contract.taskId ||
      record.validationError ||
      record.exitCode !== 0 ||
      !record.finishedAt
    )
      return `Failed, incomplete, or wrong-task prior record: ${file}`
    if (record.stopReason === 'error' || record.stopReason === 'aborted')
      return `Failed prior runtime: ${file}`
    if (validateReport(record.output, record.contract, record.agent))
      return `Invalid prior handoff: ${file}`
    const evidenceError = validateCheckEvidence(record.output, record.cwd ?? cwd)
    if (evidenceError) return evidenceError
    records.push(record)
  }
  if (agentName === 'commit-agent') {
    // Order documents the route as well as proving presence: every writing stage
    // (document, formatter) runs before code review, so a formatting rewrite cannot
    // invalidate a review that already passed. Keep these arrays in execution order,
    // and keep them equal to `bin/commit-gate`'s `REQUIRED`, which is the other half
    // of the same gate: a stage listed here but never run blocks the commit before the
    // command stage can accept it.
    const routes = ROUTE_STAGES
    const configured = routes[contract.workType]
    if (!configured)
      return `Commit requires contract.workType: ${Object.keys(routes).join(', ')}`
    if (!contract.expectedSnapshot) return 'Commit requires a current expectedSnapshot'
    // `document-agent` is conditional everywhere except the documentation route, where the
    // change *is* documentation. An absent `documentRequired` means true, so it is required.
    const required = configured.filter(
      (stage) => stage !== 'document-agent' || contract.documentRequired !== false || contract.workType === 'documentation',
    )
    if (contract.documentRequired !== false && !required.includes('document-agent')) required.push('document-agent')
    for (const stage of required) {
      if (!records.some((record) => record.agent === stage))
        return `Commit lacks successful ${stage} evidence`
    }
    const formatter = records.findLast((record) => record.agent === 'formatter-agent')
    if (formatter.snapshot !== contract.expectedSnapshot)
      return 'Formatter evidence is stale; rerun formatting'
    // Review after formatting is required when formatting changed production/tests.
    // Compare the current contents of reviewed files, not only the whole-tree digest.
    const reviewer = records.findLast((record) => record.agent === 'code-review-agent')
    if (reviewer && reviewer.reviewSnapshot !== reviewSnapshot(cwd))
      return 'Production/test/configuration changes are newer than review; rerun affected validation and review'
    if (reviewer && (!reviewer.reviewedFiles || !Object.keys(reviewer.reviewedFiles).length))
      return 'Review lacks file fingerprints; rerun review'
    if (reviewer) {
      for (const [file, digest] of Object.entries(reviewer.reviewedFiles)) {
        try {
          if (fileDigest(file) !== digest)
            return `Reviewed file changed: ${file}; rerun affected validation and review`
        } catch {
          return `Reviewed file unavailable: ${file}; rerun review`
        }
      }
    }
  }
  return null
}

function fileDigest(file) {
  try {
    const stat = lstatSync(file)
    const content = stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)
    return createHash('sha256').update(content).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return 'deleted'
    throw error
  }
}

/** Record the reviewed paths without relying on an agent to invent hashes. */
export function reviewedFileDigests(output, cwd) {
  const files = parseReport(output)?.files ?? []
  return Object.fromEntries(
    files.map((file) => {
      const fullPath = path.resolve(cwd, file)
      return [fullPath, fileDigest(fullPath)]
    }),
  )
}

/** Detect newly added, removed or modified non-document files after review. */
export function reviewSnapshot(cwd) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const names = new Set([
    ...git('diff', '--no-ext-diff', '--name-only', '-z', 'HEAD').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ])
  const hash = createHash('sha256').update(git('rev-parse', 'HEAD'))
  for (const name of [...names].filter((name) => name && !name.endsWith('.md') && !isLocalStatePath(name)).sort()) {
    hash
      .update(name)
      .update('\0')
      .update(fileDigest(path.join(root, name)))
      .update('\0')
  }
  return hash.digest('hex')
}

/**
 * The plan a `plan-lint` dispatch is missing, resolved at the dispatch boundary.
 *
 * Measured defect: 31 of 65 `plan-lint` FAILs read "No plan reached plan-lint", every one of them
 * on a normal route whose contract carried neither `planFile` nor `plan`, with a PASS
 * `architect-agent` record sitting in `priorRecords` holding the whole plan in its handoff
 * `summary`. The gate was right to refuse: nothing had handed it a plan. The planner had written
 * one, and the dispatch dropped it.
 *
 * So the last moment before the gate runs resolves the plan from evidence that already exists:
 * `priorRecords` only, nothing else, and no parsing of the plan itself. `bin/route-engine` performs
 * the same resolution in `contractFor()` when it builds the contract; this is the second, independent
 * construction point, for every dispatch that did not come from the engine. The two are deliberately
 * separate copies — the engine must not import from this directory, because it is a symlink into the
 * primary checkout there.
 *
 * Returns `{ contract, note }` with a NEW contract object, or `{ error }` naming why it refused.
 * The caller's contract is never mutated and no record is written by this function. `note` is the
 * human-readable provenance of the injected plan, for the caller's own reporting.
 *
 * The injected text is capped at 2000 characters with a `[truncated …]` marker naming the source
 * directory, and prefixed with a `<!-- plan source: ... -->` line. A shortened plan must say that it
 * is partial and where it came from, or the gate judges a fragment as if it were the whole plan.
 * Both lines must stay inert to `bin/plan-lint`'s sentence heuristic: when a plan has no list form,
 * the gate counts every chunk of at least 20 characters carrying an obligation verb
 * (`must|should|returns?|renders?|rejects?|records?|shows?|hides?|fails?|never|instead`) as an
 * acceptance criterion. A path ending in `record.json` matches `\brecords?\b`, so naming the record
 * file handed a criteria-less plan a criterion and let it PASS; naming the directory it sits in
 * keeps the trace without the token, and a trailing-slash path matches neither the gate's
 * owning-path nor its backticked-symbol pattern. Any future rewording must keep both lines free of
 * those verbs.
 *
 * A refusal names the way out, because it is a caller mistake rather than a plan defect:
 *
 * - a contract that already carries plan text or a plan file is returned untouched — an existing
 *   source is the caller's decision, not something to improve on.
 * - no usable prior record (unreadable, non-zero exit, flagged by validation, an errored or aborted
 *   run, or an `architect-agent` summary that is blank) — the caller must pass the plan.
 * - only a large-plan architect record (`architect-large-agent`, `architect-large-brisk-agent`),
 *   whose summary points at the plan instead of carrying it — the plan is the assigned roadmap
 *   feature file, so that file must arrive as `contract.planFile`. Scoring the pointer as a plan is
 *   the defect this refusal exists to prevent.
 */
const PLAN_TEXT_CAP = 2000

const planTextOf = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

/**
 * Inline plan text lifted from a handoff summary: capped with the same marker the engine uses, and
 * prefixed with the provenance comment. Both the comment and the marker name the source by its
 * containing directory, never by the record file name, and neither carries an obligation verb:
 * `bin/plan-lint` splits an unstyled plan into sentences when it finds no list form, and a chunk of
 * at least 20 characters with one of those verbs (`must|should|returns?|renders?|rejects?|records?|
 * shows?|hides?|fails?|never|instead`) is scored as an acceptance criterion. `record.json` matches
 * `\brecords?\b`, which is exactly how the first version of this line gave a criteria-less plan a
 * criterion. Reword only within that vocabulary.
 */
function inlinePlanFromSummary(summary, source) {
  const text = planTextOf(summary)
  if (!text) return null
  const directory = `${path.dirname(source)}/`
  const capped =
    text.length <= PLAN_TEXT_CAP
      ? text
      : `${text.slice(0, PLAN_TEXT_CAP)}\n\n[truncated at ${PLAN_TEXT_CAP} characters; full plan in ${directory}]`
  return `<!-- plan source: architect handoff summary, ${directory} -->\n${capped}`
}

/** A prior record is usable evidence only when it ran cleanly and reported no validation failure. */
const priorRecordRejection = (record) => {
  if (!record || typeof record !== 'object') return 'empty record'
  if (record.validationError) return `validation error: ${String(record.validationError).slice(0, 200)}`
  if (record.exitCode !== 0) return `exit code ${record.exitCode}`
  if (record.stopReason === 'error' || record.stopReason === 'aborted') return `run ended with ${record.stopReason}`
  return null
}

const LARGE_PLAN_AGENTS = new Set(['architect-large-agent', 'architect-large-brisk-agent'])

export function resolvePlanLintContract(contract, readRecord = (file) => JSON.parse(readFileSync(file, 'utf8'))) {
  if (!contract || typeof contract !== 'object') return { error: 'plan-lint needs a contract; none was supplied' }
  // A plan the caller already has is the caller's decision, not something to improve on.
  if (planTextOf(contract.plan) || planTextOf(contract.planFile)) return { contract, note: null }

  const records = Array.isArray(contract.priorRecords) ? contract.priorRecords : []
  const rejected = []
  let reference = null

  for (let index = records.length - 1; index >= 0; index--) {
    const file = records[index]
    if (typeof file !== 'string' || !file) continue
    let record
    try {
      record = readRecord(file)
    } catch (error) {
      rejected.push(`${file} (unreadable: ${String(error && error.message ? error.message : error).slice(0, 120)})`)
      continue
    }
    const rejection = priorRecordRejection(record)
    if (rejection) {
      rejected.push(`${file} (${rejection})`)
      continue
    }
    if (LARGE_PLAN_AGENTS.has(record.agent)) {
      // A large-plan architect writes the plan into the roadmap feature file and keeps only a
      // pointer in its summary. Scoring that pointer as a plan is the defect this must not repeat.
      reference ??= file
      continue
    }
    if (record.agent !== 'architect-agent') continue
    const output = typeof record.output === 'string' ? record.output : ''
    const summary = planTextOf(parseReport(output)?.summary)
    if (!summary) {
      rejected.push(`${file} (architect handoff summary is empty)`)
      continue
    }
    const plan = inlinePlanFromSummary(summary, file)
    return {
      contract: { ...contract, plan },
      note: `plan-lint plan lifted from the architect handoff summary in ${file}${summary.length > PLAN_TEXT_CAP ? ` (capped at ${PLAN_TEXT_CAP} characters)` : ''}`,
    }
  }

  if (reference) {
    return {
      error: `plan-lint has no plan text: ${reference} is a large-plan architect record, whose summary points at the plan rather than carrying it. The plan lives in the assigned roadmap feature file; pass that file as contract.planFile.`,
    }
  }
  const because = rejected.length
    ? ` No prior architect record supplied a plan: ${rejected.join('; ')}.`
    : ' No prior architect record supplied a plan.'
  return {
    error: `plan-lint needs a plan and the contract carries neither contract.plan nor contract.planFile.${because} Pass the plan text as contract.plan, or the plan file (never a roadmap index, never a run record) as contract.planFile.`,
  }
}
