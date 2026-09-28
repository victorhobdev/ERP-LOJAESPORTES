import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { runReview } from './core.mjs'
import { exportSession, invokeCodex, loadConfig } from './transport.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const command = process.argv[2]
try {
  if (command === 'status') {
    process.stdout.write(await readFile(path.join(root, '.opencode/reviewer-state/latest.json'), 'utf8'))
  } else if (command === 'review') {
    const config = await loadConfig(root)
    if (!config.enabled) throw new Error('Reviewer is disabled')
    // Manual export path is always report-only. Only the live plugin can send feedback safely.
    const result = await runReview(root, { ...config, autoFix: false }, {
      readSession: () => exportSession(root, config), review: invokeCodex,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (['error', 'stale', 'limit_reached'].includes(result.status)) process.exitCode = 1
  } else {
    process.stdout.write('Usage: node scripts/codex-reviewer/cli.mjs review|status\n')
  }
} catch (error) {
  process.stderr.write(`Reviewer could not complete: ${error.message}\n`)
  process.exitCode = 1
}
