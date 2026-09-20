// @vitest-environment jsdom
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import { TerminalOverlay } from '../../src/client/TerminalOverlay.tsx'
import { attachController, fakeClientTransport, snapshot, testSessionId } from './fixtures.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function setup() {
  const transport = fakeClientTransport()
  const open = vi.spyOn(Terminal.prototype, 'open')
  const commit = vi.fn()
  const view = render(<Profiler id="terminal" onRender={commit}><TerminalOverlay sessionId={testSessionId('output')} transport={transport} mobile={false} /></Profiler>)
  fireEvent.click(screen.getByRole('button', { name: /^(Open terminal|Terminal)$/ }))
  await attachController(transport)
  const current = () => open.mock.contexts.at(-1) as Terminal
  await act(async () => { await new Promise<void>(resolve => current().write('', resolve)) })
  const output = (sequence: number, text: string, index?: number) => transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence, output: text }, index)
  const reconnect = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  }
  return { transport, current, commit, output, reconnect, view }
}

it('submits a burst to xterm before waiting for any parse callback', async () => {
  const { current, output } = await setup()
  // Hold parser completion to expose application-level serialization deterministically.
  const write = vi.spyOn(current(), 'write').mockImplementation(() => {})
  for (let i = 1; i <= 100; i++) await output(i, `part${i}`)
  expect(write.mock.calls.map(([text]) => text)).toEqual(Array.from({ length: 100 }, (_, i) => `part${i + 1}`))
})

it('does not commit React updates for output-only frames', async () => {
  const { commit, output } = await setup()
  commit.mockClear()
  for (let i = 1; i <= 10; i++) await output(i, 'x')
  expect(commit).not.toHaveBeenCalled()
})

it('parses split ANSI sequences and Unicode in wire order after snapshot replay', async () => {
  const { current, output, transport } = await setup()
  await output(1, '\r\x1b[')
  await output(2, '2K\x1b[31')
  await output(3, 'm红')
  await output(4, '色\x1b[0m!')
  await waitFor(() => expect(current().buffer.active.getLine(0)!.translateToString(true)).toBe('红色!'))
  expect(current().buffer.active.getLine(0)!.getCell(0)!.getFgColor()).toBe(1)
  expect(transport.connections[0]!.send).not.toHaveBeenCalled()
})

it.each([1, 2])('replaces a renderer with pending output on snapshot generation %s and retains font size', async generation => {
  const { current, output, transport, reconnect } = await setup()
  const old = current()
  const dispose = vi.spyOn(old, 'dispose')
  fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Larger terminal text' }))
  fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
  vi.spyOn(old, 'write').mockImplementation(() => {})
  await output(1, 'old queued output')
  reconnect()
  await transport.receive({ ...snapshot, generation, snapshot: { ...snapshot.snapshot, sequence: 4, replay: 'fresh' } })
  await transport.receive({ type: 'terminal.output', version: 1, generation, sequence: 5, output: 'live' })
  await output(6, 'stale', 0)
  expect(current()).not.toBe(old)
  expect(dispose).toHaveBeenCalledOnce()
  expect(current().options.fontSize).toBe(15)
  await waitFor(() => expect(current().buffer.active.getLine(0)!.translateToString(true)).toBe('freshlive'))
  act(() => old.input('obsolete input', true))
  expect(transport.connections[1]!.send).not.toHaveBeenCalled()
})

it('rejects a mismatched generation before writing to the renderer', async () => {
  const { current, transport } = await setup()
  const write = vi.spyOn(current(), 'write')
  await transport.receive({ type: 'terminal.output', version: 1, generation: 2, sequence: 1, output: 'wrong shell' })
  expect(write).not.toHaveBeenCalled()
  expect(transport.connections[0]!.close).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toContain('disconnected')
})

it.each([true, false])('restores terminal focus on automatic resnapshot only when it was focused (%s)', async focused => {
  const { current, transport, output } = await setup()
  const old = current()
  if (focused) act(() => old.focus())
  else screen.getByRole('button', { name: 'Terminal settings' }).focus()
  const previouslyFocused = document.activeElement
  await output(2, 'gap')
  await attachController(transport)
  expect(current()).not.toBe(old)
  expect(document.activeElement).toBe(focused ? current().textarea : previouslyFocused)
})

it.each(['snapshot', 'output'] as const)('reports native write failure on %s and waits for explicit reconnect', async phase => {
  const { current, transport, output, reconnect } = await setup()
  if (phase === 'snapshot') reconnect()
  // A native-buffer refusal must not turn into an unhandled promise rejection.
  const write = vi.spyOn(Terminal.prototype, 'write').mockImplementation(() => { throw new Error('write data discarded, use flow control to avoid losing data') })
  if (phase === 'snapshot') await transport.receive(snapshot)
  else await output(1, 'overflow')
  expect(screen.getByRole('alert').textContent).toContain('Terminal output could not be rendered')
  expect(current().options.disableStdin).toBe(true)
  const connections = transport.connections.length
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  expect(transport.connections.length).toBe(connections)
  write.mockRestore()
  if (phase === 'output') fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await attachController(transport)
  await waitFor(() => expect(current().buffer.active.getLine(0)!.translateToString(true)).toBe('ready'))
  expect(screen.queryByRole('alert')).toBeNull()
})
