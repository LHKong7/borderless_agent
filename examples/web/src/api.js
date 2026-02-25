/**
 * API client for Agent server (server/app.py).
 * In dev, Vite proxies /api to http://127.0.0.1:8000.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api'

async function request(method, path, body = null) {
  const opts = { method, headers: {} }
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${path}`, opts)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }
  return res.json()
}

/** POST /sessions -> { session_id } */
export async function createSession() {
  return request('POST', '/sessions')
}

/** GET /sessions?limit=20 -> [{ id, updated_at, turns, state }, ...] */
export async function listSessions(limit = 20) {
  return request('GET', `/sessions?limit=${limit}`)
}

/** GET /sessions/:id -> { id, updated_at, turns, state } */
export async function getSession(sessionId) {
  return request('GET', `/sessions/${sessionId}`)
}

/** POST /sessions/:id/turn { message } -> { reply, pending_approvals, session_id? } */
export async function sendTurn(sessionId, message, createIfMissing = false) {
  const q = createIfMissing ? '?create_if_missing=true' : ''
  return request('POST', `/sessions/${sessionId}/turn${q}`, { message })
}

/**
 * POST /sessions/:id/turn/stream – SSE stream of reply.
 * Callbacks: onDelta(chunk), onDone({ reply, pending_approvals }), onError(detail).
 */
export async function sendTurnStream(sessionId, message, createIfMissing = false, { onDelta, onDone, onError } = {}) {
  const q = createIfMissing ? '?create_if_missing=true' : ''
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/turn/stream${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    onError?.(err.detail || res.statusText)
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'delta' && data.delta != null) onDelta?.(data.delta)
            if (data.type === 'done') onDone?.({ reply: data.reply ?? '', pending_approvals: data.pending_approvals ?? [] })
            if (data.type === 'error') onError?.(data.detail ?? 'Unknown error')
          } catch (_) {}
        }
      }
    }
    if (buf.startsWith('data: ')) {
      try {
        const data = JSON.parse(buf.slice(6))
        if (data.type === 'delta' && data.delta != null) onDelta?.(data.delta)
        if (data.type === 'done') onDone?.({ reply: data.reply ?? '', pending_approvals: data.pending_approvals ?? [] })
        if (data.type === 'error') onError?.(data.detail ?? 'Unknown error')
      } catch (_) {}
    }
  } finally {
    reader.releaseLock()
  }
}
