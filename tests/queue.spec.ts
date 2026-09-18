import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationQueue } from '../src/queue.ts'
import { ControlledPrompt } from '../src/prompt.ts'
import { spawnSync } from 'node:child_process'
import { advanceClock, deferred } from './fixtures/fake-clock.ts'

afterEach(() => vi.useRealTimers())

describe('strict terminal queue', () => {
  it('grants accepted operations in exact order', async () => {
    const granted: string[] = []
    const queue = new OperationQueue({ maxQueuedOperations: 3, operationTimeoutMs: 30000, interruptTimeoutMs: 5000 }, async () => 1)
    const first = queue.enqueue({ id: 'a', kind: 'model-send' }, () => { granted.push('a') })
    const second = queue.enqueue({ id: 'b', kind: 'human' }, () => { granted.push('b') })
    await first.lease
    expect(granted).toEqual(['a'])
    first.complete({ waitReason: 'prompt' })
    await second.lease
    expect(granted).toEqual(['a', 'b'])
    queue.dispose()
  })

  it('holds the slot while SIGINT recovery runs and blocks on failed recovery', async () => {
    vi.useFakeTimers()
    const signals: string[] = []
    const queue = new OperationQueue({ maxQueuedOperations: 3, operationTimeoutMs: 30, interruptTimeoutMs: 5 }, async () => { signals.push('SIGINT'); return 1 })
    const active = queue.enqueue({ id: 'a', kind: 'model-send' }, () => undefined)
    await active.lease
    await vi.advanceTimersByTimeAsync(35)
    expect(signals).toEqual(['SIGINT'])
    expect(queue.status()).toBe('blocked')
    await expect(queue.enqueue({ id: 'b', kind: 'signal' }, () => undefined).lease).rejects.toThrow('blocked')
    queue.dispose()
  })
})

const limits = { maxQueuedOperations: 5, operationTimeoutMs: 30, interruptTimeoutMs: 5 }

describe('queue lifecycle matrix', () => {
  const queues: OperationQueue[] = []
  function make(interrupt: () => Promise<number> = async () => 1, maxQueuedOperations = 5) {
    vi.useFakeTimers()
    const queue = new OperationQueue({ ...limits, maxQueuedOperations }, interrupt)
    queues.push(queue)
    return queue
  }
  afterEach(() => { queues.splice(0).forEach(queue => queue.dispose()); vi.useRealTimers() })

  it('serializes human appends and retains ownership through a prompt while writes are pending', async () => {
    const queue = make()
    const writing = deferred<void>()
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const order: string[] = []
    const first = human.append(async () => { order.push('first'); await writing.promise })
    const second = human.append(() => { order.push('second') })
    const next = queue.enqueue({ id: 'next', kind: 'model-send' }, () => { order.push('next') })
    queue.observe('prompt')
    await advanceClock(0)
    expect(order).toEqual(['first'])
    writing.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
    queue.observe('prompt')
    await next.lease
    expect(order).toEqual(['first', 'second', 'next'])
  })

  it.each(['append', 'grant', 'interrupt'] as const)('retains ownership past recovery timeout during pending %s transport', async phase => {
    const transport = deferred<void>()
    const interrupt = vi.fn(async () => { if (phase === 'interrupt') await transport.promise; return 1 })
    const queue = make(interrupt)
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => phase === 'grant' ? transport.promise : undefined)
    if (phase !== 'grant') await human.lease
    const appended = phase === 'append' ? human.append(() => transport.promise) : undefined
    if (phase === 'append') await advanceClock(0)
    const resetGrant = vi.fn()
    const reset = queue.enqueue({ id: 'reset', kind: 'reset' }, resetGrant)
    human.cancel()
    await advanceClock(20)
    expect(resetGrant).not.toHaveBeenCalled()
    expect(queue.status()).toBe('busy')
    if (phase !== 'interrupt') expect(interrupt).not.toHaveBeenCalled()
    transport.resolve()
    await appended
    await advanceClock(0)
    expect(interrupt).toHaveBeenCalledOnce()
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'cancelled' })
    await reset.lease
  })

  it.each(['captured', 'split-marker'] as const)('ignores a stale %s observation after a later human dispatch', async source => {
    const queue = make()
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const stale = queue.captureObservation()
    const prompt = new ControlledPrompt()
    prompt.consume(prompt.marker.slice(0, 10), () => stale('prompt'))
    await human.append(() => undefined)
    if (source === 'captured') stale('prompt')
    else prompt.consume(prompt.marker.slice(10), () => queue.observe('prompt'))
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
  })

  it('accepts the final dispatch prompt before its transport promise resolves', async () => {
    const queue = make()
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const writing = deferred<void>()
    const appended = human.append(() => { queue.captureObservation()('prompt'); return writing.promise })
    await advanceClock(0)
    expect(queue.status()).toBe('busy')
    writing.resolve()
    await appended
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
  })

  it('closes a cancelled human lease and defers interrupt until its accepted appends finish', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const writing = deferred<void>()
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const appended = human.append(() => writing.promise)
    await advanceClock(0)
    human.cancel()
    await expect(human.append(() => undefined)).rejects.toThrow('closed')
    queue.observe('prompt')
    await advanceClock(0)
    expect(interrupt).not.toHaveBeenCalled()
    writing.resolve()
    await appended
    await advanceClock(0)
    expect(interrupt).toHaveBeenCalledOnce()
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'cancelled' })
  })

  it('blocks after append rejection and never executes later accepted appends', async () => {
    const queue = make()
    const writing = deferred<void>()
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const first = human.append(() => writing.promise)
    const skipped = vi.fn()
    const second = human.append(skipped)
    writing.reject(new Error('append failed'))
    await expect(first).rejects.toThrow('append failed')
    await expect(second).rejects.toThrow('append failed')
    await expect(human.result).rejects.toThrow('append failed')
    expect(skipped).not.toHaveBeenCalled()
    expect(queue.status()).toBe('blocked')
  })

  it('rejects append outside a granted human slot and settles disposal only once', async () => {
    const queue = make()
    const first = queue.enqueue({ id: 'first', kind: 'model-send' }, () => undefined)
    const pending = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await first.lease
    await expect(first.append(() => undefined)).rejects.toThrow('human')
    await expect(pending.append(() => undefined)).rejects.toThrow('granted')
    first.complete({ waitReason: 'prompt' })
    await pending.lease
    const writing = deferred<void>()
    const appended = pending.append(() => writing.promise)
    await advanceClock(0)
    const settled = vi.fn()
    void pending.result.then(settled)
    queue.dispose()
    queue.dispose()
    writing.resolve()
    await appended
    await advanceClock(0)
    expect(settled).toHaveBeenCalledOnce()
    await expect(pending.append(() => undefined)).rejects.toThrow('closed')
  })

  it('counts the active operation against capacity and rejects duplicate accepted ids', async () => {
    const queue = make(undefined, 2)
    const first = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    await expect(queue.enqueue({ id: 'a', kind: 'human' }, () => undefined).lease).rejects.toThrow('duplicate')
    queue.enqueue({ id: 'b', kind: 'human' }, () => undefined)
    await expect(queue.enqueue({ id: 'c', kind: 'human' }, () => undefined).lease).rejects.toThrow('full')
    first.complete({ waitReason: 'prompt' })
  })

  it('retains a human lease through Enter, stdin reads, and the ordinary model timeout', async () => {
    const queue = make()
    const granted: string[] = []
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => { granted.push('typed\r') })
    queue.enqueue({ id: 'model', kind: 'model-send' }, () => { granted.push('model') })
    await human.lease
    queue.observe('stdin_read')
    human.complete({ waitReason: 'stdin_read' })
    await advanceClock(1000)
    expect(granted).toEqual(['typed\r'])
    expect(queue.status()).toBe('busy')
    expect(vi.getTimerCount()).toBe(0)
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    expect(granted).toEqual(['typed\r', 'model'])
  })

  it('transfers a granted model operation to a human without releasing its slot', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt, 2)
    const abort = new AbortController()
    const writes: string[] = []
    const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => { writes.push('model') }, abort.signal)
    await model.lease
    const followerGrant = vi.fn()
    const follower = queue.enqueue({ id: 'next', kind: 'model-send' }, followerGrant)
    const target = queue.takeoverId()
    expect(target).toBe('model')

    const human = queue.takeover(target!)
    await expect(model.result).resolves.toEqual({ waitReason: 'human_handoff' })
    const completion = vi.fn()
    void model.completion.then(completion)
    abort.abort()
    model.cancel()
    model.complete({ waitReason: 'prompt' })
    await vi.advanceTimersByTimeAsync(100)

    expect(queue.holder()).toEqual({ id: 'model', kind: 'human' })
    expect(queue.takeoverId()).toBeNull()
    expect(interrupt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(followerGrant).not.toHaveBeenCalled()
    expect(completion).not.toHaveBeenCalled()
    await expect(model.append(() => undefined)).rejects.toThrow('closed')
    await human.append(() => { writes.push('Y\r') })
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    await expect(model.completion).resolves.toEqual({ waitReason: 'prompt' })
    await follower.lease
    expect(writes).toEqual(['model', 'Y\r'])
    expect(followerGrant).toHaveBeenCalledOnce()
  })

  it('drops takeover input when the original operation prompt wins before its first human dispatch', async () => {
    const queue = make()
    const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => undefined)
    await model.lease
    const human = queue.takeover(queue.takeoverId()!)
    const firstWrite = vi.fn()
    const secondWrite = vi.fn()
    const first = human.append(firstWrite)
    const second = human.append(secondWrite)
    const followerGrant = vi.fn()
    const follower = queue.enqueue({ id: 'follower', kind: 'model-send' }, followerGrant)

    queue.observe('prompt')

    await expect(first).rejects.toThrow('closed')
    await expect(second).rejects.toThrow('closed')
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    await follower.lease
    expect(firstWrite).not.toHaveBeenCalled()
    expect(secondWrite).not.toHaveBeenCalled()
    expect(followerGrant).toHaveBeenCalledOnce()
    expect(queue.status()).toBe('busy')
    follower.complete({ waitReason: 'prompt' })
    await expect(follower.result).resolves.toEqual({ waitReason: 'prompt' })
    expect(queue.status()).toBe('ready')
  })

  it('drops later takeover input when a prompt wins after an earlier human dispatch', async () => {
    const queue = make()
    const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => undefined)
    await model.lease
    const human = queue.takeover(queue.takeoverId()!)
    const writes: string[] = []
    await human.append(() => { writes.push('FIRST_ANSWER') })
    const second = human.append(() => { writes.push('STALE_SECOND_ANSWER') })
    const follower = queue.enqueue({ id: 'follower', kind: 'model-send' }, () => { writes.push('FOLLOWER') })

    queue.observe('prompt')

    await expect(second).rejects.toThrow('closed')
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    await follower.lease
    expect(writes).toEqual(['FIRST_ANSWER', 'FOLLOWER'])
  })

  it('drops an admitted append when cancellation starts before its dispatch', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const human = queue.enqueue({ id: 'human', kind: 'human' }, () => undefined)
    await human.lease
    const write = vi.fn()
    const appended = human.append(write)
    const follower = queue.enqueue({ id: 'follower', kind: 'model-send' }, () => undefined)

    human.cancel()

    await expect(appended).rejects.toThrow('closed')
    expect(write).not.toHaveBeenCalled()
    expect(interrupt).toHaveBeenCalledOnce()
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'cancelled' })
    await follower.lease
  })

  it('publishes takeover only after model delivery and rejects stale or recovering targets', async () => {
    const queue = make()
    const writing = deferred<void>()
    const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => writing.promise)
    expect(queue.takeoverId()).toBeNull()
    expect(() => queue.takeover('model' as NonNullable<ReturnType<OperationQueue['takeoverId']>>)).toThrow('not available')
    writing.resolve()
    await model.lease
    const target = queue.takeoverId()!
    expect(() => queue.takeover('stale' as typeof target)).toThrow('not available')
    model.cancel()
    expect(queue.takeoverId()).toBeNull()
    expect(() => queue.takeover(target)).toThrow('not available')

    const completedQueue = make()
    const completed = completedQueue.enqueue({ id: 'completed', kind: 'model-send' }, () => undefined)
    await completed.lease
    const completedTarget = completedQueue.takeoverId()!
    completedQueue.observe('prompt')
    await completed.result
    expect(() => completedQueue.takeover(completedTarget)).toThrow('not available')
  })

  it('lets a prompt captured by the same operation finish a racing takeover', async () => {
    const queue = make()
    const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => undefined)
    await model.lease
    const prompt = queue.captureObservation()
    const human = queue.takeover(queue.takeoverId()!)
    prompt('prompt')
    await expect(model.result).resolves.toEqual({ waitReason: 'human_handoff' })
    await expect(human.result).resolves.toEqual({ waitReason: 'prompt' })
    expect(queue.status()).toBe('ready')
  })

  it('completes a submitted model operation on verified stdin_read', async () => {
    const queue = make()
    const operation = queue.enqueue({ id: 'a', kind: 'model-send' }, () => undefined)
    await operation.lease
    queue.observe('stdin_read')
    await expect(operation.result).resolves.toEqual({ waitReason: 'stdin_read' })
    expect(queue.status()).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a signal operation when verified stdin_read establishes safe input', async () => {
    const queue = make()
    const signal = queue.enqueue({ id: 'a', kind: 'signal' }, () => undefined)
    await signal.lease
    queue.observe('stdin_read')
    expect(queue.status()).toBe('ready')
    await expect(signal.result).resolves.toEqual({ waitReason: 'stdin_read' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'cancelled'] as const)('rejects failed %s recovery with its diagnostic wait reason', async reason => {
    const queue = make()
    const operation = queue.enqueue({ id: 'a', kind: 'model-send' }, () => undefined)
    await operation.lease
    if (reason === 'cancelled') operation.cancel()
    await advanceClock(reason === 'timeout' ? 35 : 5)
    expect(queue.status()).toBe('blocked')
    await expect(operation.result).rejects.toMatchObject({ waitReason: reason, message: expect.stringContaining('recovery failed') })
  })

  it('removes a cancelled queued operation without disturbing FIFO or the active lease', async () => {
    const queue = make()
    const granted: string[] = []
    const first = queue.enqueue({ id: 'a', kind: 'human' }, () => { granted.push('a') })
    const cancelled = queue.enqueue({ id: 'b', kind: 'human' }, () => { granted.push('b') })
    const last = queue.enqueue({ id: 'c', kind: 'human' }, () => { granted.push('c') })
    cancelled.cancel()
    await expect(cancelled.lease).rejects.toThrow('cancelled')
    await expect(cancelled.result).resolves.toEqual({ waitReason: 'cancelled' })
    await first.lease
    first.complete({ waitReason: 'prompt' })
    await last.lease
    expect(granted).toEqual(['a', 'c'])
  })

  it.each(['model-send', 'human'] as const)('recovers active %s cancellation exactly once', async kind => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const first = queue.enqueue({ id: 'a', kind }, () => undefined)
    const granted = vi.fn()
    const next = queue.enqueue({ id: 'b', kind: 'human' }, granted)
    await first.lease
    first.cancel()
    first.cancel()
    first.complete({ waitReason: 'timeout' })
    queue.observe('stdin_read')
    await advanceClock(0)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(granted).not.toHaveBeenCalled()
    queue.observe('prompt')
    await expect(first.result).resolves.toEqual({ waitReason: 'cancelled' })
    await next.lease
    expect(granted).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers a disconnected human when the session layer expires its grace period', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const human = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    await human.lease
    await advanceClock(100)
    expect(interrupt).not.toHaveBeenCalled()
    queue.cancel('a')
    await advanceClock(0)
    queue.observe('prompt')
    await expect(human.result).resolves.toEqual({ waitReason: 'cancelled' })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('honors AbortSignal before admission, while queued, and while active', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const already = new AbortController()
    already.abort()
    const grant = vi.fn()
    await expect(queue.enqueue({ id: 'old', kind: 'human' }, grant, already.signal).lease).rejects.toThrow('cancelled')
    const activeController = new AbortController()
    const active = queue.enqueue({ id: 'a', kind: 'human' }, grant, activeController.signal)
    const pendingController = new AbortController()
    const pending = queue.enqueue({ id: 'b', kind: 'human' }, grant, pendingController.signal)
    pendingController.abort()
    await expect(pending.lease).rejects.toThrow('cancelled')
    await active.lease
    activeController.abort()
    await advanceClock(0)
    queue.observe('prompt')
    await expect(active.result).resolves.toEqual({ waitReason: 'cancelled' })
    expect(grant).toHaveBeenCalledTimes(1)
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('holds the slot until both asynchronous write and prompt observation complete', async () => {
    const queue = make()
    const write = deferred<void>()
    const first = queue.enqueue({ id: 'a', kind: 'model-send' }, () => write.promise)
    const grant = vi.fn()
    const next = queue.enqueue({ id: 'b', kind: 'human' }, grant)
    queue.observe('prompt')
    await advanceClock(0)
    expect(grant).not.toHaveBeenCalled()
    write.resolve()
    await first.lease
    await next.lease
    expect(grant).toHaveBeenCalledTimes(1)
  })

  it('does not release the active slot merely because its write completed', async () => {
    const queue = make()
    const first = queue.enqueue({ id: 'a', kind: 'model-send' }, async () => undefined)
    const grant = vi.fn()
    queue.enqueue({ id: 'b', kind: 'human' }, grant)
    await first.lease
    await advanceClock(1)
    expect(grant).not.toHaveBeenCalled()
    expect(queue.status()).toBe('busy')
  })

  it('awaits SIGINT completion even when its recovery prompt arrives first', async () => {
    const signal = deferred<number>()
    const queue = make(() => signal.promise)
    const first = queue.enqueue({ id: 'a', kind: 'model-send' }, () => undefined)
    const grant = vi.fn()
    const next = queue.enqueue({ id: 'b', kind: 'human' }, grant)
    await first.lease
    await advanceClock(30)
    queue.observe('prompt')
    expect(grant).not.toHaveBeenCalled()
    signal.resolve(1)
    await expect(first.result).resolves.toEqual({ waitReason: 'timeout' })
    await next.lease
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes cancellation recovery after an outstanding mutation callback', async () => {
    const write = deferred<void>()
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const active = queue.enqueue({ id: 'a', kind: 'model-send' }, () => write.promise)
    active.cancel()
    queue.observe('prompt')
    await advanceClock(0)
    expect(interrupt).not.toHaveBeenCalled()
    write.resolve()
    await active.lease
    await advanceClock(0)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(active.result).resolves.toEqual({ waitReason: 'cancelled' })
    expect(queue.status()).toBe('ready')
  })

  it('serializes signal and reset callbacks behind an active human', async () => {
    const queue = make()
    const order: string[] = []
    const human = queue.enqueue({ id: 'a', kind: 'human' }, () => { order.push('human') })
    const signal = queue.enqueue({ id: 'b', kind: 'signal' }, () => { order.push('signal') })
    const reset = queue.enqueue({ id: 'c', kind: 'reset' }, () => { order.push('reset') })
    await human.lease
    expect(order).toEqual(['human'])
    queue.observe('prompt')
    await signal.lease
    signal.complete({ waitReason: 'prompt' })
    await reset.lease
    await reset.result
    expect(order).toEqual(['human', 'signal', 'reset'])
    expect(queue.status()).toBe('ready')
  })

  it('rejects blocked pending entries in FIFO order until the earliest accepted reset replaces the generation', async () => {
    const queue = make(undefined, 8)
    const order: string[] = []
    const active = queue.enqueue({ id: 'a', kind: 'model-send' }, () => undefined)
    for (const id of ['b', 'c']) {
      const entry = queue.enqueue({ id, kind: 'signal' }, () => { order.push(`grant ${id}`) })
      void entry.lease.catch(() => { order.push(`reject ${id}`) })
    }
    const replace = deferred<void>()
    const reset = queue.enqueue({ id: 'reset', kind: 'reset' }, () => { order.push('replace'); return replace.promise })
    const last = queue.enqueue({ id: 'last', kind: 'human' }, () => { order.push('last') })
    await active.lease
    await advanceClock(35)
    expect(order.filter(value => value.startsWith('reject'))).toEqual(['reject b', 'reject c'])
    expect(order).toContain('replace')
    expect(order).not.toContain('last')
    replace.resolve()
    await reset.result
    await last.lease
    expect(order.at(-1)).toBe('last')
  })

  it.each(['throw', 'reject'] as const)('blocks when recovery interrupt fails: %s', async failure => {
    const queue = make(() => {
      if (failure === 'throw') throw new Error('interrupt failed')
      return Promise.reject(new Error('interrupt failed'))
    })
    const operation = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    await operation.lease
    operation.cancel()
    await advanceClock(5)
    expect(queue.status()).toBe('blocked')
    await expect(operation.result).rejects.toMatchObject({ waitReason: 'cancelled' })
    queue.observe('prompt')
    expect(queue.status()).toBe('blocked')
    await advanceClock(0)
    expect(queue.status()).toBe('blocked')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps failed asynchronous grants blocked until a successful reset', async () => {
    const queue = make()
    const failed = queue.enqueue({ id: 'a', kind: 'model-send' }, async () => { throw new Error('write failed') })
    await expect(failed.lease).rejects.toThrow('write failed')
    await expect(failed.result).rejects.toThrow('write failed')
    expect(queue.status()).toBe('blocked')
    const brokenReset = queue.enqueue({ id: 'b', kind: 'reset' }, () => { throw new Error('replace failed') })
    await expect(brokenReset.result).rejects.toThrow('replace failed')
    expect(queue.status()).toBe('blocked')
    const reset = queue.enqueue({ id: 'c', kind: 'reset' }, async () => undefined)
    await reset.result
    expect(queue.status()).toBe('ready')
  })

  it('settles active and pending operations on session exit and never grants queued mutations', async () => {
    const queue = make()
    const active = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    const grant = vi.fn()
    const pending = queue.enqueue({ id: 'b', kind: 'reset' }, grant)
    await active.lease
    queue.observe('session_exit')
    await expect(active.result).resolves.toEqual({ waitReason: 'session_exit' })
    await expect(pending.result).resolves.toEqual({ waitReason: 'session_exit' })
    await expect(pending.lease).rejects.toThrow('exited')
    await expect(queue.enqueue({ id: 'c', kind: 'reset' }, grant).lease).rejects.toThrow('exited')
    expect(queue.status()).toBe('exited')
    expect(grant).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles session exit during recovery once and ignores a late interrupt rejection', async () => {
    const interrupt = deferred<number>()
    const queue = make(() => interrupt.promise)
    const active = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    const results: unknown[] = []
    void active.result.then(value => { results.push(value) })
    await active.lease
    active.cancel()
    queue.observe('session_exit')
    interrupt.reject(new Error('transport closed'))
    active.complete({ waitReason: 'prompt' })
    queue.dispose()
    await advanceClock(100)
    expect(results).toEqual([{ waitReason: 'session_exit' }])
    expect(queue.status()).toBe('disposed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes abort listeners after normal completion and disposal', async () => {
    const queue = make()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstRemove = vi.spyOn(firstController.signal, 'removeEventListener')
    const secondRemove = vi.spyOn(secondController.signal, 'removeEventListener')
    const active = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined, firstController.signal)
    queue.enqueue({ id: 'b', kind: 'human' }, () => undefined, secondController.signal)
    await active.lease
    queue.observe('prompt')
    queue.dispose()
    expect(firstRemove).toHaveBeenCalledTimes(1)
    expect(secondRemove).toHaveBeenCalledTimes(1)
  })

  it('settles and cleans up disposal during unresolved grant and recovery', async () => {
    const write = deferred<void>()
    const interrupt = deferred<number>()
    const queue = make(() => interrupt.promise)
    const controller = new AbortController()
    const active = queue.enqueue({ id: 'a', kind: 'model-send' }, () => write.promise, controller.signal)
    const pending = queue.enqueue({ id: 'b', kind: 'human' }, () => undefined)
    active.cancel()
    queue.dispose()
    queue.dispose()
    await expect(active.lease).rejects.toThrow('disposed')
    await expect(active.result).resolves.toEqual({ waitReason: 'cancelled' })
    await expect(pending.lease).rejects.toThrow('disposed')
    await expect(pending.result).resolves.toEqual({ waitReason: 'cancelled' })
    write.resolve()
    interrupt.resolve(1)
    controller.abort()
    queue.observe('prompt')
    queue.observe('session_exit')
    active.complete({ waitReason: 'prompt' })
    await advanceClock(100)
    expect(queue.status()).toBe('disposed')
    expect(vi.getTimerCount()).toBe(0)
    await expect(queue.enqueue({ id: 'new', kind: 'reset' }, () => undefined).lease).rejects.toThrow('disposed')
  })

  it('ignores stale handles even after a completed operation id is reused', async () => {
    const queue = make()
    const stale = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    await stale.lease
    stale.complete({ waitReason: 'prompt' })
    const current = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    await current.lease
    stale.complete({ waitReason: 'prompt' })
    stale.cancel()
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(current.result).resolves.toEqual({ waitReason: 'prompt' })
  })

  it('keeps a recovery queue entry FIFO and waits for its interrupt and prompt', async () => {
    const interrupt = vi.fn(async () => 1)
    const queue = make(interrupt)
    const human = queue.enqueue({ id: 'a', kind: 'human' }, () => undefined)
    const recovery = queue.enqueue({ id: 'b', kind: 'disconnect-recovery' }, () => undefined)
    await human.lease
    expect(interrupt).not.toHaveBeenCalled()
    queue.observe('prompt')
    await recovery.lease
    await advanceClock(0)
    expect(interrupt).toHaveBeenCalledTimes(1)
    expect(queue.status()).toBe('busy')
    queue.observe('prompt')
    await expect(recovery.result).resolves.toEqual({ waitReason: 'cancelled' })
  })
})

describe('controlled Bash prompt', () => {
  it('retains the starting observer across every split and assigns new markers to the new observer', () => {
    const sample = new ControlledPrompt()
    for (let split = 1; split < sample.marker.length; split += 1) {
      const prompt = new ControlledPrompt()
      const earlier = vi.fn()
      const current = vi.fn()
      expect(prompt.consume(prompt.marker.slice(0, split), earlier)).toBe(0)
      expect(prompt.consume(prompt.marker.slice(split) + prompt.marker, current)).toBe(2)
      expect(earlier).toHaveBeenCalledOnce()
      expect(current).toHaveBeenCalledOnce()
    }
  })

  it('recognizes only the per-session nonce-bearing marker, including split chunks', () => {
    const prompt = new ControlledPrompt()
    const other = new ControlledPrompt()
    expect(prompt.marker).not.toBe(other.marker)
    expect(prompt.consume('$ ready\n> prompt\n')).toBe(0)
    expect(prompt.consume(other.marker)).toBe(0)
    expect(prompt.consume(prompt.marker.slice(0, 8))).toBe(0)
    expect(prompt.consume(prompt.marker.slice(8))).toBe(1)
    expect(prompt.consume(prompt.marker + 'ordinary output' + prompt.marker)).toBe(2)
    expect(prompt.consume('ordinary output')).toBe(0)
  })

  it('emits the exact controlled marker from Bash PROMPT_COMMAND', () => {
    const prompt = new ControlledPrompt()
    const output = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'eval "$PROMPT_COMMAND"'], {
      env: { ...process.env, ...prompt.env }, encoding: 'utf8',
    })
    expect(output.status).toBe(0)
    expect(output.stdout).toBe(prompt.marker)
    expect(prompt.consume(output.stdout)).toBe(1)
  })
})
