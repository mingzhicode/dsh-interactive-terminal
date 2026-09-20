import { once } from 'node:events'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '../src/config.ts'
import { TerminalTransport, RPC_CHANNEL, WS_PATH, WS_PROTOCOL } from '../src/transport.ts'
import type { ServerFrame } from '../src/protocol.ts'
import type { TerminalEvent } from '../src/terminal.ts'
import { deferred } from './fixtures/fake-clock.ts'
import { InteractiveTerminalService } from '../src/service.ts'
import { fakeAgent, makeService, serviceContext } from './fixtures/fake-agent.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function makeTransport(overrides: Partial<Config> = {}) {
  const { ctx, subprocess } = serviceContext()
  const config = { ...DEFAULT_CONFIG, disconnectGraceMs: 40, interruptTimeoutMs: 100, ...overrides }
  const service = makeService(config, ctx)
  const webFiber = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const web = ctx.webServer
  const connectionFiber = await ctx.plugin({ inject: ['webServer'], apply: scope => { new HostConnectionService(scope, []) } })
  const transport = new TerminalTransport(ctx, config)
  const agent = fakeAgent('a', ctx)
  const origin = `http://127.0.0.1:${web.port}`
  const rpc = async (payload: unknown, endpoint = 'token') => {
    const response = await fetch(`${origin}${RPC_CHANNEL}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: endpoint, payload }) })
    return response.json()
  }
  cleanups.push(async () => { await service.dispose(); await transport.dispose(); await connectionFiber.dispose(); await webFiber.dispose() })
  return { ctx, transport, service, subprocess, agent, origin, rpc }
}
type Fixture = Awaited<ReturnType<typeof makeTransport>>

async function attachAndCapture(f: Fixture, options: { resume?: string; readonly?: boolean } = {}) {
  const token = await f.transport.issueToken(f.agent, options)
  const socket = new WebSocket(`${f.origin.replace('http:', 'ws:')}${WS_PATH}`, [WS_PROTOCOL, `token.${token}`], { origin: f.origin })
  const frames: ServerFrame[] = []
  socket.on('message', data => frames.push(JSON.parse(data.toString()) as ServerFrame))
  socket.on('error', () => undefined)
  await once(socket, 'open')
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'terminal.attached')).toBe(true))
  const attached = frames.find(frame => frame.type === 'terminal.attached')!
  if (attached.type !== 'terminal.attached') throw new Error('missing attachment')
  const send = (type: string, extra: Record<string, unknown> = {}) => socket.send(JSON.stringify({ version: 1, generation: attached.generation, type, ...extra }))
  cleanups.push(async () => { if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed } })
  return { socket, frames, attached, send }
}
async function attachController(f: Fixture, options: { resume?: string; readonly?: boolean } = {}) { return attachAndCapture(f, options) }

describe('terminal Web transport', () => {
  it('accepts one exact-Agent token once and expires at ten seconds', async () => {
    const f = await makeTransport()
    const token = await f.transport.issueToken(f.agent)
    await expect(f.transport.consumeToken(token, fakeAgent('b', f.ctx))).rejects.toThrow('invalid or expired')
    await expect(f.transport.consumeToken(token, f.agent)).resolves.toMatchObject({ agent: f.agent })
    await expect(f.transport.consumeToken(token, f.agent)).rejects.toThrow('invalid or expired')
    const expiring = await f.transport.issueToken(f.agent)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    await expect(f.transport.consumeToken(expiring, f.agent)).rejects.toThrow('invalid or expired')
  })

  it('registers public trusted-host RPC and an exact WebSocket route', async () => {
    const f = await makeTransport()
    expect(await f.rpc({ sessionId: f.agent.id, readonly: false })).toMatchObject({ type: 'server-response', result: { ok: true, value: { token: expect.any(String), version: 1, path: WS_PATH } } })
    for (const payload of [{ sessionId: f.agent.id }, { sessionId: f.agent.id, readonly: false, agent: 'other' }]) {
      expect(await f.rpc(payload)).toMatchObject({ result: { ok: false, error: { code: 'bad-request' } } })
    }
    expect(await f.rpc({ sessionId: 'dead', readonly: false })).toMatchObject({ result: { ok: false, error: { code: 'session-not-found' } } })
    expect(await f.rpc({}, 'other')).toMatchObject({ result: { ok: false } })
    expect((await fetch(`${f.origin}${RPC_CHANNEL}/token`, { method: 'POST', headers: { Origin: 'http://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
    await f.transport.dispose()
    expect((await fetch(`${f.origin}${RPC_CHANNEL}/token`, { method: 'POST' })).status).toBe(404)
  })

  it('sends snapshot first and then only newer live output', async () => {
    const f = await makeTransport()
    const a = await attachAndCapture(f)
    expect(a.frames[0]).toMatchObject({ type: 'terminal.snapshot', version: 1, scrollbackLines: DEFAULT_CONFIG.scrollbackLines, snapshot: { sequence: expect.any(Number) } })
    f.subprocess.handles[0]!.output.write('next')
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.output' && frame.output === 'next')).toBe(true))
    const snapshot = a.frames[0]!
    if (snapshot.type !== 'terminal.snapshot') throw new Error('missing snapshot')
    expect(a.frames.filter(frame => frame.type === 'terminal.output').every(frame => frame.sequence > snapshot.snapshot.sequence)).toBe(true)
    a.send('heartbeat')
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'heartbeat')).toBe(true))
  })

  it('keeps another page and mobile read-only, including reset authority', async () => {
    const f = await makeTransport()
    const first = await attachController(f)
    const second = await attachController(f)
    const mobile = await attachController(f, { readonly: true })
    expect(first.attached).toMatchObject({ mode: 'controller', resume: expect.any(String), maxInputBytes: DEFAULT_CONFIG.maxInputBytes })
    expect(second.attached).toMatchObject({ mode: 'readonly', reason: 'controller-busy' })
    expect(mobile.attached).toMatchObject({ mode: 'readonly', reason: 'readonly' })
    const closed = once(second.socket, 'close')
    second.send('terminal.reset', { confirmed: true })
    expect((await closed)[0]).toBe(1008)
    expect(f.subprocess.handles).toHaveLength(1)
  })

  it.each([
    '{', JSON.stringify({ type: 'heartbeat', version: 2, generation: 1 }),
    JSON.stringify({ type: 'resize', version: 1, generation: 1 }),
    JSON.stringify({ type: 'human.input', version: 1, generation: 1, input: 'x' }),
    JSON.stringify({ type: 'heartbeat', version: 1, generation: 99 }),
    JSON.stringify({ type: 'heartbeat', version: 1, generation: 1, sessionId: 'a' }),
    JSON.stringify({ type: 'human.takeover', version: 1, generation: 1, target: 'not-an-operation' }),
    JSON.stringify({ type: 'terminal.reset', version: 1, generation: 1, confirmed: false }),
  ])('closes invalid client protocol: %s', async message => {
    const f = await makeTransport()
    const a = await attachAndCapture(f)
    const closed = once(a.socket, 'close')
    a.socket.send(message)
    expect((await closed).slice(0, 2).map(value => Buffer.isBuffer(value) ? value.toString() : value)).toEqual([1008, 'terminal-protocol-error'])
  })

  it('uses ws payload/UTF-8 limits and bounds decoded input bytes', async () => {
    const f = await makeTransport({ maxInputBytes: 4 })
    const a = await attachAndCapture(f)
    const closed = once(a.socket, 'close')
    a.send('human.begin', { input: '界界' })
    expect((await closed)[0]).toBe(1008)
    const b = await attachAndCapture(f, { readonly: true })
    const oversized = once(b.socket, 'close')
    b.socket.send('x'.repeat(5000))
    expect((await oversized)[0]).toBe(1009)
    const c = await attachAndCapture(f, { readonly: true })
    const invalid = once(c.socket, 'close')
    c.socket.send(Buffer.from([0xff]), { binary: false })
    expect((await invalid)[0]).toBe(1007)
  })

  it('rejects foreign/missing origins, query credentials, wrong path and protocol versions', async () => {
    const f = await makeTransport()
    for (const variation of [ { origin: 'http://evil.test' }, { origin: undefined }, { path: `${WS_PATH}?token=secret` }, { path: `${WS_PATH}/extra` }, { protocol: 'dsh-interactive-terminal.v2' } ]) {
      const token = await f.transport.issueToken(f.agent)
      const socket = new WebSocket(`${f.origin.replace('http:', 'ws:')}${'path' in variation ? variation.path : WS_PATH}`, [variation.protocol ?? WS_PROTOCOL, `token.${token}`], { ...(!('origin' in variation) ? { origin: f.origin } : variation.origin ? { origin: variation.origin } : {}) })
      const error = once(socket, 'error')
      expect(String((await error)[0])).toMatch(/Unexpected server response|socket hang up/)
    }
  })

  it('requires the private resume proof to reconnect during grace and retains human input', async () => {
    const f = await makeTransport({ disconnectGraceMs: 400 })
    const a = await attachController(f)
    a.send('human.begin', { input: 'one' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    expect((await attachController(f)).attached.mode).toBe('readonly')
    const resume = a.attached.mode === 'controller' ? a.attached.resume : ''
    const b = await attachController(f, { resume })
    expect(b.attached.mode).toBe('controller')
    await vi.waitFor(() => expect(b.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    b.send('human.input', { input: 'two' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('two'))
    expect(f.subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()
  })

  it('cancels the existing human on expiry, holding controller ownership through recovery', async () => {
    const f = await makeTransport({ interruptTimeoutMs: 2000 })
    const a = await attachController(f)
    a.send('human.begin', { input: 'held' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.signalForeground).toHaveBeenCalledWith('SIGINT'))
    expect((await attachController(f)).attached.mode).toBe('readonly')
    const resume = a.attached.mode === 'controller' ? a.attached.resume : ''
    expect((await attachController(f, { resume })).attached.mode).toBe('readonly')
    const record = await f.service.ensure(f.agent)
    f.subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await vi.waitFor(() => expect(record.terminal.queue.status()).toBe('ready'))
    expect((await attachController(f)).attached.mode).toBe('controller')
  })

  it('takes over the exact published model operation without sending initial input', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'ask', submit: true })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('ask\r'))
    const status = await vi.waitFor(() => {
      const current = a.frames.findLast(frame => frame.type === 'terminal.status' && typeof frame.takeoverId === 'string')
      expect(current).toBeTruthy()
      return current!
    })
    if (status.type !== 'terminal.status' || status.takeoverId === null) throw new Error('missing takeover target')
    const follower = f.service.send(f.agent, { text: 'after', submit: true })

    a.send('human.takeover', { target: status.takeoverId })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff', holder: 'human', pendingCount: 1 })
    expect(f.subprocess.handles[0]!.write.mock.calls).toEqual([['ask\r']])
    a.send('human.input', { input: 'Y\r' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('Y\r'))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.revoked')).toBe(true))
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('after\r'))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await follower
  })

  it('wakes an idle owner once after a reconnected multi-prompt takeover settles', async () => {
    const f = await makeTransport({ disconnectGraceMs: 400 })
    const followup = vi.spyOn(f.agent, 'followup')
    const steer = vi.spyOn(f.agent, 'steer')
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'npm update', submit: true })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('npm update\r'))
    const status = await vi.waitFor(() => {
      const current = a.frames.findLast(frame => frame.type === 'terminal.status' && typeof frame.takeoverId === 'string')
      expect(current).toBeTruthy()
      return current!
    })
    if (status.type !== 'terminal.status' || status.takeoverId === null || a.attached.mode !== 'controller') throw new Error('missing takeover state')
    const resume = a.attached.resume

    a.send('human.takeover', { target: status.takeoverId })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    const closed = once(a.socket, 'close')
    a.socket.close()
    await closed
    const b = await attachController(f, { resume })
    await vi.waitFor(() => expect(b.frames.some(frame => frame.type === 'human.granted')).toBe(true))

    b.send('human.input', { input: 'yes\r' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('yes\r'))
    f.subprocess.handles[0]!.output.write('Install location? ')
    b.send('human.input', { input: '/tmp/npm-cache\r' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('/tmp/npm-cache\r'))
    expect(followup).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()

    const record = await f.service.ensure(f.agent)
    f.subprocess.handles[0]!.output.write(`ANSWER=[yes]\r\nLOCATION=[/tmp/npm-cache]\r\n${record.terminal.prompt.marker}dsh$ `)
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1))
    expect(steer).not.toHaveBeenCalled()
    const message = followup.mock.calls[0]![0]
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-interactive-terminal', form: 'notice' })
    const block = message.content[0]
    if (block?.type !== 'text') throw new Error('missing notice text')
    expect(block.text).toContain('shared_terminal_read')
    expect(block.text).toContain('generation=1')
    expect(block.text).toContain('waitReason=prompt')
    expect(block.text).not.toContain('ANSWER=[yes]')
    expect(block.text).not.toContain('/tmp/npm-cache')
    await Promise.resolve()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('uses waking steering for a completed takeover while the owner is running', async () => {
    const f = await makeTransport()
    Object.defineProperty(f.agent, 'status', { configurable: true, value: 'running' })
    const followup = vi.spyOn(f.agent, 'followup')
    const steer = vi.spyOn(f.agent, 'steer')
    const inject = vi.spyOn(f.agent, 'inject')
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'ask', submit: true })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
    const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
    if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
    a.send('human.takeover', { target: state.takeoverId })
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('does not notify for ordinary input, rejected takeover, or disposed ownership', async () => {
    const f = await makeTransport()
    const followup = vi.spyOn(f.agent, 'followup')
    const steer = vi.spyOn(f.agent, 'steer')
    const a = await attachController(f)
    a.send('human.begin', { input: 'echo ordinary\r' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.revoked')).toBe(true))
    a.send('human.takeover', { target: '999' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.error')).toBe(true))

    const model = f.service.send(f.agent, { text: 'dispose me', submit: true })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
    const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
    if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
    a.send('human.takeover', { target: state.takeoverId })
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    await f.service.disposeAgent(f.agent)
    expect(followup).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
  })

  it('reports an acquired takeover failure once without leaking error or terminal text', async () => {
    const f = await makeTransport()
    const followup = vi.spyOn(f.agent, 'followup')
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'ask', submit: true })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
    const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
    if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
    a.send('human.takeover', { target: state.takeoverId })
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    f.subprocess.handles[0]!.output.write('PRIVATE_TERMINAL_TEXT')
    f.subprocess.handles[0]!.signalForeground.mockRejectedValueOnce(new Error('private transport failure'))
    a.send('human.cancel')
    await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1))
    const block = followup.mock.calls[0]![0].content[0]
    if (block?.type !== 'text') throw new Error('missing notice text')
    expect(block.text).toContain('handoff failed')
    expect(block.text).not.toContain('PRIVATE_TERMINAL_TEXT')
    expect(block.text).not.toContain('private transport failure')
    await Promise.resolve()
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('rejects stale ordinary input and stale takeover targets without buffering either', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'model', submit: false })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('model'))
    a.send('human.begin', { input: 'stale' })
    a.send('human.takeover', { target: '999' })
    await vi.waitFor(() => expect(a.frames.filter(frame => frame.type === 'terminal.error' && frame.code === 'operation-failed')).toHaveLength(2))
    await vi.waitFor(() => expect(a.frames.filter(frame => frame.type === 'human.revoked')).toHaveLength(2))
    expect((await f.service.read(f.agent, { offset: 0, count: 1 })).pendingCount).toBe(0)
    const status = a.frames.findLast(frame => frame.type === 'terminal.status' && typeof frame.takeoverId === 'string')
    if (status?.type !== 'terminal.status' || status.takeoverId === null) throw new Error('missing fresh target')
    a.send('human.takeover', { target: status.takeoverId })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    a.send('human.input', { input: 'fresh' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('fresh'))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    expect(f.subprocess.handles[0]!.write).not.toHaveBeenCalledWith('stale')
  })

  it('revokes tokens, resume proofs and sockets on tool reset and disposal', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    const token = await f.transport.issueToken(f.agent)
    const closed = once(a.socket, 'close')
    await f.service.reset(f.agent)
    expect((await closed)[0]).toBe(4001)
    await expect(f.transport.consumeToken(token, f.agent)).rejects.toThrow('invalid or expired')
    const stale = a.attached.mode === 'controller' ? a.attached.resume : ''
    expect((await attachController(f, { resume: stale })).attached.mode).toBe('readonly')
    const fresh = await attachController(f)
    expect(fresh.attached).toMatchObject({ mode: 'controller', generation: 2 })
    const disposed = once(fresh.socket, 'close')
    await f.service.disposeAgent(f.agent)
    expect((await disposed)[0]).toBe(4002)
  })

  it('buffers publication during snapshot capture and discards chunks covered by its watermark', async () => {
    const f = await makeTransport()
    const attachment = await f.service.attach(f.agent)
    let listener: ((event: TerminalEvent) => void) | undefined
    const attaching = vi.spyOn(InteractiveTerminalService.prototype, 'attach').mockResolvedValue({ ...attachment,
      subscribe: callback => { listener = callback; return attachment.subscribe(callback) },
      read: () => {
        const state = attachment.read()
        const publish = listener
        listener = undefined
        publish?.({ type: 'output', sequence: state.snapshot.sequence, output: 'covered' })
        publish?.({ type: 'output', sequence: state.snapshot.sequence + 1, output: 'raced' })
        return state
      },
    })
    const a = await attachAndCapture(f)
    expect(attaching).toHaveBeenCalled()
    expect(a.frames[0]?.type).toBe('terminal.snapshot')
    await vi.waitFor(() => expect(a.frames.filter(frame => frame.type === 'terminal.output')).toEqual([expect.objectContaining({ output: 'raced' })]))
  })

  it('cancels a disconnected pending begin after grace without writing it', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    const record = await f.service.ensure(f.agent)
    const model = f.service.send(f.agent, { text: 'model', submit: false })
    a.send('human.begin', { input: 'never' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.pendingCount === 1)).toBe(true))
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    await vi.waitFor(async () => expect((await f.service.read(f.agent, { offset: 0, count: 1 })).pendingCount).toBe(0))
    expect(f.subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()
    f.subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await model
    expect(f.subprocess.handles[0]!.write).not.toHaveBeenCalledWith('never')
  })

  it('holds controller authority when disconnection races a pending first write', async () => {
    const f = await makeTransport({ interruptTimeoutMs: 2000 })
    const a = await attachController(f)
    const writing = deferred<void>()
    f.subprocess.handles[0]!.write.mockImplementationOnce(async () => { await writing.promise; return undefined })
    a.send('human.begin', { input: 'pending' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('pending'))
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(f.subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()
    expect((await attachController(f)).attached.mode).toBe('readonly')
    writing.resolve()
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.signalForeground).toHaveBeenCalledWith('SIGINT'))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await vi.waitFor(async () => expect((await f.service.read(f.agent, { offset: 0, count: 1 })).holder).toBe(null))
    expect((await attachController(f)).attached.mode).toBe('controller')
  })

  it('does not honor a token bound to a resume proof after that proof rotates', async () => {
    const f = await makeTransport({ disconnectGraceMs: 500 })
    const a = await attachController(f)
    const resume = a.attached.mode === 'controller' ? a.attached.resume : ''
    const stale = await f.transport.issueToken(f.agent, { resume })
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    const b = await attachController(f, { resume })
    const closedB = once(b.socket, 'close'); b.socket.close(); await closedB
    vi.spyOn(f.transport, 'issueToken').mockResolvedValueOnce(stale)
    expect((await attachController(f)).attached).toMatchObject({ mode: 'readonly', reason: 'invalid-resume' })
  })

  it('unloads and remounts public registrations without leaking sockets or tokens', async () => {
    const f = await makeTransport({ interruptTimeoutMs: 20 })
    await f.transport.dispose()
    const config = { ...DEFAULT_CONFIG, disconnectGraceMs: 20, interruptTimeoutMs: 20 }
    let mounted!: TerminalTransport
    const fiber = await f.ctx.plugin({ inject: TerminalTransport.inject, apply: scope => { mounted = new TerminalTransport(scope, config) } })
    expect(await f.rpc({ sessionId: f.agent.id, readonly: false })).toMatchObject({ result: { ok: true } })
    const a = await attachAndCapture({ ...f, transport: mounted })
    a.send('human.begin', { input: 'active' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    const closed = once(a.socket, 'close')
    await fiber.dispose()
    expect((await closed)[0]).toBe(4002)
    expect((await f.service.ensure(f.agent)).terminal.queue.holder()).toBe(null)
    await expect(mounted.issueToken(f.agent)).rejects.toThrow('disposed')
    expect((await fetch(`${f.origin}${RPC_CHANNEL}/token`, { method: 'POST' })).status).toBe(404)
    const replacement = await f.ctx.plugin(TerminalTransport, config)
    expect(await f.rpc({ sessionId: f.agent.id, readonly: false })).toMatchObject({ result: { ok: true } })
    await replacement.dispose()
  })

  it('finishes socket and operation cleanup even when a route disposer fails', async () => {
    const f = await makeTransport({ interruptTimeoutMs: 20 })
    await f.transport.dispose()
    const register = WebServer.prototype.registerUpgrade
    vi.spyOn(WebServer.prototype, 'registerUpgrade').mockImplementationOnce(function (this: WebServer, route) {
      const remove = register.call(this, route)
      return () => { remove(); throw new Error('route cleanup failed') }
    })
    const transport = new TerminalTransport(f.ctx, { ...DEFAULT_CONFIG, interruptTimeoutMs: 20 })
    const a = await attachAndCapture({ ...f, transport })
    a.send('human.begin', { input: 'active' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    const closed = once(a.socket, 'close')
    await expect(transport.dispose()).rejects.toThrow('cleanup failed')
    expect((await closed)[0]).toBe(4002)
    expect(f.subprocess.handles[0]!.signalForeground).toHaveBeenCalledWith('SIGINT')
    expect((await f.service.ensure(f.agent)).terminal.queue.holder()).toBe(null)
    const replacement = new TerminalTransport(f.ctx, DEFAULT_CONFIG)
    await replacement.dispose()
  })

  it('revokes unspent credentials when reset creates the initial generation', async () => {
    const f = await makeTransport()
    const token = await f.transport.issueToken(f.agent)
    await f.service.reset(f.agent)
    await expect(f.transport.consumeToken(token, f.agent).then(() => 'accepted', (error: Error) => error.message)).resolves.toContain('invalid or expired')
  })

  it('restores a granted takeover on authenticated reconnect', async () => {
    const f = await makeTransport({ disconnectGraceMs: 500 })
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'model', submit: false })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('model'))
    const status = await vi.waitFor(() => {
      const current = a.frames.findLast(frame => frame.type === 'terminal.status' && typeof frame.takeoverId === 'string')
      expect(current).toBeTruthy()
      return current!
    })
    if (status.type !== 'terminal.status' || status.takeoverId === null) throw new Error('missing takeover target')
    a.send('human.takeover', { target: status.takeoverId })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    const resume = a.attached.mode === 'controller' ? a.attached.resume : ''
    const closed = once(a.socket, 'close'); a.socket.close(); await closed
    const b = await attachController(f, { resume })
    await vi.waitFor(() => expect(b.frames).toContainEqual(expect.objectContaining({ type: 'human.granted' })))
    b.send('human.input', { input: 'continued' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('continued'))
    expect(f.subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()
  })

  it('closes a slow consumer before adding more output beyond the retention budget', async () => {
    const f = await makeTransport()
    const a = await attachAndCapture(f)
    const limit = Buffer.byteLength(JSON.stringify(a.frames[0])) + DEFAULT_CONFIG.scrollbackMaxBytes
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(limit - 1)
    const closed = once(a.socket, 'close')
    f.subprocess.handles[0]!.output.write('unbounded peer')
    expect((await closed)[0]).toBe(1013)
  })

  it('allows one escaped initial replay in addition to the live buffering budget', async () => {
    const f = await makeTransport({ scrollbackMaxBytes: 1024, maxToolOutputBytes: 1024 })
    const attachment = await f.service.attach(f.agent)
    vi.spyOn(InteractiveTerminalService.prototype, 'attach').mockResolvedValue({ ...attachment, read: () => {
      const state = attachment.read()
      return { ...state, snapshot: { ...state.snapshot, replay: '\u001b'.repeat(1000) } }
    } })
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValueOnce(0).mockReturnValue(4000)
    const a = await attachAndCapture(f)
    expect(a.attached.mode).toBe('controller')
    expect(a.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('reports a failed accepted input without leaking a rejected socket task', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    a.send('human.begin', { input: 'first' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    f.subprocess.handles[0]!.write.mockRejectedValueOnce(new Error('private provider details'))
    a.send('human.input', { input: 'broken' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.revoked')).toBe(true))
    expect(a.frames).toContainEqual(expect.objectContaining({ type: 'terminal.error', code: 'operation-failed' }))
    expect(JSON.stringify(a.frames)).not.toContain('private provider details')
    expect((await f.service.ensure(f.agent)).terminal.queue.status()).toBe('blocked')
  })

  it('revokes a naturally completed human lease and permits the next operation', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    a.send('human.begin', { input: 'first' })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
    f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.revoked')).toBe(true))
    a.send('human.begin', { input: 'second' })
    await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('second'))
  })

  it('rejects binary input and real WebSocket token replay', async () => {
    const f = await makeTransport()
    const token = await f.transport.issueToken(f.agent)
    vi.spyOn(f.transport, 'issueToken').mockResolvedValueOnce(token)
    const a = await attachAndCapture(f)
    const duplicate = new WebSocket(`${f.origin.replace('http:', 'ws:')}${WS_PATH}`, [WS_PROTOCOL, `token.${token}`], { origin: f.origin })
    expect(String((await once(duplicate, 'error'))[0])).toContain('403')
    const closed = once(a.socket, 'close')
    a.socket.send(Buffer.from('binary'))
    expect((await closed)[0]).toBe(1008)
  })

  it('cancels an owned reset queued behind a model operation when transport unloads', async () => {
    const f = await makeTransport()
    const a = await attachController(f)
    const model = f.service.send(f.agent, { text: 'busy model', submit: false })
    a.send('terminal.reset', { confirmed: true })
    await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.pendingCount === 1)).toBe(true))
    const stopped = vi.fn()
    const disposing = f.transport.dispose().then(stopped)
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled(), { timeout: 200 })
    expect(f.subprocess.handles).toHaveLength(1)
    const record = await f.service.ensure(f.agent)
    expect(record.terminal.queue.holder()?.kind).toBe('model-send')
    f.subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await model
    await disposing
  })
})
