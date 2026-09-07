/** Shared, deterministic safeguards for the personal Pi subagent launcher. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'

const success = new Set(['PASS', 'PLAN_READY', 'NOT_APPLICABLE', 'COMMITTED'])
const stopped = new Set(['FAIL', 'BLOCKED', 'REPLAN_REQUIRED', 'RECLASSIFY', 'INTERVIEW_ROUND'])
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

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

function parseReport(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
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
  if (!Array.isArray(contract.requirements) || contract.requirements.length === 0)
    return 'Assign at least one requirement ID'
  if (contract.requirements.some((id) => !/^R\d+(?:\.\d+)*$/.test(id)))
    return 'Requirement IDs must be R1, R2, R1.1, etc.'
  if (new Set(contract.requirements).size !== contract.requirements.length)
    return 'Duplicate assigned requirement ID'
  return null
}

/** Validate shape and completeness, not the truth of an agent's claims. */
export function validateReport(text, contract, agentName) {
  const report = parseReport(text)
  if (!report || typeof report !== 'object' || Array.isArray(report))
    return 'Expected one JSON handoff object'
  if (report.taskId !== contract.taskId) return 'Handoff taskId does not match assignment'
  if (!success.has(report.status) && !stopped.has(report.status))
    return 'Missing or unknown handoff status'
  if (typeof report.summary !== 'string' || !report.summary.trim())
    return 'Missing summary or blocker explanation'
  if (stopped.has(report.status)) return report.status
  const expected = agentName.startsWith('architect-')
    ? ['PLAN_READY']
    : agentName === 'commit-agent'
      ? ['COMMITTED']
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
  const ids = report.requirements.map((item) => item?.id)
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== contract.requirements.length ||
    contract.requirements.some((id) => !ids.includes(id))
  ) {
    return 'Missing, extra, or duplicate requirement coverage; reconcile the assignment before continuing'
  }
  const states = agentName.startsWith('architect-')
    ? ['planned']
    : agentName === 'build-agent'
      ? ['implemented']
      : ['document-agent', 'formatter-agent'].includes(agentName)
        ? ['verified', 'not_applicable']
        : ['verified']
  for (const requirement of report.requirements) {
    if (!states.includes(requirement.state))
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
  return null
}

/** Referenced command evidence must exist; wrapper failures cannot be relabelled PASS. */
export function validateCheckEvidence(text, cwd) {
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
    const routes = {
      small: ['build-agent', 'formatter-agent'],
      normal: ['architect-agent', 'build-agent', 'code-review-agent', 'formatter-agent'],
      large: [
        'architect-large-agent',
        'build-agent',
        'test-agent',
        'code-review-agent',
        'document-agent',
        'formatter-agent',
      ],
      documentation: ['document-agent', 'formatter-agent'],
    }
    const required = routes[contract.workType]
    if (!required)
      return 'Commit requires contract.workType: small, normal, large, or documentation'
    if (!contract.expectedSnapshot) return 'Commit requires a current expectedSnapshot'
    if (contract.documentRequired !== false && ['small', 'normal'].includes(contract.workType))
      required.push('document-agent')
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
  for (const name of [...names].filter((name) => name && !name.endsWith('.md')).sort()) {
    hash
      .update(name)
      .update('\0')
      .update(fileDigest(path.join(root, name)))
      .update('\0')
  }
  return hash.digest('hex')
}
