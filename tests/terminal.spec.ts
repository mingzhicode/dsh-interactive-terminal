import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalGeneration } from '../src/terminal.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { fakeOwner, fakeTerminalHandle } from './fixtures/fake-subprocess.ts'
import { TerminalScreen } from '../src/screen.ts'
import { ControlledPrompt } from '../src/prompt.ts'
import { deferred } from './fixtures/fake-clock.ts'
import { spawnSync } from 'node:child_process'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('PTY generation', () => {
  it('waits for the stable final prompt before releasing multiline input', async () => {
    vi.useFakeTimers()
    const handle = fakeTerminalHandle()
    const creating = TerminalGeneration.create(fakeOwner({ handle }), { ...DEFAULT_CONFIG, pollIntervalMs: 5 }, 1)
    await vi.advanceTimersByTimeAsync(1)
    const generation = await creating
    try {
      const first = generation.queue.enqueue({ id: 'first', kind: 'model-send' }, () => generation.write('echo first\necho second\r'))
      const follower = generation.queue.enqueue({ id: 'follower', kind: 'model-send' }, () => generation.write('echo follower\r'))
      await first.lease
      handle.output.write(`${generation.prompt.marker}dsh$ echo second\r\nsecond output\r\n`)
      await vi.advanceTimersByTimeAsync(10)
      expect(generation.queue.holder()?.id).toBe('first')
      handle.output.write(`${generation.prompt.marker}dsh$ `)
      await vi.advanceTimersByTimeAsync(10)
      await expect(follower.lease).resolves.toBeUndefined()
    } finally { await generation.dispose() }
  })

  it('coalesces buffered fragments before publishing and finalizing operation output', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const output: string[] = []
    generation.subscribe(event => { if (event.type === 'output') output.push(event.output) })
    let finish!: ReturnType<TerminalGeneration['captureOutput']>
    try {
      const operation = generation.queue.enqueue({ id: 'burst', kind: 'model-send' }, () => {
        finish = generation.captureOutput('burst')
        return generation.write('burst\r')
      })
      await operation.lease
      for (let i = 0; i < 1000; i++) handle.output.write('x')
      handle.output.write(generation.prompt.marker + generation.prompt.env.PS1)
      await expect(operation.result).resolves.toEqual({ waitReason: 'prompt' })
      expect(output.join('')).toBe('x'.repeat(1000) + generation.prompt.marker + generation.prompt.env.PS1)
      expect((await finish()).output.replaceAll('\n', '')).toBe('x'.repeat(1000) + generation.prompt.env.PS1)
      expect(output.length).toBeLessThanOrEqual(2)
    } finally { await generation.dispose() }
  })

  it('caps aggregated buffered batches at the readable high-water mark and drains them at EOF', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const chunks: string[] = []
    generation.subscribe(event => { if (event.type === 'output') chunks.push(event.output) })
    try {
      const burst = 'x'.repeat(handle.output.readableHighWaterMark * 2 + 10)
      handle.output.write(burst.slice(0, 1))
      handle.output.write(burst.slice(1))
      handle.exit()
      await generation.done
      expect(chunks.join('')).toBe(burst)
      expect(Math.max(...chunks.map(chunk => Buffer.byteLength(chunk)))).toBeLessThanOrEqual(handle.output.readableHighWaterMark)
    } finally { await generation.dispose() }
  })

  it('binds an arriving human prompt before a same-turn append can change its dispatch', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const ingested = deferred<void>()
    generation.subscribe(event => { if (event.type === 'output') ingested.resolve() })
    try {
      const human = generation.queue.enqueue({ id: 'human', kind: 'human' }, () => generation.write('echo old\r'))
      const follower = vi.fn(() => generation.write('follower\r'))
      generation.queue.enqueue({ id: 'model', kind: 'model-send' }, follower)
      await human.lease
      handle.output.write(generation.prompt.marker)
      await human.append(() => generation.write('python\r'))
      await ingested.promise
      await new Promise(resolve => setImmediate(resolve))
      expect(generation.queue.holder()?.id).toBe('human')
      expect(follower).not.toHaveBeenCalled()
    } finally { await generation.dispose() }
  })

  it('retains received output when disposal starts in the same turn', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    let finish!: ReturnType<TerminalGeneration['captureOutput']>
    const operation = generation.queue.enqueue({ id: 'capture', kind: 'model-send' }, () => {
      finish = generation.captureOutput('capture')
      return generation.write('run\r')
    })
    await operation.lease
    handle.output.write('received')
    const disposing = generation.dispose()
    try {
      expect((await finish()).output).toBe('received')
      await disposing
      expect(generation.snapshot().replay).toContain('received')
    } finally { await disposing }
  })

  it('waits a full polling interval after a slow inspection completes', async () => {
    vi.useFakeTimers()
    const handle = fakeTerminalHandle()
    const creating = TerminalGeneration.create(fakeOwner({ handle }), { ...DEFAULT_CONFIG, pollIntervalMs: 50 }, 1)
    await vi.advanceTimersByTimeAsync(1)
    const generation = await creating
    const inspection = deferred<{ processGroupId: number; inputWaiting: boolean }>()
    handle.inspectForeground.mockReturnValueOnce(inspection.promise)
    try {
      const operation = generation.queue.enqueue({ id: 'poll', kind: 'model-send' }, () => generation.write('read\r'))
      await operation.lease
      await vi.advanceTimersByTimeAsync(50)
      expect(handle.inspectForeground).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(213)
      expect(handle.inspectForeground).toHaveBeenCalledTimes(1)
      inspection.resolve({ processGroupId: 456, inputWaiting: false })
      await vi.advanceTimersByTimeAsync(49)
      expect(handle.inspectForeground).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(handle.inspectForeground).toHaveBeenCalledTimes(2)
    } finally {
      inspection.resolve({ processGroupId: 456, inputWaiting: false })
      await generation.dispose()
    }
  })

  it.each(['main', 'capture'] as const)('drains tagged output before disposing a capture during %s-screen teardown', async target => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalWrite = TerminalScreen.prototype.write
    const disposed = vi.spyOn(TerminalScreen.prototype, 'dispose')
    let capture: TerminalScreen | undefined
    vi.spyOn(TerminalScreen.prototype, 'write').mockImplementation(async function (this: TerminalScreen, output) {
      if (output !== 'received') return originalWrite.call(this, output)
      const isCapture = this.snapshot().rows === 1
      if (isCapture) capture = this
      if (isCapture !== (target === 'capture')) return originalWrite.call(this, output)
      if (isCapture) {
        const sequence = await originalWrite.call(this, output)
        entered.resolve()
        await release.promise
        return sequence
      }
      entered.resolve()
      await release.promise
      return originalWrite.call(this, output)
    })
    let finish!: ReturnType<TerminalGeneration['captureOutput']>
    const operation = generation.queue.enqueue({ id: 'draining', kind: 'model-send' }, () => {
      finish = generation.captureOutput('draining')
      return generation.write('run\r')
    })
    let disposing: Promise<void> | undefined
    try {
      await operation.lease
      handle.output.write('received')
      await entered.promise
      disposing = generation.dispose()
      await expect(operation.result).resolves.toEqual({ waitReason: 'cancelled' })
      const finished = vi.fn()
      const result = Promise.resolve(finish()).then(value => { finished(value); return value })
      await new Promise(resolve => setImmediate(resolve))
      expect(finished).not.toHaveBeenCalled()
      if (capture) expect(disposed.mock.contexts).not.toContain(capture)
      release.resolve()
      await expect(result).resolves.toMatchObject({ output: 'received', truncated: false })
      await disposing
      expect(generation.snapshot().replay).toContain('received')
      expect(generation.text().viewport).toContain('received')
      expect(disposed.mock.contexts.filter(value => value === capture)).toHaveLength(1)
    } finally { release.resolve(); await (disposing ?? generation.dispose()) }
  })

  it('spawns fixed geometry through subprocess and confines the argv when required', async () => {
    const spawnTerminal = vi.fn(async () => fakeTerminalHandle())
    const owner = fakeOwner({ spawnTerminal, confined: true })
    const generation = await TerminalGeneration.create(owner, DEFAULT_CONFIG, 1)
    expect(owner.sandboxPolicy.resolve).toHaveBeenCalledExactlyOnceWith({ session: owner.session })
    expect(owner.sandbox!.confine).toHaveBeenCalledWith(['/bin/bash', '--noprofile', '--norc', '-i'], expect.objectContaining({ mode: 'workspace-write' }))
    expect(owner.subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ rows: 40, cols: 160, cwd: '/workspace', argv: ['sandbox-runner', '/bin/bash', '--noprofile', '--norc', '-i'], graceMs: 3000 }))
    await generation.dispose()
  })

  it('terminates a spawned handle when later initialization fails', async () => {
    const handle = fakeTerminalHandle()
    await expect(TerminalGeneration.create(fakeOwner({ handle, failScreen: true }), DEFAULT_CONFIG, 1)).rejects.toThrow('screen failed')
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('uses direct argv and explicit diagnostic environment under full access', async () => {
    const owner = fakeOwner()
    const generation = await TerminalGeneration.create(owner, DEFAULT_CONFIG, 7)
    expect(owner.sandbox!.confine).not.toHaveBeenCalled()
    expect(owner.subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ argv: ['/bin/bash', '--noprofile', '--norc', '-i'], env: expect.objectContaining({ TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', DSH_SHELL: '1', DSH_SESSION_ID: 'test-session' }) }))
    expect(generation.generation).toBe(7)
    await generation.dispose()
  })

  it('fails closed without a sandbox and never spawns after confinement failure', async () => {
    const owner = fakeOwner({ confined: true })
    delete owner.sandbox
    await expect(TerminalGeneration.create(owner, DEFAULT_CONFIG, 1)).rejects.toThrow('sandbox')
    expect(owner.subprocess.spawnTerminal).not.toHaveBeenCalled()
    const failing = fakeOwner({ confined: true })
    vi.mocked(failing.sandbox!.confine).mockImplementation(() => { throw new Error('confinement failed') })
    await expect(TerminalGeneration.create(failing, DEFAULT_CONFIG, 1)).rejects.toThrow('confinement failed')
    expect(failing.subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('waits for its controlled prompt and times out ordinary startup output', async () => {
    const handle = fakeTerminalHandle()
    handle.output.write('dsh$ ready\n')
    await expect(TerminalGeneration.create(fakeOwner({ handle, prompt: false }), { ...DEFAULT_CONFIG, operationTimeoutMs: 30 }, 1)).rejects.toThrow('startup')
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('passes allocation cancellation and rolls back an abort while waiting for the prompt', async () => {
    const controller = new AbortController()
    const handle = fakeTerminalHandle()
    const owner = fakeOwner({ handle, prompt: false })
    const creating = TerminalGeneration.create(owner, DEFAULT_CONFIG, 1, controller.signal)
    const rejected = expect(creating).rejects.toThrow('cancel')
    await vi.waitFor(() => expect(owner.subprocess.spawnTerminal).toHaveBeenCalled())
    controller.abort(new Error('cancel startup'))
    await rejected
    expect(owner.subprocess.spawnTerminal).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
    expect(handle.terminate).toHaveBeenCalledOnce()
    const already = fakeOwner()
    await expect(TerminalGeneration.create(already, DEFAULT_CONFIG, 2, controller.signal)).rejects.toThrow('cancel')
    expect(already.subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('rolls back a handle returned concurrently with allocation cancellation', async () => {
    const controller = new AbortController()
    const handle = fakeTerminalHandle()
    const owner = fakeOwner({ spawnTerminal: async () => { controller.abort(new Error('cancel allocation')); return handle } })
    await expect(TerminalGeneration.create(owner, DEFAULT_CONFIG, 1, controller.signal)).rejects.toThrow('cancel')
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('consumes transport rejection when cancellation prevents screen construction', async () => {
    const controller = new AbortController()
    const handle = fakeTerminalHandle()
    const owner = fakeOwner({ prompt: false, spawnTerminal: async () => {
      controller.abort(new Error('cancel allocation'))
      return { ...handle, done: Promise.reject(new Error('allocation transport closed')) }
    } })
    await expect(TerminalGeneration.create(owner, DEFAULT_CONFIG, 1, controller.signal)).rejects.toThrow('cancel allocation')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('streams split UTF-8 and publishes only after the authoritative screen write', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const original = TerminalScreen.prototype.write
    const release = deferred<void>()
    vi.spyOn(TerminalScreen.prototype, 'write').mockImplementationOnce(async function (this: TerminalScreen, text) { await release.promise; return original.call(this, text) })
    const outputs: string[] = []
    const sequences: number[] = []
    generation.subscribe(event => {
      if (event.type !== 'output') return
      outputs.push(event.output)
      sequences.push(event.sequence)
      expect(generation.snapshot().sequence).toBe(event.sequence)
    })
    const bytes = Buffer.from('你好')
    handle.output.write(bytes.subarray(0, 2))
    handle.output.write(bytes.subarray(2, 4))
    handle.output.write(bytes.subarray(4))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(outputs).toEqual([])
    release.resolve()
    await vi.waitFor(() => expect(outputs.join('')).toBe('你好'))
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(generation.snapshot().replay).toContain('你好')
    await generation.dispose()
  })

  it('drains trailing bytes and retains final snapshot and exit status', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const active = generation.queue.enqueue({ id: 'a', kind: 'model-send' }, () => generation.write('exit\r'))
    await active.lease
    handle.output.write('final output')
    handle.exit({ exitCode: 9, signal: null })
    await expect(generation.done).resolves.toEqual({ exitCode: 9, signal: null })
    await expect(active.result).resolves.toEqual({ waitReason: 'session_exit' })
    const final = generation.snapshot()
    expect(final.replay).toContain('final output')
    expect(generation.status()).toEqual({ kind: 'exited', exitCode: 9, signal: null })
    await expect(generation.write('late')).rejects.toThrow('exited')
    await generation.dispose()
    expect(generation.snapshot()).toEqual(final)
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('rejects startup exit and transport failures with rollback', async () => {
    const handle = fakeTerminalHandle()
    handle.exit({ exitCode: 2, signal: null })
    await expect(TerminalGeneration.create(fakeOwner({ handle, prompt: false }), DEFAULT_CONFIG, 1)).rejects.toThrow('startup')
    expect(handle.terminate).toHaveBeenCalledOnce()
    const broken = fakeTerminalHandle()
    const creating = TerminalGeneration.create(fakeOwner({ handle: broken, prompt: false }), DEFAULT_CONFIG, 1)
    const rejected = expect(creating).rejects.toThrow('transport failed')
    await vi.waitFor(() => expect(broken.output.listenerCount('error')).toBeGreaterThan(0))
    broken.output.destroy(new Error('transport failed'))
    await rejected
    expect(broken.terminate).toHaveBeenCalledOnce()
  })

  it('inspects foreground before signalling and refuses to kill the top-level shell', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    await expect(generation.signalForeground('SIGINT')).resolves.toBe(456)
    expect(handle.inspectForeground.mock.invocationCallOrder[0]).toBeLessThan(handle.signalForeground.mock.invocationCallOrder[0]!)
    handle.setForeground({ processGroupId: handle.pid, inputWaiting: true })
    await expect(generation.signalForeground('SIGKILL')).rejects.toThrow('top-level shell')
    expect(handle.signalForeground).toHaveBeenCalledTimes(1)
    handle.setForeground({ processGroupId: 456, inputWaiting: true })
    await expect(generation.signalForeground('SIGKILL')).resolves.toBe(456)
    expect(handle.deliverSignal).toHaveBeenCalledWith(456, 'SIGKILL')
    await generation.dispose()
  })

  it('refuses delivery when foreground switches from child to shell after consumer inspection', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    handle.inspectForeground.mockImplementationOnce(async () => {
      handle.setForeground({ processGroupId: handle.pid, inputWaiting: false })
      return { processGroupId: 456, inputWaiting: false }
    })
    try {
      await expect(generation.signalForeground('SIGKILL')).rejects.toThrow('terminal shell')
      expect(handle.inspectForeground).toHaveBeenCalledTimes(2)
      expect(handle.deliverSignal).not.toHaveBeenCalled()
    } finally { await generation.dispose() }
  })

  it('observes child stdin waits without treating shell input waits as completion', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), { ...DEFAULT_CONFIG, pollIntervalMs: 5 }, 1)
    handle.inspectForeground.mockResolvedValue({ processGroupId: handle.pid, inputWaiting: true })
    const active = generation.queue.enqueue({ id: 'a', kind: 'model-send' }, () => generation.write('read\r'))
    await active.lease
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(generation.queue.status()).toBe('busy')
    handle.inspectForeground.mockResolvedValue({ processGroupId: 456, inputWaiting: true })
    await expect(active.result).resolves.toEqual({ waitReason: 'stdin_read' })
    await generation.dispose()
  })

  it('closes subscribers and settles its queue before terminating exactly once', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const listener = vi.fn()
    generation.subscribe(listener)
    const active = generation.queue.enqueue({ id: 'a', kind: 'human' }, () => generation.write('input'))
    await active.lease
    expect(listener).toHaveBeenCalledWith({ type: 'state' })
    listener.mockClear()
    const original = handle.terminate.getMockImplementation()!
    handle.terminate.mockImplementation(async () => {
      expect(generation.queue.status()).toBe('disposed')
      handle.output.write('late output')
      await original()
    })
    await Promise.all([generation.dispose(), generation.dispose()])
    await expect(active.result).resolves.toEqual({ waitReason: 'cancelled' })
    expect(listener).not.toHaveBeenCalled()
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(handle.output.listenerCount('data')).toBe(0)
    expect(generation.snapshot().replay).not.toContain('late output')
  })

  it('keeps replaced generation output, prompt, and pending inspection isolated', async () => {
    const oldHandle = fakeTerminalHandle()
    const old = await TerminalGeneration.create(fakeOwner({ handle: oldHandle }), { ...DEFAULT_CONFIG, pollIntervalMs: 5 }, 1)
    const inspection = deferred<{ processGroupId: number; inputWaiting: boolean }>()
    oldHandle.inspectForeground.mockReturnValue(inspection.promise)
    old.queue.enqueue({ id: 'a', kind: 'model-send' }, () => old.write('old\r'))
    await vi.waitFor(() => expect(oldHandle.inspectForeground).toHaveBeenCalled())
    await old.dispose()
    const currentHandle = fakeTerminalHandle()
    const current = await TerminalGeneration.create(fakeOwner({ handle: currentHandle }), DEFAULT_CONFIG, 2)
    const active = current.queue.enqueue({ id: 'a', kind: 'human' }, () => current.write('new'))
    await active.lease
    inspection.resolve({ processGroupId: 456, inputWaiting: true })
    oldHandle.output.emit('data', Buffer.from('old output'))
    currentHandle.output.write(old.prompt.marker)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(current.queue.status()).toBe('busy')
    expect(current.snapshot().replay).not.toContain('old output')
    currentHandle.output.write(current.prompt.marker)
    await expect(active.result).resolves.toEqual({ waitReason: 'prompt' })
    await current.dispose()
  })

  it('uses the same nonce for OSC 133 emission and status parsing', () => {
    const prompt = new ControlledPrompt()
    expect(prompt.marker).toMatch(/^\x1b\]133;D;[a-zA-Z0-9_-]+;0\x07$/)
    const failed = prompt.marker.replace(';0\x07', ';127\x07')
    expect(prompt.consume(failed.slice(0, -2))).toBe(0)
    expect(prompt.consume(failed.slice(-2))).toBe(1)
    expect(prompt.lastExitStatus).toBe(127)
    expect(prompt.consume(prompt.marker.replace(';0\x07', ';999\x07'))).toBe(0)
    const emitted = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'false; eval "$PROMPT_COMMAND"'], { env: { ...process.env, ...prompt.env }, encoding: 'utf8' })
    expect(prompt.consume(emitted.stdout)).toBe(1)
    expect(prompt.lastExitStatus).toBe(1)
  })

  it('does not deliver a late input-wait inspection to a successor operation', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), { ...DEFAULT_CONFIG, pollIntervalMs: 5 }, 1)
    const inspected = deferred<{ processGroupId: number; inputWaiting: boolean }>()
    handle.inspectForeground.mockReturnValueOnce(inspected.promise)
    const first = generation.queue.enqueue({ id: 'first', kind: 'model-send' }, () => generation.write('first\r'))
    const next = generation.queue.enqueue({ id: 'next', kind: 'model-send' }, () => generation.write('next\r'))
    await first.lease
    await vi.waitFor(() => expect(handle.inspectForeground).toHaveBeenCalled())
    handle.output.write(generation.prompt.marker)
    await next.lease
    inspected.resolve({ processGroupId: 456, inputWaiting: true })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(generation.queue.status()).toBe('busy')
    await generation.dispose()
  })

  it('keeps listener exceptions from dropping output or later subscribers', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    generation.subscribe(() => { throw new Error('subscriber failed') })
    const listener = vi.fn()
    const unsubscribe = generation.subscribe(listener)
    handle.output.write('visible')
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    expect(warning).toHaveBeenCalledOnce()
    expect(generation.snapshot().replay).toContain('visible')
    unsubscribe()
    unsubscribe()
    await generation.dispose()
  })

  it('cleans up the process despite screen disposal failure', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const dispose = TerminalScreen.prototype.dispose
    vi.spyOn(TerminalScreen.prototype, 'dispose').mockImplementationOnce(function (this: TerminalScreen) { dispose.call(this); throw new Error('screen dispose failed') })
    await expect(generation.dispose()).rejects.toThrow('rollback failed')
    await expect(generation.dispose()).rejects.toThrow('rollback failed')
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(generation.snapshot().replay).toContain('dsh$')
  })

  it('rejects done and shuts down after a live output failure', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const done = expect(generation.done).rejects.toThrow('live transport failed')
    handle.output.destroy(new Error('live transport failed'))
    await done
    await generation.dispose()
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('binds a prompt to its operation before awaiting screen ingestion', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), { ...DEFAULT_CONFIG, pollIntervalMs: 5 }, 1)
    const release = deferred<void>()
    const original = TerminalScreen.prototype.write
    const write = vi.spyOn(TerminalScreen.prototype, 'write').mockImplementationOnce(async function (this: TerminalScreen, text) { await release.promise; return original.call(this, text) })
    const first = generation.queue.enqueue({ id: 'a', kind: 'model-send' }, () => generation.write('a\r'))
    const next = generation.queue.enqueue({ id: 'b', kind: 'model-send' }, () => generation.write('b\r'))
    await first.lease
    handle.output.write(generation.prompt.marker)
    await vi.waitFor(() => expect(write).toHaveBeenCalled())
    handle.inspectForeground.mockResolvedValueOnce({ processGroupId: 456, inputWaiting: true })
    await next.lease
    release.resolve()
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(generation.queue.status()).toBe('busy')
    await generation.dispose()
  })

  it.each(['screen-write', 'split-marker'] as const)('keeps an old human prompt from settling a later append across %s', async delay => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const release = deferred<void>()
    const started = deferred<void>()
    const original = TerminalScreen.prototype.write
    if (delay === 'screen-write') vi.spyOn(TerminalScreen.prototype, 'write').mockImplementationOnce(async function (this: TerminalScreen, text) {
      started.resolve()
      await release.promise
      return original.call(this, text)
    })
    async function output(text: string) {
      const written = deferred<void>()
      const unsubscribe = generation.subscribe(event => { if (event.type === 'output') written.resolve() })
      handle.output.write(text)
      await written.promise
      unsubscribe()
    }
    try {
      const human = generation.queue.enqueue({ id: 'human', kind: 'human' }, () => generation.write('echo old\r'))
      await human.lease
      const split = generation.prompt.marker.length - 2
      const old = output(delay === 'screen-write' ? generation.prompt.marker : generation.prompt.marker.slice(0, split))
      if (delay === 'screen-write') await started.promise
      else await old
      await human.append(() => generation.write('python\r'))
      release.resolve()
      await old
      if (delay === 'split-marker') await output(generation.prompt.marker.slice(split))
      expect(generation.queue.status()).toBe('busy')
      await output(generation.prompt.marker)
      await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    } finally { release.resolve(); await generation.dispose() }
  })

  it('publishes sequence without serializing a snapshot for each output chunk', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    const snapshot = vi.spyOn(TerminalScreen.prototype, 'snapshot')
    const events = vi.fn()
    generation.subscribe(events)
    handle.output.write('next output')
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'output', output: 'next output', sequence: 2 })))
    expect(snapshot).not.toHaveBeenCalled()
    await generation.dispose()
  })

  it('keeps a split prompt bound to the operation active when its marker began', async () => {
    const handle = fakeTerminalHandle()
    const generation = await TerminalGeneration.create(fakeOwner({ handle }), DEFAULT_CONFIG, 1)
    async function output(text: string) {
      const written = deferred<void>()
      const unsubscribe = generation.subscribe(event => { if (event.type === 'output') written.resolve() })
      handle.output.write(text)
      await written.promise
      unsubscribe()
    }
    try {
      const first = generation.queue.enqueue({ id: 'first', kind: 'model-send' }, () => generation.write('first\r'))
      const next = generation.queue.enqueue({ id: 'next', kind: 'model-send' }, () => generation.write('next\r'))
      await first.lease
      const split = generation.prompt.marker.length - 2
      await output(generation.prompt.marker.slice(0, split))
      generation.queue.observe('stdin_read')
      await next.lease
      await output(generation.prompt.marker.slice(split))
      expect(generation.queue.status()).toBe('busy')
      await output(generation.prompt.marker)
      await expect(next.result).resolves.toEqual({ waitReason: 'prompt' })
    } finally { await generation.dispose() }
  })
})
