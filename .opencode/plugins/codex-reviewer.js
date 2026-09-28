import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { runReview } from '../../scripts/codex-reviewer/core.mjs'
import { feedbackBody, invokeCodex, loadConfig } from '../../scripts/codex-reviewer/transport.mjs'

function unwrap(result) {
  if (result.error || (result.response && !result.response.ok)) throw new Error('OpenCode API request failed')
  return result.data
}

export const CodexReviewer = async ({ client, directory }) => {
  const root = directory
  try { await loadConfig(root) } catch { return {} } // Not installed/configured for this project.
  const stateDirectory = path.join(root, '.opencode/reviewer-state')
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(path.join(stateDirectory, 'plugin-loaded.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), directory: root }))

  async function run(sessionId) {
    try {
      const config = await loadConfig(root)
      if (!config.enabled || sessionId !== config.sessionId) return
      async function readSession() {
        const query = { directory: root }
        const statuses = unwrap(await client.session.status({ query }))
        if (Object.values(statuses).some((status) => status.type !== 'idle')) throw new Error('An executor is busy; review deferred')
        const info = unwrap(await client.session.get({ path: { id: sessionId }, query }))
        const messages = unwrap(await client.session.messages({ path: { id: sessionId }, query }))
        return { info, messages }
      }
      const result = await runReview(root, config, {
        readSession, review: invokeCodex,
        sendFeedback: async (value) => {
          // Core checks both idle status and fingerprints immediately before this call.
          unwrap(await client.session.promptAsync({ path: { id: sessionId }, query: { directory: root }, body: feedbackBody(value) }))
        },
      })
      if (!['unchanged', 'no_changes', 'busy'].includes(result.status)) await client.tui.showToast({ body: {
        message: `Codex review: ${result.status}. Relatório em .opencode/reviewer-state/latest.json`,
        variant: result.status === 'pass' ? 'success' : 'warning',
      } })
    } catch {
      await client.tui.showToast({ body: { message: 'Revisor não concluiu. Confira estado/limites locais; nenhum PASS foi emitido.', variant: 'error' } }).catch(() => {})
    }
  }
  return { event: async ({ event }) => {
    if (event.type === 'session.idle') void run(event.properties.sessionID)
  } }
}
