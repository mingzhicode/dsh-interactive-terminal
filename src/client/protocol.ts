/** Browser transport lifetime and the shared Host wire frames. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientFrame, ServerFrame } from '../protocol.ts'
export type { ClientFrame, ServerFrame } from '../protocol.ts'

/** Rendered authority and connection state for one selected session. */
export type TerminalViewMode = 'controller' | 'readonly'
export type TerminalConnectionStatus = 'collapsed' | 'connecting' | 'connected' | 'disconnected'
export interface ClientTerminalState {
  mode: TerminalViewMode
  connection: TerminalConnectionStatus
  sequence: number
  pendingInput: string
}

/** Per-attachment callbacks; disposal suppresses all subsequent callbacks. */
export interface FrameHandlers { frame(frame: ServerFrame): void; close(code: number): void }
export interface ClientAttachment { send(frame: ClientFrame): void; dispose(): void }
/** Prop-injected transport, shared by views and owned by the plugin effect. */
export interface ClientTransport {
  attach(sessionId: string, options: { readonly: boolean; resume?: string }, handlers: FrameHandlers): ClientAttachment
  track(dispose: () => void): () => void
  dispose(): void
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function natural(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }

/** Validate untrusted WebSocket fields before handing them to the terminal parser. */
export function parseServerFrame(value: unknown): ServerFrame {
  if (!record(value) || value.version !== 1 || !natural(value.generation)) throw new Error('Invalid terminal frame')
  let valid = false
  switch (value.type) {
    case 'terminal.snapshot': {
      const s = value.snapshot
      valid = record(s) && natural(s.sequence) && natural(s.rows) && s.rows > 0 && natural(s.cols) && s.cols > 0 && typeof s.replay === 'string' && natural(s.historyBytes) && typeof s.truncated === 'boolean' && natural(value.scrollbackLines)
      break
    }
    case 'terminal.attached': valid = natural(value.maxInputBytes) && value.maxInputBytes > 0 && (value.mode === 'controller' ? typeof value.resume === 'string' : value.mode === 'readonly' && ['readonly', 'controller-busy', 'invalid-resume'].includes(String(value.reason))); break
    case 'terminal.output': valid = natural(value.sequence) && typeof value.output === 'string'; break
    case 'terminal.status': valid = record(value.status) && (value.status.kind === 'running' || (value.status.kind === 'exited' && (value.status.exitCode === null || Number.isInteger(value.status.exitCode)) && (value.status.signal === null || typeof value.status.signal === 'string'))) && ['ready', 'busy', 'blocked', 'exited', 'disposed'].includes(String(value.queueStatus)) && [null, 'model-send', 'human', 'signal', 'reset', 'disconnect-recovery'].includes(value.holder as string | null) && (value.takeoverId === null || (value.holder === 'model-send' && typeof value.takeoverId === 'string' && /^[1-9]\d*$/.test(value.takeoverId))) && natural(value.pendingCount); break
    case 'human.queued': valid = natural(value.position); break
    case 'human.granted': case 'human.revoked': case 'heartbeat': valid = true; break
    case 'terminal.error': valid = ['operation-failed', 'transport-failed'].includes(String(value.code)) && typeof value.message === 'string'; break
  }
  if (!valid) throw new Error('Invalid terminal frame')
  return value as unknown as ServerFrame
}

/** Create lazy, abortable authenticated attachments and effect-owned view cleanup. */
export function createTerminalClientTransport(connection: Pick<ConnectionHandle, 'rpc'>): ClientTransport {
  const cleanups = new Set<() => void>()
  let disposed = false
  return {
    track(cleanup) {
      if (disposed) { cleanup(); return () => {} }
      cleanups.add(cleanup)
      return () => { cleanups.delete(cleanup) }
    },
    dispose() { disposed = true; for (const cleanup of [...cleanups]) cleanup(); cleanups.clear() },
    attach(sessionId, options, handlers) {
      const abort = new AbortController()
      let socket: WebSocket | undefined
      let closed = disposed
      const dispose = () => {
        closed = true
        abort.abort()
        if (socket) { socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close() }
        cleanups.delete(dispose)
      }
      if (!closed) {
        cleanups.add(dispose)
        void connection.rpc.call('/dsh-interactive-terminal', 'token', { sessionId, ...options }, abort.signal).then(result => {
          if (closed) return
          if (!result.ok) throw new Error('Terminal unavailable')
          const credential = result.value
          if (!record(credential) || credential.version !== 1 || credential.path !== '/dsh-interactive-terminal/ws' || credential.protocol !== 'dsh-interactive-terminal.v1' || typeof credential.token !== 'string') throw new Error('Invalid terminal credential')
          const url = new URL(credential.path, window.location.href)
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(url.href, [credential.protocol, `token.${credential.token}`])
          socket.onmessage = event => {
            if (closed) return
            try { handlers.frame(parseServerFrame(JSON.parse(event.data as string))) }
            catch { dispose(); handlers.close(1008) }
          }
          socket.onclose = event => { if (!closed) { dispose(); handlers.close(event.code) } }
          socket.onerror = () => { /* WebSocket reports the terminal failure through close. */ }
        }).catch(() => { if (!closed) { dispose(); handlers.close(1011) } })
      }
      return {
        dispose,
        send(frame) {
          if (closed || socket?.readyState !== WebSocket.OPEN) throw new Error('Terminal disconnected')
          socket.send(JSON.stringify(frame))
        },
      }
    },
  }
}
