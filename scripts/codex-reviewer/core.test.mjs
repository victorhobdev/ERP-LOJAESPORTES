import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { redact, runReview, snapshot, validateReview } from './core.mjs'

const pass = { verdict: 'pass', summary: 'Validado', issues: [], evidence: ['Teste executado: PASS'], unmetCriteria: [] }
const finding = { verdict: 'changes_required', summary: 'Correção necessária', issues: [{ severity: 'high', file: 'app.txt', line: 1, title: 'Erro', detail: 'Efeito reproduzível', fix: 'Corrigir guarda' }], evidence: ['Fluxo inspecionado'], unmetCriteria: ['Idempotência'] }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-reviewer-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  await writeFile(path.join(root, 'app.txt'), 'original')
  git('add', 'app.txt'); git('commit', '-qm', 'base')
  const config = { sessionId: 'ses_test', blockId: 'block-1', baseRef: git('rev-parse', 'HEAD'), files: ['app.txt', 'new.txt'], maxRounds: 3, autoFix: false, task: 'Provar idempotência' }
  await writeFile(path.join(root, 'app.txt'), 'changed')
  return { root, git, config }
}
function session(text = 'Concluído') {
  return { info: { id: 'ses_test' }, messages: [{ info: { id: 'msg1', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text }] }] }
}

test('malformed or contradictory results cannot become PASS', () => {
  assert.equal(validateReview(pass).verdict, 'pass')
  for (const value of [null, {}, { ...pass, verdict: 'changes_required' }, { ...pass, evidence: [] }, { ...pass, unmetCriteria: ['Missing test'] }, { ...pass, issues: finding.issues }, { ...finding, issues: [{ ...finding.issues[0], file: '../secret' }] }]) {
    assert.throws(() => validateReview(value))
  }
})

test('redacts quoted credential fields and complete authorization headers', () => {
  for (const value of ['{"password":"FAKE_PASSWORD","api_key":"FAKE_KEY"}', 'Authorization: Bearer FAKE_TOKEN', 'password = "FAKE PASSWORD"']) {
    assert.ok(!redact(value).includes('FAKE'))
  }
})

test('out-of-scope findings fail closed without sending feedback', async () => {
  const { root, config } = await fixture()
  const result = await runReview(root, { ...config, autoFix: true }, {
    readSession: async () => session(),
    review: async () => ({ ...finding, issues: [{ ...finding.issues[0], file: 'other.txt' }] }),
    sendFeedback: async () => assert.fail('out-of-scope correction'),
  })
  assert.equal(result.status, 'error')
})

test('reviewer-reported errors can retry within the persisted attempt limit', async () => {
  const { root, config } = await fixture(); let calls = 0
  const adapters = { readSession: async () => session(), review: async () => { calls++; return { ...pass, verdict: 'error' } } }
  await runReview(root, config, adapters)
  assert.equal((await runReview(root, config, adapters)).status, 'error')
  assert.equal(calls, 2)
})

test('fixed base detects committed work and ignores out-of-scope untracked backups', async () => {
  const { root, git, config } = await fixture()
  git('add', 'app.txt'); git('commit', '-qm', 'executor commit')
  const before = await snapshot(root, config)
  assert.deepEqual(before.changedFiles, ['app.txt'])
  await mkdir(path.join(root, 'backups')); await writeFile(path.join(root, 'backups', 'private.sql'), 'not for review')
  assert.equal((await snapshot(root, config)).fingerprint, before.fingerprint)
  await writeFile(path.join(root, 'new.txt'), 'new code')
  assert.notEqual((await snapshot(root, config)).fingerprint, before.fingerprint)
  assert.deepEqual((await snapshot(root, config)).changedFiles, ['app.txt', 'new.txt'])
})

test('scope cannot escape repository or include credential files', async () => {
  const { root, config } = await fixture()
  for (const file of ['../outside', '.env', 'backups/private.sql', '.git/config', 'C:/secret']) {
    await assert.rejects(snapshot(root, { ...config, files: [file] }))
  }
})

test('report-only persists review, suppresses duplicate, but reviews a new explanation', async () => {
  const { root, config } = await fixture()
  let text = 'Concluído'; let calls = 0
  const adapters = { readSession: async () => session(text), review: async () => { calls++; return finding }, sendFeedback: async () => assert.fail('report-only must not send') }
  assert.equal((await runReview(root, config, adapters)).status, 'changes_required')
  assert.equal((await runReview(root, config, adapters)).status, 'unchanged')
  text = 'Finding rejeitado por esta evidência nova'
  assert.equal((await runReview(root, config, adapters)).status, 'changes_required')
  assert.equal(calls, 2)
  const state = JSON.parse(await readFile(path.join(root, '.opencode/reviewer-state/state.json'), 'utf8'))
  assert.equal(state.attempts, 2)
})

test('code changed during review makes result stale and prevents feedback', async () => {
  const { root, config } = await fixture()
  const result = await runReview(root, { ...config, autoFix: true }, {
    readSession: async () => session(),
    review: async () => { await writeFile(path.join(root, 'app.txt'), 'newer code'); return finding },
    sendFeedback: async () => assert.fail('stale feedback must not be sent'),
  })
  assert.equal(result.status, 'stale')
})

test('session changed during review also invalidates PASS', async () => {
  const { root, config } = await fixture(); let reads = 0
  const result = await runReview(root, config, { readSession: async () => session(String(reads++)), review: async () => pass })
  assert.equal(result.status, 'stale')
})

test('new completed turn during final pre-dispatch check prevents feedback', async () => {
  const { root, config } = await fixture(); let reads = 0
  const result = await runReview(root, { ...config, autoFix: true }, {
    readSession: async () => session(++reads >= 3 ? 'New completed turn' : 'Original'),
    review: async () => finding,
    sendFeedback: async () => assert.fail('final stale result must not be sent'),
  })
  assert.equal(result.status, 'stale')
  assert.equal(reads, 3)
})

test('repository lock prevents concurrent reviewers and failures consume a bounded attempt', async () => {
  const { root, config } = await fixture()
  let unblock; let started
  const entered = new Promise((resolve) => { started = resolve })
  const held = new Promise((resolve) => { unblock = resolve })
  const running = runReview(root, config, { readSession: async () => session(), review: async () => { started(); await held; throw new Error('external failure') } })
  await entered
  assert.equal((await runReview(root, config, {})).status, 'busy')
  unblock()
  assert.equal((await running).status, 'error')
  const limited = { ...config, maxRounds: 1 }
  assert.equal((await runReview(root, limited, { readSession: async () => session() })).status, 'limit_reached')
})

test('automatic feedback is opt-in, single-send, and ambiguous delivery is not retried', async () => {
  const { root, config } = await fixture(); let sends = 0
  const adapters = { readSession: async () => session(), review: async () => finding, sendFeedback: async () => { sends++; throw new Error('network lost after send') } }
  const active = { ...config, autoFix: true }
  assert.equal((await runReview(root, active, adapters)).status, 'feedback_uncertain')
  assert.equal((await runReview(root, active, adapters)).status, 'unchanged')
  assert.equal(sends, 1)
})
