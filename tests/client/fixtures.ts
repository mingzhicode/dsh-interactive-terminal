import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { TerminalOverlayProps } from '../../src/client/TerminalOverlay.tsx'
import type { ClientTransport, FrameHandlers } from '../../src/client/protocol.ts'
import type { ClientFrame, ServerFrame } from '../../src/protocol.ts'

export function testSessionId(id: string): TerminalOverlayProps['sessionId'] {
  return id as TerminalOverlayProps['sessionId']
}

export function fakeClientTransport() {
  const connections: { handlers: FrameHandlers; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
  const cleanups = new Set<() => void>()
  const transport = {
    attach: vi.fn<ClientTransport['attach']>((_session, _options, handlers) => {
      const connection = { handlers, send: vi.fn<(frame: ClientFrame) => void>(), close: vi.fn() }
      connections.push(connection)
      return { send: connection.send, dispose: connection.close }
    }),
    track(cleanup: () => void) { cleanups.add(cleanup); return () => { cleanups.delete(cleanup) } },
    dispose() { for (const cleanup of cleanups) cleanup(); cleanups.clear() },
    connections,
    async receive(frame: ServerFrame, index = connections.length - 1) { await act(async () => { connections[index]!.handlers.frame(frame) }) },
    async close(code = 1006) { await act(async () => { connections.at(-1)!.handlers.close(code) }) },
  }
  return transport
}

export const snapshot: Extract<ServerFrame, { type: 'terminal.snapshot' }> = { type: 'terminal.snapshot', version: 1, generation: 1, snapshot: { sequence: 0, rows: 3, cols: 12, replay: 'ready', historyBytes: 0, truncated: false }, scrollbackLines: 20 }

export async function attachController(transport: ReturnType<typeof fakeClientTransport>) {
  await transport.receive(snapshot)
  await transport.receive({ type: 'terminal.attached', version: 1, generation: 1, mode: 'controller', resume: 'private-proof', maxInputBytes: 32 })
  await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus: 'ready', holder: null, takeoverId: null, pendingCount: 0 })
}

/** In-memory browser WebSocket boundary; frame parsing and lifecycle remain production code. */
export class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(readonly url: string, readonly protocols: string[]) { FakeWebSocket.instances.push(this) }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
