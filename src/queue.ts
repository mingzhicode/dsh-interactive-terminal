/** Strict FIFO ownership of terminal mutations and foreground recovery. */
import type { Config } from './config.ts'
import { assertNever } from './protocol.ts'
import type { OperationKind, QueueStatus, TakeoverId } from './protocol.ts'

/** Mutations sharing one terminal's exclusive input slot. */
export type { OperationKind } from './protocol.ts'
/** Availability of a terminal mutation queue. */
export type { QueueStatus } from './protocol.ts'
/** Internal completion reasons, including cancellation before or after admission. */
export type WaitReason = 'prompt' | 'stdin_read' | 'session_exit' | 'timeout' | 'cancelled' | 'human_handoff'
/** Exact granted model operation eligible for an in-place human handoff. */
export type { TakeoverId } from './protocol.ts'
/** Authoritative shell observations; arbitrary output is not an observation. */
export type TerminalObservation = 'prompt' | 'stdin_read' | 'session_exit'
/** A caller identifier, unique among accepted operations, and its mutation kind. */
export interface OperationRequest { id: string; kind: OperationKind }
/** The observation or recovery trigger that ended an accepted operation. */
export interface OperationResult { waitReason: WaitReason }
/** Capacity and deadlines owned by the input queue. */
export type QueueLimits = Pick<Config, 'maxQueuedOperations' | 'operationTimeoutMs' | 'interruptTimeoutMs'>

/** Failed foreground recovery, retaining the cancellation or deadline that triggered it. */
export class RecoveryError extends Error {
  /**
   * @param waitReason - reason the active operation entered recovery.
   * @param cause - transport failure, when SIGINT delivery itself failed.
   */
  constructor(readonly waitReason: 'cancelled' | 'timeout', cause?: unknown) {
    super(`terminal recovery failed after ${waitReason}; queue is blocked until reset`, { cause })
    this.name = 'RecoveryError'
  }
}

class ClosedAppendError extends Error {
  constructor() { super('human lease is closed') }
}

/** A grant acknowledgment and the independent final outcome of one operation. */
export interface EnqueuedOperation {
  /** Resolves after the granted callback finishes; rejects if it cannot run or fails. */
  readonly lease: Promise<void>
  /** Settles after completion, cancellation, recovery, exit, or disposal. */
  readonly result: Promise<OperationResult>
  /** Settles only when the queue slot is released, including after handoff. */
  readonly completion: Promise<OperationResult>
  /**
   * Serialize another write within this granted human slot.
   * @param mutation - input delivery owned by the current human lease.
   * @returns Completion of that delivery; rejects if completion or recovery wins before dispatch.
   */
  append(mutation: () => void | Promise<void>): Promise<void>
  /**
   * Submit an authoritative completion observation for this operation alone.
   * @param result - observed completion or requested recovery reason.
   */
  complete(result: OperationResult): void
  /** Cancel this operation; active ownership lasts through SIGINT recovery. */
  cancel(): void
}

interface Entry {
  request: OperationRequest
  grant: () => void | Promise<void>
  lease: Promise<void>
  completionPromise: Promise<OperationResult>
  resolveLease: () => void
  rejectLease: (error: Error) => void
  resolveResult: (result: OperationResult) => void
  rejectResult: (error: Error) => void
  resolveCompletion: (result: OperationResult) => void
  rejectCompletion: (error: Error) => void
  settled: boolean
  resultSettled: boolean
  leaseSettled: boolean
  granted: boolean
  writes: number
  writeTail: Promise<void>
  dispatch: number
  completion?: OperationResult
  recovery?: { reason: 'timeout' | 'cancelled'; started: boolean; interrupted: boolean; prompt: boolean }
  removeAbort?: () => void
  authority: object
  handedOff: boolean
}

/**
 * Owns a terminal's mutation slot until an authoritative observation or recovery.
 * Reads bypass this queue. Human input has no ordinary deadline; disconnect grace
 * belongs to the session layer, which cancels the active human after expiry.
 */
export class OperationQueue {
  private readonly pending: Entry[] = []
  private active: Entry | undefined
  private state: QueueStatus = 'ready'
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param limits - validated capacity and timeout settings.
   * @param interrupt - send SIGINT to the active foreground process group.
   * @param changed - synchronous state notification; the owning dispatcher contains listener errors.
   */
  constructor(private readonly limits: QueueLimits, private readonly interrupt: () => Promise<number>, private readonly changed: () => void = () => undefined) {}

  /** @returns Current queue availability, including failed-recovery blocking. */
  status(): QueueStatus { return this.state }

  /** @returns The current granted mutation identity, or null when no slot is owned. */
  holder(): OperationRequest | null { return this.active ? { ...this.active.request } : null }

  /** @returns The exact granted model send that may still transfer ownership. */
  takeoverId(): TakeoverId | null {
    const entry = this.active
    return entry?.request.kind === 'model-send' && entry.granted && !entry.recovery && !entry.completion && !entry.resultSettled
      ? entry.request.id as TakeoverId
      : null
  }

  /**
   * Transfer a granted model send to human ownership without releasing its FIFO slot.
   * @param target - exact currently published model operation.
   * @param signal - cancellation owned by the new human lease.
   * @returns A granted human-compatible handle whose result is the slot completion.
   */
  takeover(target: TakeoverId, signal?: AbortSignal): EnqueuedOperation {
    if (signal?.aborted) throw new Error('terminal takeover is not available')
    const entry = this.active
    if (!entry || this.takeoverId() !== target) throw new Error('terminal takeover is not available')
    this.clearTimer()
    entry.removeAbort?.()
    delete entry.removeAbort
    entry.request = { ...entry.request, kind: 'human' }
    entry.authority = {}
    entry.handedOff = true
    this.settleResult(entry, { waitReason: 'human_handoff' })
    if (signal) {
      const authority = entry.authority
      const abort = () => this.cancelEntry(entry, authority)
      signal.addEventListener('abort', abort, { once: true })
      entry.removeAbort = () => signal.removeEventListener('abort', abort)
    }
    this.changed()
    return this.handle(entry, entry.authority, entry.completionPromise)
  }

  /**
   * Bind an asynchronous foreground observation to the current input dispatch.
   * @returns Observer that ignores completion after another dispatch or slot begins.
   */
  captureObservation(): (observation: Exclude<TerminalObservation, 'session_exit'>) => void {
    const entry = this.active
    const dispatch = entry?.dispatch
    return observation => { if (entry && entry.dispatch === dispatch) this.complete(entry, { waitReason: observation }) }
  }

  /**
   * Append a mutation in acceptance order, counting the active slot toward capacity.
   * @param request - unique accepted identifier and mutation kind.
   * @param grant - perform the mutation; reset replaces the shell generation here.
   * @param signal - optional caller cancellation; active cancellation requires recovery.
   * @returns Grant acknowledgment and final outcome, including admission failures.
   */
  enqueue(request: OperationRequest, grant: () => void | Promise<void>, signal?: AbortSignal): EnqueuedOperation {
    let resolveLease!: () => void
    let rejectLease!: (error: Error) => void
    let resolveResult!: (result: OperationResult) => void
    let rejectResult!: (error: Error) => void
    let resolveCompletion!: (result: OperationResult) => void
    let rejectCompletion!: (error: Error) => void
    const lease = new Promise<void>((resolve, reject) => { resolveLease = resolve; rejectLease = reject })
    const result = new Promise<OperationResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const completion = new Promise<OperationResult>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
    // Callers may await either promise first; both retain their rejection for callers.
    void lease.catch(() => undefined)
    void result.catch(() => undefined)
    void completion.catch(() => undefined)
    const authority = {}
    const entry: Entry = {
      request: { ...request }, grant, lease, completionPromise: completion, resolveLease, rejectLease, resolveResult, rejectResult, resolveCompletion, rejectCompletion,
      settled: false, resultSettled: false, leaseSettled: false, granted: false, writes: 0, writeTail: Promise.resolve(), dispatch: 0, authority, handedOff: false,
    }
    const handle = this.handle(entry, authority, result)
    let error: Error | undefined
    if (this.state === 'disposed' || this.state === 'exited') error = new Error(`terminal queue is ${this.state}`)
    else if (signal?.aborted) error = new Error('terminal operation cancelled')
    else if (this.active?.request.id === request.id || this.pending.some(item => item.request.id === request.id)) {
      error = new Error('duplicate terminal operation id')
    } else if (this.pending.length + Number(this.active !== undefined) >= this.limits.maxQueuedOperations) {
      error = new Error('terminal queue is full')
    }
    if (error) {
      this.settle(entry, { waitReason: 'cancelled' }, error)
      return handle
    }
    if (signal) {
      const abort = () => this.cancelEntry(entry, authority)
      signal.addEventListener('abort', abort, { once: true })
      entry.removeAbort = () => signal.removeEventListener('abort', abort)
    }
    this.pending.push(entry)
    this.pump()
    this.changed()
    return handle
  }

  /**
   * Deliver an ordered observation from the current shell generation.
   * @param observation - verified primary prompt, foreground stdin wait, or exit.
   */
  observe(observation: TerminalObservation): void {
    if (this.state === 'disposed' || this.state === 'exited') return
    switch (observation) {
      case 'session_exit':
        this.terminate('exited', { waitReason: 'session_exit' })
        return
      case 'prompt':
      case 'stdin_read':
        if (this.active) this.complete(this.active, { waitReason: observation })
        return
      default: assertNever(observation)
    }
  }

  /**
   * Cancel a currently accepted identifier, preserving all other FIFO positions.
   * @param id - identifier of the active or queued operation.
   */
  cancel(id: string): void {
    const entry = this.active?.request.id === id ? this.active : this.pending.find(item => item.request.id === id)
    if (entry) this.cancelEntry(entry)
  }

  /** Settle every operation and remove deadlines and cancellation listeners. */
  dispose(): void {
    if (this.state !== 'disposed') this.terminate('disposed', { waitReason: 'cancelled' })
  }

  private pump(): void {
    if (this.active || this.state === 'disposed' || this.state === 'exited') return
    let next: Entry | undefined
    while ((next = this.pending.shift())) {
      if (this.state === 'blocked' && next.request.kind !== 'reset') {
        this.settle(next, { waitReason: 'cancelled' }, new Error('terminal queue is blocked until reset'))
        continue
      }
      this.active = next
      this.state = 'busy'
      this.changed()
      const entry = next
      switch (entry.request.kind) {
        case 'model-send':
        case 'signal':
        case 'reset':
          this.timer = setTimeout(() => this.recover(entry, 'timeout'), this.limits.operationTimeoutMs)
          break
        case 'human':
        case 'disconnect-recovery': break
        default: assertNever(entry.request.kind)
      }
      try {
        const granted = entry.grant()
        void Promise.resolve(granted).then(() => this.granted(entry), error => this.failed(entry, error))
      } catch (error) {
        this.failed(entry, error)
      }
      return
    }
  }

  private granted(entry: Entry): void {
    if (entry.settled) return
    entry.granted = true
    this.settleLease(entry)
    if (entry.recovery) this.sendInterrupt(entry)
    else if (entry.request.kind === 'disconnect-recovery') this.recover(entry, 'cancelled')
    else if (entry.request.kind === 'reset') entry.completion = { waitReason: 'prompt' }
    this.progress(entry)
    this.changed()
  }

  private complete(entry: Entry, result: OperationResult, authority?: object): void {
    if (authority && entry.authority !== authority) return
    if (entry !== this.active || entry.settled) return
    switch (result.waitReason) {
      case 'session_exit': this.observe('session_exit'); return
      case 'cancelled':
      case 'timeout': this.recover(entry, result.waitReason); return
      case 'prompt':
        if (entry.recovery) { if (entry.recovery.started && entry.writes === 0) entry.recovery.prompt = true }
        else if (entry.request.kind !== 'reset') entry.completion ??= result
        break
      case 'stdin_read':
        if (!entry.recovery && (entry.request.kind === 'model-send' || entry.request.kind === 'signal')) entry.completion ??= result
        break
      case 'human_handoff': return
      default: assertNever(result.waitReason)
    }
    this.progress(entry)
  }

  private progress(entry: Entry): void {
    if (entry !== this.active || !entry.granted || entry.writes > 0) return
    const recovery = entry.recovery
    if (recovery) {
      if (!recovery.interrupted || !recovery.prompt) return
      this.settle(entry, { waitReason: recovery.reason })
    } else {
      if (!entry.completion) return
      this.settle(entry, entry.completion)
    }
    this.state = 'ready'
    this.pump()
    this.changed()
  }

  private cancelEntry(entry: Entry, authority?: object): void {
    if (authority && entry.authority !== authority) return
    if (entry.settled) return
    if (entry === this.active) this.recover(entry, 'cancelled')
    else {
      const index = this.pending.indexOf(entry)
      if (index < 0) return
      this.pending.splice(index, 1)
      this.settle(entry, { waitReason: 'cancelled' })
    }
  }

  private recover(entry: Entry, reason: 'cancelled' | 'timeout'): void {
    if (entry !== this.active || entry.recovery || entry.settled) return
    this.clearTimer()
    const recovery = { reason, started: false, interrupted: false, prompt: false }
    entry.recovery = recovery
    if (entry.granted && entry.writes === 0) this.sendInterrupt(entry)
  }

  private sendInterrupt(entry: Entry): void {
    const recovery = entry.recovery
    if (!recovery || recovery.started) return
    recovery.started = true
    entry.dispatch += 1
    try {
      void this.interrupt().then(() => {
        if (entry.settled) return
        recovery.interrupted = true
        // Readiness can time out only after delivery can no longer affect a successor.
        this.timer = setTimeout(() => this.block(entry), this.limits.interruptTimeoutMs)
        this.progress(entry)
      }, error => this.block(entry, error))
    } catch (error) {
      // The injected SIGINT transport may fail synchronously before returning its promise.
      this.block(entry, error)
    }
  }

  private block(entry: Entry, cause?: unknown): void {
    if (entry !== this.active || !entry.recovery) return
    this.state = 'blocked'
    this.settle(entry, { waitReason: entry.recovery.reason }, new RecoveryError(entry.recovery.reason, cause))
    this.pump()
  }

  private async append(entry: Entry, authority: object, mutation: () => void | Promise<void>): Promise<void> {
    if (entry.authority !== authority) throw new Error('human lease is closed')
    if (entry.settled || entry.recovery || entry.completion) throw new Error('human lease is closed')
    if (entry.request.kind !== 'human') throw new Error('append requires a human lease')
    if (entry !== this.active || !entry.granted) throw new Error('human lease is not granted')
    entry.writes += 1
    const write = entry.writeTail.then(() => {
      if (entry.settled || entry.recovery || (entry.handedOff && entry.completion)) throw new ClosedAppendError()
      entry.dispatch += 1
      delete entry.completion
      return mutation()
    }).then(() => {
      entry.writes -= 1
      if (entry.settled) return
      if (entry.recovery && entry.writes === 0) this.sendInterrupt(entry)
      this.progress(entry)
    }, error => {
      entry.writes -= 1
      if (error instanceof ClosedAppendError) {
        if (!entry.settled) {
          if (entry.recovery && entry.writes === 0) this.sendInterrupt(entry)
          this.progress(entry)
        }
        throw error
      }
      this.failed(entry, error)
      throw error
    })
    entry.writeTail = write
    return write
  }

  private failed(entry: Entry, error: unknown): void {
    if (entry.settled) return
    this.state = 'blocked'
    this.settle(entry, { waitReason: 'cancelled' }, error instanceof Error ? error : new Error(String(error)))
    this.pump()
  }

  private terminate(state: 'exited' | 'disposed', result: OperationResult): void {
    this.state = state
    if (this.active) this.settle(this.active, result, undefined, `terminal queue is ${state}`)
    for (const entry of this.pending.splice(0)) this.settle(entry, result, undefined, `terminal queue is ${state}`)
  }

  private settle(entry: Entry, result: OperationResult, error?: Error, leaseError?: string): void {
    if (entry.settled) return
    entry.settled = true
    if (entry === this.active) {
      this.clearTimer()
      this.active = undefined
    }
    entry.removeAbort?.()
    this.settleLease(entry, error ?? new Error(leaseError ?? `terminal operation ${result.waitReason}`))
    this.settleResult(entry, result, error)
    if (error) entry.rejectCompletion(error)
    else entry.resolveCompletion(result)
    this.changed()
  }

  private settleResult(entry: Entry, result: OperationResult, error?: Error): void {
    if (entry.resultSettled) return
    entry.resultSettled = true
    if (error) entry.rejectResult(error)
    else entry.resolveResult(result)
  }

  private handle(entry: Entry, authority: object, result: Promise<OperationResult>): EnqueuedOperation {
    return {
      lease: entry.lease,
      result,
      completion: entry.completionPromise,
      append: mutation => this.append(entry, authority, mutation),
      complete: value => this.complete(entry, value, authority),
      cancel: () => this.cancelEntry(entry, authority),
    }
  }

  private settleLease(entry: Entry, error?: Error): void {
    if (entry.leaseSettled) return
    entry.leaseSettled = true
    if (error) entry.rejectLease(error)
    else entry.resolveLease()
  }

  private clearTimer(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
