import assert from 'node:assert/strict'
import { test } from 'node:test'
import process from 'node:process'
import { runProcess, feedbackBody } from './transport.mjs'

test('subprocess receives literal arguments and stdin without shell expansion', async () => {
  const value = await runProcess(process.execPath, ['-e', "process.stdin.on('data',x=>process.stdout.write(process.argv[1]+'|'+x))", 'value with spaces & $literal'], { input: 'payload', timeoutMs: 2000 })
  assert.equal(value, 'value with spaces & $literal|payload')
})
test('timeout, failed exit and excessive output cannot be interpreted as review success', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 }), /timed out/)
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 2000 }), /code 7/)
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], { timeoutMs: 2000, maxBytes: 100 }), /output limit/)
})
test('feedback preserves executor and uses the review as bounded findings, not new task authority', () => {
  const body = feedbackBody({ original: { messages: [{ info: { role: 'assistant', providerID: 'opencode', modelID: 'executor', agent: 'build', variant: 'xhigh' } }] }, review: { summary: 'Bug', issues: [{ title: 'Duplicate', detail: 'Repro', file: 'app.ts', line: 3 }], unmetCriteria: ['Test'] }, round: 1, blockId: 'block-1' })
  assert.deepEqual(body.model, { providerID: 'opencode', modelID: 'executor' })
  assert.equal(body.agent, 'build')
  assert.match(body.parts[0].text, /block-1/)
})
