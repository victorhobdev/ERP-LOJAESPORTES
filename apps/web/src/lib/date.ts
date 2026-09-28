/** Data local do PC em YYYY-MM-DD; a operação da loja segue o fuso local, não o UTC. */
export function localTodayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
