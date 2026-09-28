import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rename, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const stateDirectory = (root) => path.join(root, '.opencode', 'reviewer-state')

function safePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes(':') || file.startsWith('/') || file.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid scoped path')
  if (/(^|\/)(backups|node_modules|\.git|\.codex|reviewer-state)(\/|$)|(^|\/)\.env($|\.)|(^|\/)(auth|credentials|mcp-auth)\.json$|\.(pem|key)$/i.test(file)) throw new Error('Sensitive path excluded from review')
  return file
}

export function validateReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review object')
  const keys = ['verdict', 'summary', 'issues', 'evidence', 'unmetCriteria']
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error('Invalid review fields')
  if (!['pass', 'changes_required', 'inconclusive', 'error'].includes(value.verdict) || typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('Invalid review verdict')
  for (const key of ['evidence', 'unmetCriteria']) {
    if (!Array.isArray(value[key]) || value[key].length > 30 || value[key].some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Invalid review evidence')
  }
  if (!Array.isArray(value.issues) || value.issues.length > 20) throw new Error('Invalid findings')
  for (const issue of value.issues) {
    const fields = ['severity', 'file', 'line', 'title', 'detail', 'fix']
    if (!issue || Object.keys(issue).length !== fields.length || fields.some((field) => !(field in issue)) || !['critical', 'high', 'medium', 'low'].includes(issue.severity)) throw new Error('Invalid finding fields')
    safePath(issue.file)
    if (issue.line !== null && (!Number.isInteger(issue.line) || issue.line < 1)) throw new Error('Invalid finding line')
    for (const field of ['title', 'detail', 'fix']) if (typeof issue[field] !== 'string' || !issue[field].trim()) throw new Error('Invalid finding detail')
  }
  if (value.verdict === 'pass' && (value.issues.length || value.unmetCriteria.length || !value.evidence.length)) throw new Error('Contradictory PASS')
  if (value.verdict === 'changes_required' && !value.issues.length) throw new Error('Changes required without findings')
  return value
}

export async function snapshot(root, config) {
  if (!/^[a-f0-9]{40}$/.test(config.baseRef)) throw new Error('baseRef must be an immutable full commit SHA')
  if (!Array.isArray(config.files) || !config.files.length || config.files.length > 100) throw new Error('Explicit file scope required')
  const files = [...new Set(config.files.map(safePath))].sort()
  const git = async (...args) => (await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout
  await git('cat-file', '-e', `${config.baseRef}^{commit}`)
  const head = (await git('rev-parse', 'HEAD')).trim()
  const changed = new Set((await git('diff', '--name-only', '-z', config.baseRef, '--')).split('\0').filter(Boolean))
  const untracked = new Set((await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean))
  const changedFiles = files.filter((file) => changed.has(file) || untracked.has(file))
  const resolvedRoot = await realpath(root)
  const contents = []
  for (const file of files) {
    const absolute = path.join(root, file)
    try {
      const stat = await lstat(absolute)
      const resolved = await realpath(absolute)
      const relative = path.relative(resolvedRoot, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative) || stat.isSymbolicLink() || !stat.isFile()) throw new Error('Scoped file escapes repository or is not regular')
      if (stat.size > 512 * 1024) throw new Error('Scoped file exceeds review size limit')
      contents.push([file, hash(await readFile(absolute))])
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      contents.push([file, null])
    }
  }
  return { head, baseRef: config.baseRef, changedFiles, fingerprint: hash(JSON.stringify({ head, base: config.baseRef, task: config.task, contents })) }
}

export function redact(text) {
  return text.replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(sk-[A-Za-z0-9_-]{15,}|gh[pousr]_[A-Za-z0-9_]{15,})\b/g, '[REDACTED]')
    .replace(/((?:["']?)(?:password|api[_-]?key|access[_-]?token|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, '$1[REDACTED]')
}

function sessionView(session, config) {
  if (session?.info?.id !== config.sessionId || session.info.parentID) throw new Error('Wrong session or subagent session')
  if (!Array.isArray(session.messages) || !session.messages.length) throw new Error('Session has no messages')
  if (session.info.directory && path.resolve(session.info.directory).toLowerCase() !== path.resolve(config.root).toLowerCase()) throw new Error('Session belongs to another directory')
  const last = session.messages.at(-1)
  if (last.info.role !== 'assistant' || !last.info.time?.completed || last.info.error) throw new Error('Executor is not finished; review deferred')
  const all = session.messages.map((message) => ({
    id: message.info.id, role: message.info.role, completed: message.info.time?.completed,
    text: (message.parts ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n'),
  }))
  const newestHuman = all.findLast((message) => message.role === 'user' && !message.text.startsWith('[[CODEX_REVIEW:'))
  const tail = all.filter((message) => message.text).slice(-6)
  const selected = newestHuman && !tail.includes(newestHuman) ? [newestHuman, ...tail] : tail
  return { fingerprint: hash(JSON.stringify(all)), transcript: selected.map(({ role, text }) => `[${role}]\n${redact(text).slice(0, 6000)}`).join('\n\n').slice(0, 36000) }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  await rename(temporary, file)
}

export async function runReview(root, config, adapters) {
  if (!/^[a-zA-Z0-9_-]+$/.test(config.sessionId) || !/^[a-zA-Z0-9_-]+$/.test(config.blockId)) throw new Error('Explicit session and block required')
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 3 || typeof config.autoFix !== 'boolean') throw new Error('Invalid review limits')
  config = { ...config, root }
  const directory = stateDirectory(root)
  await mkdir(directory, { recursive: true })
  const lock = path.join(directory, 'lock')
  try { await mkdir(lock) } catch (error) { if (error.code === 'EEXIST') return { status: 'busy' }; throw error }
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  const statePath = path.join(directory, 'state.json')
  let state = { identity: `${config.sessionId}:${config.blockId}:${config.baseRef}`, attempts: 0 }
  try {
    try {
      const prior = JSON.parse(await readFile(statePath, 'utf8'))
      if (prior.identity !== state.identity) throw new Error('Existing block state differs; use a separate reviewed installation before resetting')
      state = prior
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const original = await adapters.readSession()
    const beforeSession = sessionView(original, config)
    const before = await snapshot(root, config)
    const fingerprint = hash(`${before.fingerprint}:${beforeSession.fingerprint}`)
    if (fingerprint === state.lastFingerprint) {
      const previous = JSON.parse(await readFile(state.report, 'utf8'))
      if (previous.status !== 'error') return { status: 'unchanged', report: state.report }
    }
    if (state.attempts >= config.maxRounds) return { status: 'limit_reached' }
    if (!before.changedFiles.length) return { status: 'no_changes' }
    state.attempts++
    await atomicJson(statePath, state)
    const reportPath = path.join(directory, `review-${state.attempts}.json`)
    let result
    try {
      const review = validateReview(await adapters.review({ root, config, snapshot: before, transcript: beforeSession.transcript, directory }))
      if (review.issues.some((issue) => !config.files.includes(issue.file))) throw new Error('Finding outside the authorized file scope')
      const after = await snapshot(root, config)
      const afterSession = sessionView(await adapters.readSession(), config)
      const stable = after.fingerprint === before.fingerprint && afterSession.fingerprint === beforeSession.fingerprint
      result = { status: stable ? review.verdict : 'stale', at: new Date().toISOString(), sessionId: config.sessionId, blockId: config.blockId, round: state.attempts, snapshot: before, review }
      await atomicJson(reportPath, result)
      if (stable && review.verdict !== 'error') {
        state.lastFingerprint = fingerprint
        state.report = reportPath
        await atomicJson(statePath, state)
      }
      if (stable && review.verdict === 'changes_required' && config.autoFix && state.attempts < config.maxRounds) {
        // Journal before sending: a timeout may mean the executor already received it.
        result.feedback = 'sending'
        await atomicJson(reportPath, result)
        try {
          const finalSnapshot = await snapshot(root, config)
          const finalSession = sessionView(await adapters.readSession(), config)
          if (finalSnapshot.fingerprint !== before.fingerprint || finalSession.fingerprint !== beforeSession.fingerprint) {
            result.status = 'stale'; result.feedback = 'not sent: state changed before dispatch'
          } else {
            await adapters.sendFeedback({ original, review, round: state.attempts, blockId: config.blockId })
            result.feedback = 'sent'
          }
        } catch {
          result.status = 'feedback_uncertain'; result.feedback = 'unknown; reconcile manually, do not resend automatically'
        }
      }
    } catch (error) {
      result = { status: 'error', round: state.attempts, at: new Date().toISOString(), message: redact(String(error.message)).slice(0, 500) }
    }
    await atomicJson(reportPath, result)
    await atomicJson(path.join(directory, 'latest.json'), result)
    return { ...result, report: reportPath }
  } finally {
    const { unlink } = await import('node:fs/promises')
    await unlink(path.join(lock, 'owner.json'))
    await rmdir(lock)
  }
}
