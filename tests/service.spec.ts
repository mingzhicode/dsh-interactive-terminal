import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeService, fakeAgent, serviceContext } from './fixtures/fake-agent.ts'
import { deferred } from './fixtures/fake-clock.ts'
import { fakeOwner, fakeTerminalHandle } from './fixtures/fake-subprocess.ts'
import { TerminalScreen } from '../src/screen.ts'

describe('exact-Agent interactive terminal service', () => {
  it('preserves the current generation and FIFO after cancelling an unstarted reset', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('held')
    const abort = new AbortController()
    const resetting = service.reset(owner, abort.signal)
    const rejected = expect(resetting).rejects.toThrow('cancel')
    const follower = service.send(owner, { text: 'after', submit: false })
    void follower.catch(() => undefined)
    abort.abort(new Error('cancel queued reset'))
    await rejected
    await expect(service.ensure(owner)).resolves.toBe(record)
    expect(subprocess.handles).toHaveLength(1)
    expect(subprocess.handles[0]!.write).not.toHaveBeenCalledWith('after')
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await human.done
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('after'))
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await follower
  })

  it.each([false, true])('retains an earlier replacement outcome across follower reset cancellation (failure: %s)', async fail => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    await service.ensure(owner)
    const started = deferred<void>()
    const release = deferred<void>()
    const spawn = subprocess.spawnTerminal.getMockImplementation()!
    subprocess.spawnTerminal.mockImplementationOnce(async spec => {
      started.resolve()
      await release.promise
      if (fail) throw new Error('predecessor replacement failed')
      return spawn(spec)
    })
    const predecessor = service.reset(owner)
    void predecessor.catch(() => undefined)
    await started.promise
    const abort = new AbortController()
    const follower = service.reset(owner, abort.signal)
    const cancelled = expect(follower).rejects.toThrow('cancel follower')
    abort.abort(new Error('cancel follower'))
    await cancelled
    const resumed = service.ensure(owner)
    const settled = vi.fn()
    void resumed.then(settled, settled)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    release.resolve()
    if (fail) {
      await expect(predecessor).rejects.toThrow('predecessor replacement failed')
      await expect(resumed).rejects.toThrow('predecessor replacement failed')
    } else {
      await expect(predecessor).resolves.toMatchObject({ generation: 2 })
      await expect(resumed).resolves.toMatchObject({ generation: 2 })
    }
  })

  it.each(['main', 'capture'] as const)('drains received output after stdin readiness while the %s screen write is pending', async target => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ pollIntervalMs: 2 }, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('drain-owner', ctx)
    const record = await service.ensure(owner)
    const handle = subprocess.handles[0]!
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalWrite = TerminalScreen.prototype.write
    const write = vi.spyOn(TerminalScreen.prototype, 'write').mockImplementation(async function (this: TerminalScreen, output) {
      const selected = output === 'first-output' && (this.snapshot().rows === 1) === (target === 'capture')
      if (!selected) return originalWrite.call(this, output)
      if (target === 'capture') {
        const sequence = await originalWrite.call(this, output)
        entered.resolve()
        await release.promise
        return sequence
      }
      entered.resolve()
      await release.promise
      return originalWrite.call(this, output)
    })
    try {
      const first = service.send(owner, { text: 'first', submit: true })
      const firstSettled = vi.fn()
      void first.then(firstSettled, firstSettled)
      const next = service.send(owner, { text: 'next', submit: true })
      await vi.waitFor(() => expect(handle.write).toHaveBeenCalledWith('first\r'))
      handle.output.write('first-output')
      await entered.promise
      handle.inspectForeground.mockResolvedValueOnce({ processGroupId: 456, inputWaiting: true })
      await vi.waitFor(() => expect(handle.write).toHaveBeenCalledWith('next\r'))
      handle.output.write(`next-output${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
      expect(firstSettled).not.toHaveBeenCalled()
      release.resolve()
      const result = await first
      expect(result).toMatchObject({ waitReason: 'stdin_read', output: 'first-output', outputTruncated: false })
      expect(result.snapshot.sequence).toBeGreaterThanOrEqual(2)
      expect(result.snapshot.replay).toContain('first-output')
      expect(result.text.viewport).toContain('first-output')
      await expect(next).resolves.toMatchObject({ output: 'next-outputdsh$ ', waitReason: 'prompt' })
    } finally { release.resolve(); await service.dispose(); write.mockRestore() }
  })

  it('captures output only during its grant and excludes execution duration from queue time', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({}, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('output-owner', ctx)
    const record = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('human')
    const sending = service.send(owner, { text: 'model', submit: true })
    subprocess.handles[0]!.output.write(`before\r\n${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
    await human.done
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('model\r'))
    const grantedAt = performance.now()
    await new Promise(resolve => setTimeout(resolve, 40))
    subprocess.handles[0]!.output.write(`during\r\n${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
    const result = await sending
    expect(result.output).toBe('during\ndsh$ ')
    expect(result.queueTimeMs).toBeLessThan(performance.now() - grantedAt)
  })
  const disposers: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())) })
  function setup(maxSessions = 2) {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxSessions }, ctx)
    disposers.push(() => service.dispose())
    return { ctx, subprocess, service }
  }

  it('deduplicates lazy creation for the same exact Agent', async () => {
    const { ctx, service, subprocess } = setup()
    const agent = fakeAgent('owner', ctx)
    const [left, right] = await Promise.all([service.ensure(agent), service.ensure(agent)])
    expect(left).toBe(right)
    expect(service.size).toBe(1)
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
  })

  it('allocates only one generation for an initial reset', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    await expect(service.reset(owner)).resolves.toMatchObject({ generation: 1 })
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    expect(subprocess.handles[0]!.terminate).not.toHaveBeenCalled()
  })

  it.each(['send', 'reset', 'ensure'] as const)('cancels a %s waiting on shared creation without aborting its owner', async kind => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const allocation = deferred<void>()
    subprocess.spawnTerminal.mockImplementationOnce(async spec => {
      await allocation.promise
      const handle = fakeTerminalHandle()
      subprocess.handles.push(handle)
      return fakeOwner({ handle }).subprocess.spawnTerminal(spec)
    })
    const creating = service.ensure(owner)
    void creating.catch(() => undefined)
    const controller = new AbortController()
    const waiting = kind === 'send'
      ? service.send(owner, { text: 'cancelled', submit: true }, controller.signal)
      : kind === 'reset' ? service.reset(owner, controller.signal) : service.ensure(owner, controller.signal)
    const outcome = vi.fn()
    void waiting.then(outcome, outcome)
    controller.abort(new Error('cancel shared waiter'))
    try {
      await vi.waitFor(() => expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ message: 'cancel shared waiter' })), { timeout: 100 })
      expect(service.size).toBe(1)
    } finally { allocation.resolve() }
    const record = await creating
    expect(record.generation).toBe(1)
    expect(subprocess.spawnTerminal).toHaveBeenCalledOnce()
    expect(subprocess.handles[0]!.terminate).not.toHaveBeenCalled()
    expect(subprocess.handles[0]!.write).not.toHaveBeenCalled()
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])('preserves an immediately accepted send before reset (existing=%s, cancellable=%s)', async (existing, cancellable) => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    if (existing) await service.ensure(owner)
    const sending = service.send(owner, { text: 'first', submit: true }, cancellable ? new AbortController().signal : undefined)
    void sending.catch(() => undefined)
    const resetting = service.reset(owner)
    await vi.waitFor(() => expect(subprocess.handles[0]?.write).toHaveBeenCalledWith('first\r'))
    expect(subprocess.handles[0]!.terminate).not.toHaveBeenCalled()
    const spec = subprocess.spawnTerminal.mock.calls[0]![0]
    const nonce = spec.env!.PROMPT_COMMAND!.match(/133;D;([^;]+);/)![1]
    subprocess.handles[0]!.output.write(`\x1b]133;D;${nonce};0\x07`)
    await expect(sending).resolves.toMatchObject({ generation: 1, waitReason: 'prompt' })
    await expect(resetting).resolves.toMatchObject({ generation: 2 })
  })

  it.each(['send', 'reset'] as const)('cancels a %s waiting behind reset promptly and preserves the reset barrier', async kind => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxQueuedOperations: 3 }, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('held')
    const resetting = service.reset(owner)
    void resetting.catch(() => undefined)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const follower = kind === 'send'
      ? service.send(owner, { text: 'cancelled', submit: true }, controller.signal)
      : service.reset(owner, controller.signal)
    const outcome = vi.fn()
    void follower.then(outcome, outcome)
    controller.abort(new Error('cancel follower'))
    await vi.waitFor(() => expect(outcome).toHaveBeenCalledWith(expect.objectContaining({ message: 'cancel follower' })), { timeout: 100 })
    expect(remove).toHaveBeenCalled()
    const after = service.reset(owner)
    expect(subprocess.handles).toHaveLength(1)
    expect(subprocess.handles[0]!.terminate).not.toHaveBeenCalled()
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker + record.terminal.prompt.env.PS1)
    await human.done
    await expect(resetting).resolves.toMatchObject({ generation: 2 })
    await expect(after).resolves.toMatchObject({ generation: 3 })
    expect(subprocess.handles[0]!.write.mock.calls).toEqual([['held']])
  })

  it('never shares terminals between Agents in one session tree', async () => {
    const { ctx, service } = setup()
    const parent = fakeAgent('parent', ctx)
    const child = fakeAgent('child', ctx, parent)
    expect(await service.ensure(parent)).not.toBe(await service.ensure(child))
    expect(service.size).toBe(2)
  })

  it('counts pending creation toward capacity, rolls back failure, and permits retry', async () => {
    const { ctx, service, subprocess } = setup(1)
    const owner = fakeAgent('owner', ctx)
    const other = fakeAgent('other', ctx)
    const allocation = deferred<ReturnType<typeof fakeTerminalHandle>>()
    subprocess.spawnTerminal.mockImplementationOnce(() => allocation.promise)
    const creating = service.ensure(owner)
    expect(service.size).toBe(1)
    await expect(service.ensure(other)).rejects.toThrow('capacity')
    allocation.reject(new Error('allocation failed'))
    await expect(creating).rejects.toThrow('allocation failed')
    expect(service.size).toBe(0)
    await service.ensure(owner)
    expect(service.size).toBe(1)
  })

  it('binds operations to the exact registered Agent and rejects a same-id impostor', async () => {
    const { ctx, service } = setup()
    const owner = fakeAgent('owner', ctx)
    await expect(service.ensure({ ...owner })).rejects.toThrow('registered')
    expect(await service.forAgent(owner).ensure()).toBe(await service.ensure(owner))
    expect(service.size).toBe(1)
  })

  it('reads without waiting for the active human lease and queues model input behind it', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const attachment = await service.attach(owner)
    const human = await attachment.begin('human')
    const send = service.send(owner, { text: 'model', submit: true })
    const state = await service.read(owner, { offset: 0, count: 10 })
    expect(state.queueStatus).toBe('busy')
    expect(subprocess.handles[0]!.write.mock.calls).toEqual([['human']])
    await human.input('\r')
    expect(subprocess.handles[0]!.write.mock.calls).toEqual([['human'], ['\r']])
    const record = await service.ensure(owner)
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await human.done
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('model\r'))
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await expect(send).resolves.toMatchObject({ waitReason: 'prompt' })
  })

  it('hands a granted model send to the same generation and retains its reservation until human completion', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxInputBytes: 4, maxQueuedOperations: 2 }, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('handoff-owner', ctx)
    const attachment = await service.attach(owner)
    const abort = new AbortController()
    const model = service.send(owner, { text: 'ask', submit: true }, abort.signal)
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('ask\r'))
    subprocess.handles[0]!.output.write('Continue [Y/n]?')
    await vi.waitFor(() => expect(attachment.read().snapshot.replay).toContain('Continue'))
    const target = attachment.read().takeoverId
    expect(target).not.toBeNull()
    const follower = service.send(owner, { text: 'a', submit: true })

    const human = await attachment.takeover(target!)
    const handedOff = await model
    expect(handedOff).toMatchObject({ waitReason: 'human_handoff', holder: 'human', pendingCount: 1, output: 'Continue [Y/n]?' })
    expect(attachment.read()).toMatchObject({ holder: 'human', pendingCount: 1, takeoverId: null })
    abort.abort()
    await expect(service.send(owner, { text: 'x', submit: true })).rejects.toThrow('full')
    expect(subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()

    await human.input('Y\r')
    await expect(human.input('界')).rejects.toThrow('maxInputBytes')
    subprocess.handles[0]!.output.write('accepted')
    expect(handedOff.output).not.toContain('accepted')
    const record = await service.ensure(owner)
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker + record.terminal.prompt.env.PS1)
    await expect(human.done).resolves.toMatchObject({ waitReason: 'prompt' })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('a\r'))
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await expect(follower).resolves.toMatchObject({ waitReason: 'prompt' })
    await expect(human.input('')).rejects.toThrow('closed')

    await service.reset(owner)
    await expect(attachment.takeover(target!)).rejects.toThrow('stale')
  })

  it('rejects a takeover answer when the original prompt arrives before its write dispatch', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('handoff-prompt-owner', ctx)
    const attachment = await service.attach(owner)
    const model = service.send(owner, { text: 'ask', submit: true })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('ask\r'))
    const human = await attachment.takeover(attachment.read().takeoverId!)
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    const follower = service.send(owner, { text: 'follower', submit: true })
    const record = await service.ensure(owner)
    const answer = human.input('STALE_ANSWER\r')

    record.terminal.queue.observe('prompt')

    await expect(answer).rejects.toThrow('closed')
    await expect(human.done).resolves.toMatchObject({ waitReason: 'prompt' })
    expect(subprocess.handles[0]!.write).not.toHaveBeenCalledWith('STALE_ANSWER\r')
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('follower\r'))
    record.terminal.queue.observe('prompt')
    await expect(follower).resolves.toMatchObject({ waitReason: 'prompt' })
    expect(record.terminal.queue.status()).toBe('ready')
  })

  it('uses reset as a FIFO generation handoff for later accepted sends', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const old = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('old')
    const resetting = service.reset(owner)
    const after = service.send(owner, { text: 'new', submit: true })
    expect(subprocess.handles).toHaveLength(1)
    subprocess.handles[0]!.output.write(old.terminal.prompt.marker)
    await human.done
    const fresh = await resetting
    expect(fresh.generation).toBe(2)
    expect(subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(subprocess.handles[1]!.write).toHaveBeenCalledWith('new\r'))
    const current = await service.ensure(owner)
    old.terminal.queue.observe('prompt')
    expect(current.terminal.queue.status()).toBe('busy')
    subprocess.handles[1]!.output.write(current.terminal.prompt.marker)
    await expect(after).resolves.toMatchObject({ generation: 2, waitReason: 'prompt' })
  })

  it('retains natural-exit state without consuming live capacity until explicit reset', async () => {
    const { ctx, service, subprocess } = setup(1)
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    subprocess.handles[0]!.output.write('final')
    subprocess.handles[0]!.exit({ exitCode: 7, signal: null })
    await record.terminal.done
    await vi.waitFor(() => expect(service.size).toBe(0))
    expect(await service.ensure(owner)).toBe(record)
    expect(await service.read(owner, { offset: 0, count: 10 })).toMatchObject({ status: { kind: 'exited', exitCode: 7 } })
    expect(subprocess.handles).toHaveLength(1)
    await expect(service.reset(owner)).resolves.toMatchObject({ generation: 2 })
    expect(service.size).toBe(1)
  })

  it.each(['natural', 'cancelled', 'disposed', 'transport'] as const)('preserves a queued reset only after natural termination (%s)', async ending => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('held')
    const abort = new AbortController()
    const resetting = service.reset(owner, abort.signal)
    const resetOutcome = resetting.then(value => value, (error: unknown) => error)
    await vi.waitFor(() => expect(service.ownership()[0]?.queued).toBe(2))
    if (ending === 'cancelled') abort.abort(new Error('cancel queued reset'))
    if (ending === 'disposed') await service.disposeAgent(owner)
    else if (ending === 'transport') subprocess.handles[0]!.output.destroy(new Error('transport failed'))
    else subprocess.handles[0]!.exit({ exitCode: 7, signal: null })
    await Promise.allSettled([human.done, record.terminal.done])
    if (ending === 'natural') {
      expect(await resetOutcome).toMatchObject({ generation: 2, waitReason: 'prompt' })
      expect(subprocess.handles).toHaveLength(2)
    } else {
      expect(await resetOutcome).toBeInstanceOf(Error)
      expect(subprocess.handles).toHaveLength(1)
    }
  })

  it('recovers a blocked queue with reset and never reopens it after failed replacement', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    await service.ensure(owner)
    subprocess.handles[0]!.write.mockRejectedValueOnce(new Error('broken write'))
    await expect(service.send(owner, { text: 'fail', submit: true })).rejects.toThrow('broken write')
    subprocess.spawnTerminal.mockRejectedValueOnce(new Error('replacement failed'))
    const reset = service.reset(owner)
    const after = service.send(owner, { text: 'unsafe', submit: true })
    await expect(reset).rejects.toThrow('replacement failed')
    await expect(after).rejects.toThrow('replacement failed')
    expect(subprocess.handles[0]!.write).toHaveBeenCalledTimes(1)
    await expect(service.reset(owner)).resolves.toMatchObject({ generation: 2 })
  })

  it('cancels queued reset without writing and aborts active replacement without reopening old state', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    const human = await (await service.attach(owner)).begin('held')
    const cancelled = new AbortController()
    const reset = service.reset(owner, cancelled.signal)
    cancelled.abort(new Error('cancel reset'))
    await expect(reset).rejects.toThrow('cancel')
    expect(subprocess.handles[0]!.terminate).not.toHaveBeenCalled()
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await human.done
    const started = deferred<void>()
    subprocess.spawnTerminal.mockImplementationOnce(async spec => {
      const handle = fakeTerminalHandle()
      subprocess.handles.push(handle)
      started.resolve()
      return fakeOwner({ handle, prompt: false }).subprocess.spawnTerminal(spec)
    })
    const active = new AbortController()
    const replacing = service.reset(owner, active.signal)
    const rejected = expect(replacing).rejects.toThrow('cancel active reset')
    await started.promise
    active.abort(new Error('cancel active reset'))
    await rejected
    expect(subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
    expect(subprocess.handles[1]!.terminate).toHaveBeenCalledOnce()
  })

  it('signals within the queue and returns the actually signalled child group', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const record = await service.ensure(owner)
    const signalled = service.signal(owner, { signal: 'SIGINT' })
    await vi.waitFor(() => expect(subprocess.handles[0]!.signalForeground).toHaveBeenCalled())
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await expect(signalled).resolves.toMatchObject({ processGroupId: 456, waitReason: 'prompt' })
  })

  it('rejects an old attachment without blocking its replacement generation', async () => {
    const { ctx, service } = setup()
    const owner = fakeAgent('owner', ctx)
    const old = await service.attach(owner)
    await service.reset(owner)
    await expect(old.begin('stale')).rejects.toThrow('stale')
    expect((await service.ensure(owner)).terminal.queue.status()).toBe('ready')
  })

  it('fails an active operation on transport failure instead of reporting ordinary exit', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    await service.ensure(owner)
    const sending = service.send(owner, { text: 'run', submit: true })
    const rejected = expect(sending).rejects.toThrow('transport failed')
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalled())
    subprocess.handles[0]!.output.destroy(new Error('transport failed'))
    await rejected
  })

  it('keeps cancelled human input closed while accepted writes drain and recovery completes', async () => {
    const { ctx, service, subprocess } = setup()
    const owner = fakeAgent('owner', ctx)
    const human = await (await service.attach(owner)).begin('start')
    const record = await service.ensure(owner)
    const writing = deferred<void>()
    subprocess.handles[0]!.write.mockImplementationOnce(async () => { await writing.promise; return undefined })
    const input = human.input('pending')
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('pending'))
    const cancelled = human.cancel()
    await expect(human.input('late')).rejects.toThrow('closed')
    expect(subprocess.handles[0]!.signalForeground).not.toHaveBeenCalled()
    writing.resolve()
    await input
    await vi.waitFor(() => expect(subprocess.handles[0]!.signalForeground).toHaveBeenCalledOnce())
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    await expect(cancelled).resolves.toMatchObject({ waitReason: 'cancelled' })
  })

  it('enforces input and acceptance limits for operations waiting behind a reset barrier', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxInputBytes: 4, maxQueuedOperations: 2 }, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('owner', ctx)
    await expect(service.send(owner, { text: '界界', submit: false })).rejects.toThrow('maxInputBytes')
    await service.ensure(owner)
    const started = deferred<void>()
    const release = deferred<void>()
    subprocess.spawnTerminal.mockImplementationOnce(async spec => {
      started.resolve()
      await release.promise
      const handle = fakeTerminalHandle()
      subprocess.handles.push(handle)
      return fakeOwner({ handle }).subprocess.spawnTerminal(spec)
    })
    const resetting = service.reset(owner)
    await started.promise
    const after = service.send(owner, { text: 'ok', submit: false })
    await expect(service.send(owner, { text: 'no', submit: false })).rejects.toThrow('full')
    release.resolve()
    await resetting
    const current = await service.ensure(owner)
    await vi.waitFor(() => expect(subprocess.handles[1]!.write).toHaveBeenCalledWith('ok'))
    subprocess.handles[1]!.output.write(current.terminal.prompt.marker)
    await after
  })

  it('does not release capacity when failed startup cannot confirm rollback', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxSessions: 1, operationTimeoutMs: 10 }, ctx)
    const owner = fakeAgent('owner', ctx)
    const other = fakeAgent('other', ctx)
    const handle = fakeTerminalHandle()
    handle.terminate.mockRejectedValueOnce(new Error('rollback could not terminate'))
    subprocess.spawnTerminal.mockImplementationOnce(spec => fakeOwner({ handle, prompt: false }).subprocess.spawnTerminal(spec))
    await expect(service.ensure(owner)).rejects.toThrow('startup and rollback failed')
    expect(service.size).toBe(1)
    expect(() => service.assertSandboxChangeAllowed(owner)).toThrow('terminal is active')
    await expect(service.ensure(other)).rejects.toThrow('capacity')
    await expect(service.dispose()).rejects.toThrow('cleanup failed')
    expect(handle.terminate).toHaveBeenCalledOnce()
  })

  it('pages retained history independently of the viewport while a human owns the queue', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ rows: 1 }, ctx)
    disposers.push(() => service.dispose())
    const owner = fakeAgent('owner', ctx)
    const attachment = await service.attach(owner)
    const human = await attachment.begin('held')
    subprocess.handles[0]!.output.write('first\r\nsecond\r\nthird\r\nvisible')
    await vi.waitFor(() => expect(attachment.read().snapshot.replay).toContain('visible'))
    const page = await service.read(owner, { offset: 1, count: 1 })
    expect(page.page.text).toBe('second')
    expect(page.snapshot.replay).toContain('visible')
    await service.disposeAgent(owner)
    await human.done
  })
})
