// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Terminal } from '@xterm/xterm'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { TerminalOverlayProps } from '../../src/client/TerminalOverlay.tsx'
import { apply, inject } from '../../src/client/index.ts'
import { createTerminalClientTransport, parseServerFrame } from '../../src/client/protocol.ts'
import { TerminalOverlay } from '../../src/client/TerminalOverlay.tsx'
import type { TakeoverId } from '../../src/protocol.ts'
import { attachController, fakeClientTransport, FakeWebSocket, snapshot, testSessionId } from './fixtures.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeWebSocket.instances = [] })
const takeoverId = (value: string) => value as TakeoverId

describe('terminal overlay', () => {
  it.each([
    ['controller', 'human', 'human'], ['controller', 'model-send', 'model'],
    ['readonly', 'human', 'human'], ['readonly', 'model-send', 'model'],
  ] as const)('shows the authoritative %s holder %s as %s', async (mode, holder, label) => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await transport.receive(snapshot)
    await transport.receive(mode === 'controller'
      ? { type: 'terminal.attached', version: 1, generation: 1, mode, resume: 'proof', maxInputBytes: 32 }
      : { type: 'terminal.attached', version: 1, generation: 1, mode, reason: 'controller-busy', maxInputBytes: 32 })
    await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus: 'busy', holder, takeoverId: holder === 'model-send' ? takeoverId('1') : null, pendingCount: 0 })
    expect(screen.getByRole('status').textContent).toBe(`connected ${label}`)
  })

  it('requests takeover without input and enables typing only after the exact grant', async () => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    const focus = vi.spyOn(Terminal.prototype, 'focus')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus: 'busy', holder: 'model-send', takeoverId: takeoverId('7'), pendingCount: 1 })
    act(() => terminal.input('cached', true))
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()

    const takeover = screen.getByRole('button', { name: 'Take over input' }) as HTMLButtonElement
    expect(takeover.disabled).toBe(false)
    fireEvent.click(takeover)
    expect(transport.connections[0]!.send).toHaveBeenCalledWith({ type: 'human.takeover', version: 1, generation: 1, target: '7' })
    act(() => terminal.input('early', true))
    expect(transport.connections[0]!.send).toHaveBeenCalledTimes(1)
    expect(focus).not.toHaveBeenCalled()

    await transport.receive({ type: 'human.granted', version: 1, generation: 1 })
    expect(focus).toHaveBeenCalledOnce()
    act(() => terminal.input('Y\r', true))
    expect(transport.connections[0]!.send).toHaveBeenLastCalledWith({ type: 'human.input', version: 1, generation: 1, input: 'Y\r' })
  })

  it('does not flush typed data after a stale takeover is rejected', async () => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus: 'busy', holder: 'model-send', takeoverId: takeoverId('8'), pendingCount: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Take over input' }))
    act(() => terminal.input('stale', true))
    await transport.receive({ type: 'terminal.error', version: 1, generation: 1, code: 'operation-failed', message: 'Takeover is stale.' })
    await transport.receive({ type: 'human.revoked', version: 1, generation: 1 })
    await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus: 'busy', holder: 'model-send', takeoverId: null, pendingCount: 0 })
    await transport.receive({ type: 'human.granted', version: 1, generation: 1 })
    expect(transport.connections[0]!.send).toHaveBeenCalledTimes(1)
    expect(transport.connections[0]!.send).toHaveBeenCalledWith({ type: 'human.takeover', version: 1, generation: 1, target: '8' })
    expect(screen.getByText('Takeover is stale.')).toBeTruthy()
  })

  it.each(['ready', 'busy'] as const)('does not turn device replies into human ownership while %s', async queueStatus => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    await transport.receive({ type: 'terminal.status', version: 1, generation: 1, status: { kind: 'running' }, queueStatus, holder: queueStatus === 'busy' ? 'model-send' : null, takeoverId: queueStatus === 'busy' ? takeoverId('1') : null, pendingCount: 0 })
    const replies: string[] = []
    const listener = terminal.onData(data => replies.push(data))
    terminal.options.windowOptions = { getWinSizePixels: true, getCellSizePixels: true, getWinSizeChars: true }
    await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 1, output: '\x1b[6n\x1b[5n\x1b[?6n\x1b[c\x1b[>c\x1b[4$p\x1b[?25$p\x1bP$qm\x1b\\\x1b]4;1;#123456;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b[14t\x1b[16t\x1b[18t' })
    await act(async () => { await new Promise<void>(resolve => terminal.write('', resolve)) })
    expect(replies.length).toBe(15)
    expect(replies).toContain('\x1b]4;1;rgb:1212/3434/5656\x1b\\')
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Interrupt input' }) as HTMLButtonElement).disabled).toBe(true)
    listener.dispose()
  })

  it('ignores parser and DOM focus reports without suppressing response-shaped paste or mixed modes', async () => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    const replies: string[] = []
    const listener = terminal.onData(data => replies.push(data))
    await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 1, output: '\x1b[?1004;2004h' })
    await act(async () => { await new Promise<void>(resolve => terminal.write('', resolve)) })
    expect(terminal.modes.bracketedPasteMode).toBe(true)
    fireEvent.focus(terminal.textarea!)
    fireEvent.blur(terminal.textarea!)
    expect(replies).toEqual(['\x1b[O', '\x1b[I', '\x1b[O'])
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()
    fireEvent.paste(terminal.textarea!, { clipboardData: { getData: () => '\x1b[1;1R' } })
    expect(transport.connections[0]!.send).toHaveBeenCalledWith({ type: 'human.begin', version: 1, generation: 1, input: '\x1b[200~\x1b[1;1R\x1b[201~' })
    await transport.receive({ type: 'human.granted', version: 1, generation: 1 })
    terminal.options.ignoreBracketedPasteMode = true
    fireEvent.paste(terminal.textarea!, { clipboardData: { getData: () => '\x1b[1;1R' } })
    expect(transport.connections[0]!.send).toHaveBeenLastCalledWith({ type: 'human.input', version: 1, generation: 1, input: '\x1b[1;1R' })
    listener.dispose()
  })

  it.each(['keyboard', 'paste', 'composition'] as const)('retains real %s input while an output parse is paused', async inputKind => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    let parsed!: () => void
    let continueParsing!: (handled: boolean) => void
    const reached = new Promise<void>(resolve => { parsed = resolve })
    const paused = new Promise<boolean>(resolve => { continueParsing = resolve })
    const handler = terminal.parser.registerCsiHandler({ final: 'z' }, () => { parsed(); return paused })
    await transport.receive({ type: 'terminal.output', version: 1, generation: 1, sequence: 1, output: '\x1b[z' })
    await reached
    const textarea = terminal.textarea!
    if (inputKind === 'keyboard') fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 })
    else if (inputKind === 'paste') fireEvent.paste(textarea, { clipboardData: { getData: () => 'paste' } })
    else {
      fireEvent.compositionStart(textarea)
      textarea.value = '字'
      fireEvent.compositionUpdate(textarea, { data: '字' })
      fireEvent.compositionEnd(textarea, { data: '字' })
    }
    try {
      await waitFor(() => expect(transport.connections[0]!.send).toHaveBeenCalledWith({ type: 'human.begin', version: 1, generation: 1, input: inputKind === 'keyboard' ? '\r' : inputKind === 'paste' ? 'paste' : '字' }))
    } finally { continueParsing(true); handler.dispose() }
  })

  it('attaches only after expansion for the injected selected session', async () => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('session-a')} transport={transport} mobile={false} />)
    expect(transport.attach).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(transport.attach).toHaveBeenCalledWith('session-a', expect.objectContaining({ readonly: false }), expect.any(Object))
  })

  it('keeps terminal settings hidden until requested', () => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })

  it('closes settings with the panel and reopens both from the settings button', () => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    const terminal = screen.getByRole('button', { name: 'Terminal' })
    const settings = screen.getByRole('button', { name: 'Terminal settings' })
    fireEvent.click(settings)
    fireEvent.click(terminal)
    expect(settings.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    fireEvent.click(settings)
    expect(terminal.getAttribute('aria-expanded')).toBe('true')
    expect(settings.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })

  it('sends the first idle key once, buffers later keys until grant, and interrupts the lease', async () => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('session-a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    const input = vi.spyOn(Terminal.prototype, 'open')
    await attachController(transport)
    const type = (data: string) => (input.mock.contexts[0] as Terminal).input(data, true)
    act(() => { type('e'); type('cho\r') })
    expect(transport.connections[0]!.send.mock.calls.map(([frame]) => frame)).toEqual([{ version: 1, generation: 1, type: 'human.begin', input: 'e' }])
    await transport.receive({ version: 1, generation: 1, type: 'human.granted' })
    expect(transport.connections[0]!.send).toHaveBeenLastCalledWith({ version: 1, generation: 1, type: 'human.input', input: 'cho\r' })
    expect((screen.getByRole('button', { name: 'Interrupt input' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset Terminal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }))
    expect((screen.getByRole('button', { name: 'Interrupt input' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt input' }))
    expect(transport.connections[0]!.send).toHaveBeenLastCalledWith({ version: 1, generation: 1, type: 'human.cancel' })
    input.mockRestore()
  })

  it('keeps geometry fixed through font controls and local clear', async () => {
    const transport = fakeClientTransport()
    const open = vi.spyOn(Terminal.prototype, 'open')
    const resize = vi.spyOn(Terminal.prototype, 'resize')
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    const terminal = open.mock.contexts[0] as Terminal
    expect(terminal.options.scrollback).toBe(20)
    expect(terminal.options.theme?.background).toBe('#ffffff')
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Larger terminal text' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear view' }))
    expect([terminal.cols, terminal.rows, terminal.options.fontSize]).toEqual([12, 3, 15])
    expect(resize).not.toHaveBeenCalled()
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()
  })

  it('counts UTF-8 bytes across first, pending and sent keys and refuses overflow', async () => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    const input = vi.spyOn(Terminal.prototype, 'open')
    await attachController(transport)
    const type = (data: string) => (input.mock.contexts[0] as Terminal).input(data, true)
    act(() => { type('界'.repeat(10)) })
    expect(transport.connections[0]!.send).toHaveBeenCalledTimes(1)
    await transport.receive({ version: 1, generation: 1, type: 'human.granted' })
    act(() => { type('界') })
    expect(screen.getByText(/Input limit reached/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Interrupt input' }) as HTMLButtonElement).disabled).toBe(false)
    input.mockRestore()
  })

  it.each([false, true])('disables input and reset for read-only or mobile (%s)', async mobile => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={mobile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    const input = vi.spyOn(Terminal.prototype, 'open')
    await transport.receive(snapshot)
    await transport.receive({ version: 1, generation: 1, type: 'terminal.attached', mode: 'readonly', reason: mobile ? 'readonly' : 'controller-busy', maxInputBytes: 32 })
    act(() => (input.mock.contexts[0] as Terminal).input('x', true))
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()
    expect(screen.getByText('Read only')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Take over input' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    expect((screen.getByRole('button', { name: 'Reset Terminal' }) as HTMLButtonElement).disabled).toBe(true)
    input.mockRestore()
  })

  it.each(['blocked', 'exited'] as const)('allows a controller to confirm reset from %s', async queueStatus => {
    const transport = fakeClientTransport()
    render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await attachController(transport)
    await transport.receive({ version: 1, generation: 1, type: 'terminal.status', queueStatus, status: queueStatus === 'exited' ? { kind: 'exited', exitCode: 0, signal: null } : { kind: 'running' }, holder: null, takeoverId: null, pendingCount: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset Terminal' }))
    expect(transport.connections[0]!.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }))
    expect(transport.connections[0]!.send).toHaveBeenCalledWith({ version: 1, generation: 1, type: 'terminal.reset', confirmed: true })
  })

  it('preserves the socket on collapse and disposes renderer and socket on session switch/unmount', async () => {
    const transport = fakeClientTransport()
    const view = render(<TerminalOverlay sessionId={testSessionId('a')} transport={transport} mobile={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    const dispose = vi.spyOn(Terminal.prototype, 'dispose')
    await attachController(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(transport.connections[0]!.close).not.toHaveBeenCalled()
    view.rerender(<TerminalOverlay sessionId={testSessionId('b')} transport={transport} mobile={false} />)
    await waitFor(() => expect(transport.connections[0]!.close).toHaveBeenCalled())
    expect(dispose).toHaveBeenCalledTimes(1)
    view.unmount()
    dispose.mockRestore()
  })
})

it('registers an additive shell overlay and effect disposal aborts mounted credentials', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const calls: AbortSignal[] = []
  const rpc = { call: vi.fn((_channel: string, _endpoint: string, _payload: unknown, signal: AbortSignal) => {
    calls.push(signal)
    return new Promise<never>(() => {})
  }) }
  const disposers: (() => void)[] = []
  let props!: Pick<TerminalOverlayProps, 'transport' | 'mobile'>
  const register = vi.fn((entry: { name: string; id: string; order: number; inject(): typeof props }, component: typeof TerminalOverlay) => {
    expect(entry).toMatchObject({ name: 'conversation.input.dock', id: 'dsh-interactive-terminal', order: 100 })
    expect(component).toBe(TerminalOverlay)
    props = entry.inject()
    return () => {}
  })
  // Published SlotTestRuntime imports an omitted private renderer source file in rc.8.
  // This fixture checks the public injection/effect calls without copying its renderer.
  const ctx = {
    connection: { rpc },
    effect(setup: () => () => void) { disposers.push(setup()) },
    slots: { register, inject(key: string, setup: () => () => void) { expect(key).toBe('conversation.input.dock'); disposers.push(setup()) } },
  } as unknown as ClientContext
  expect(inject).toEqual(['slots', 'connection'])
  apply(ctx)
  const view = render(<TerminalOverlay sessionId={testSessionId('a')} {...props} />)
  try {
    expect(rpc.call).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(rpc.call).toHaveBeenCalledWith('/dsh-interactive-terminal', 'token', { sessionId: 'a', readonly: false }, expect.any(AbortSignal))
    view.rerender(<TerminalOverlay sessionId={testSessionId('b')} {...props} />)
    expect(calls[0]!.aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    act(() => { for (const dispose of disposers.reverse()) dispose() })
    expect(calls[1]!.aborted).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(0)
  } finally { view.unmount() }
})

it('uses the credential subprotocol without leaking it into the URL and rejects stale token completion', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const credential = { ok: true as const, value: { token: 'secret', version: 1, path: '/dsh-interactive-terminal/ws', protocol: 'dsh-interactive-terminal.v1' } }
  let resolve!: (value: typeof credential) => void
  const rpc = { call: vi.fn(() => new Promise<typeof credential>(done => { resolve = done })) }
  const transport = createTerminalClientTransport({ rpc })
  const handlers = { frame: vi.fn(), close: vi.fn() }
  const stale = transport.attach('a', { readonly: false }, handlers)
  stale.dispose()
  resolve(credential)
  await Promise.resolve()
  expect(FakeWebSocket.instances).toHaveLength(0)
  transport.attach('b', { readonly: true }, handlers)
  resolve(credential)
  await Promise.resolve()
  const socket = FakeWebSocket.instances[0]!
  expect(socket.url).toBe('ws://localhost:3000/dsh-interactive-terminal/ws')
  expect(socket.protocols).toEqual(['dsh-interactive-terminal.v1', 'token.secret'])
  socket.receive(snapshot)
  expect(handlers.frame).toHaveBeenCalledWith(snapshot)
  socket.receive({ type: 'terminal.output', version: 9, generation: 1, output: 'bad', sequence: 1 })
  expect(handlers.close).toHaveBeenCalledWith(1008)
  expect(socket.close).toHaveBeenCalledTimes(1)
  transport.dispose()
})

it('rejects malformed wire frames before changing renderer/input state', () => {
  for (const value of [
    null,
    {},
    { version: 1, generation: 1, type: 'unknown' },
    { ...snapshot, scrollbackLines: -1 },
    { version: 1, generation: 1, type: 'terminal.attached', mode: 'controller', resume: 'proof', maxInputBytes: 0 },
    { version: 1, generation: 1, type: 'terminal.status', status: { kind: 'running' }, queueStatus: 'busy', holder: 'model-send', pendingCount: 0 },
    { version: 1, generation: 1, type: 'terminal.status', status: { kind: 'running' }, queueStatus: 'busy', holder: 'model-send', takeoverId: 'bad', pendingCount: 0 },
  ]) expect(() => parseServerFrame(value)).toThrow('Invalid terminal frame')
})
