// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { TerminalScreen } from '../../src/screen.ts'
import { TerminalOverlay } from '../../src/client/TerminalOverlay.tsx'
import { attachController, fakeClientTransport, snapshot, testSessionId } from './fixtures.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('reconstructs server history, viewport and cursor in a real browser xterm parser', async () => {
  const host = new TerminalScreen({ cols: 12, rows: 3, scrollbackLines: 20, scrollbackMaxBytes: 10000 })
  const client = new Terminal({ cols: 12, rows: 3, scrollback: 20, allowProposedApi: true })
  try {
    await host.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[2;3H')
    const snapshot = host.snapshot()
    await new Promise<void>(resolve => client.write(snapshot.replay, resolve))
    const buffer = client.buffer.active
    expect(Array.from({ length: buffer.baseY }, (_, i) => buffer.getLine(i)!.translateToString(true))).toEqual(host.text().history)
    expect(Array.from({ length: client.rows }, (_, i) => buffer.getLine(buffer.baseY + i)!.translateToString(true)).join('\n')).toEqual(host.text().viewport)
    expect({ x: buffer.cursorX, y: buffer.cursorY }).toEqual(host.text().cursor)
  } finally { client.dispose(); host.dispose() }
})

it.each([false, true])('reconstructs alternate screen, later chunks and restored normal history (alternate=%s)', async alternate => {
  const host = new TerminalScreen({ cols: 12, rows: 3, scrollbackLines: 30, scrollbackMaxBytes: 10000 })
  const client = new Terminal({ cols: 12, rows: 3, scrollback: 30, allowProposedApi: true })
  const compare = () => {
    const b = client.buffer.active
    expect(b.type).toBe(alternate ? 'alternate' : 'normal')
    expect(Array.from({ length: client.rows }, (_, i) => b.getLine(b.baseY + i)!.translateToString(true)).join('\n')).toBe(host.text().viewport)
    expect({ x: b.cursorX, y: b.cursorY }).toEqual(host.text().cursor)
  }
  try {
    await host.write('one\r\ntwo\r\nthree\r\nfour\r\nfive' + (alternate ? '\x1b[?1049hALT\x1b[2;3H' : '\x1b[2;3H'))
    await new Promise<void>(resolve => client.write(host.snapshot().replay, resolve))
    compare()
    await host.write('Z')
    await new Promise<void>(resolve => client.write('Z', resolve))
    compare()
    if (alternate) {
      await host.write('\x1b[?1049l')
      await new Promise<void>(resolve => client.write('\x1b[?1049l', resolve))
      expect(Array.from({ length: client.buffer.active.baseY }, (_, i) => client.buffer.active.getLine(i)!.translateToString(true))).toEqual(host.text().history)
    }
  } finally { host.dispose(); client.dispose() }
})

async function bench() {
  const transport = fakeClientTransport()
  const open = vi.spyOn(Terminal.prototype, 'open')
  const view = render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
  await attachController(transport)
  fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
  return { transport, view, terminal: open.mock.contexts[0] as Terminal, current: () => open.mock.contexts.at(-1) as Terminal }
}

it('resumes only unsent pending keys after a confirmed grant and never replays the first sent key', async () => {
  const { transport, terminal } = await bench()
  act(() => { terminal.input('a', true); terminal.input('bc', true) })
  await transport.close()
  await waitFor(() => expect(transport.attach).toHaveBeenCalledTimes(2))
  expect(transport.attach.mock.calls[1]![1]).toEqual({ readonly: false, resume: 'private-proof' })
  await transport.receive(snapshot)
  await transport.receive({ type: 'terminal.attached', version: 1, generation: 1, mode: 'controller', resume: 'rotated', maxInputBytes: 32 })
  expect(transport.connections[1]!.send).not.toHaveBeenCalled()
  await transport.receive({ type: 'human.granted', version: 1, generation: 1 })
  expect(transport.connections[1]!.send).toHaveBeenCalledWith({ type: 'human.input', version: 1, generation: 1, input: 'bc' })
})

it('discards pending keys when reconnect confirms the old operation is gone', async () => {
  const { transport, terminal, current } = await bench()
  act(() => { terminal.input('a', true); terminal.input('bc', true) })
  await transport.close()
  await waitFor(() => expect(transport.attach).toHaveBeenCalledTimes(2))
  await attachController(transport)
  expect(screen.getByText('Unsent input discarded.')).toBeTruthy()
  act(() => current().input('x', true))
  expect(transport.connections[1]!.send).toHaveBeenCalledWith({ type: 'human.begin', version: 1, generation: 1, input: 'x' })
})

it('resnapshots on gaps and slow-consumer closure, ignores duplicates and stale connection output', async () => {
  const { transport, current } = await bench()
  await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 0, output: 'duplicate' })
  await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 2, output: 'gap' })
  expect(transport.attach).toHaveBeenCalledTimes(2)
  await transport.receive({ ...snapshot, snapshot: { ...snapshot.snapshot, sequence: 2, replay: 'fresh' } })
  await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 3, output: 'live' })
  await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 4, output: 'stale' }, 0)
  await waitFor(() => expect(current().buffer.active.getLine(0)!.translateToString(true)).toBe('freshlive'))
  await transport.close(1013)
  await waitFor(() => expect(transport.attach).toHaveBeenCalledTimes(3))
})

it('clears proof and pending input on reset, while protocol/disposal closes wait for explicit reconnect', async () => {
  const { transport, terminal } = await bench()
  act(() => { terminal.input('a', true); terminal.input('bc', true) })
  await transport.close(4001)
  await waitFor(() => expect(transport.attach).toHaveBeenCalledTimes(2))
  expect(transport.attach.mock.calls[1]![1]).toEqual({ readonly: false })
  expect(screen.getByText('Unsent input discarded.')).toBeTruthy()
  await attachController(transport)
  await transport.close(1008)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(transport.attach).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await transport.close(4002)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(transport.attach).toHaveBeenCalledTimes(3)
})

it('stops socket and renderer immediately on plugin transport disposal', async () => {
  const { transport, terminal } = await bench()
  const dispose = vi.spyOn(terminal, 'dispose')
  act(() => transport.dispose())
  expect(transport.connections[0]!.close).toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledTimes(1)
  await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 1, output: 'stale' })
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('discards obsolete pending input visibly on invalid resume and retries without the expired proof', async () => {
  const { transport, terminal } = await bench()
  act(() => { terminal.input('a', true); terminal.input('bc', true) })
  await transport.close()
  await waitFor(() => expect(transport.attach).toHaveBeenCalledTimes(2))
  await transport.receive(snapshot)
  await transport.receive({ version: 1, generation: 1, type: 'terminal.attached', mode: 'readonly', reason: 'invalid-resume', maxInputBytes: 32 })
  expect(screen.getByText(/Unsent input discarded/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  expect(transport.attach.mock.calls[2]![1]).toEqual({ readonly: false })
})
