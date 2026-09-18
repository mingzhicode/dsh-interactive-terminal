/** Exact-Agent terminal ownership, generation handoff, and Cordis lifetime fences. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { ConfigSchema, validateConfig, type Config } from './config.ts'
import { TerminalGeneration, type TerminalEvent } from './terminal.ts'
import type { ScreenSnapshot, TakeoverId, TerminalStatus } from './protocol.ts'
import type { EnqueuedOperation, OperationKind, QueueStatus, WaitReason } from './queue.ts'
import type { TerminalText } from './screen.ts'

/** One published generation retained for its exact owner, including after exit. */
export interface TerminalRecord {
  readonly owner: Agent
  readonly generation: number
  readonly terminal: TerminalGeneration
}

/** Server facts; tool consumers own cleaned text and model-output budgets. */
export interface TerminalReadResult {
  generation: number
  snapshot: ScreenSnapshot
  status: TerminalStatus
  queueStatus: QueueStatus
  text: TerminalText
  holder: OperationKind | null
  takeoverId: TakeoverId | null
  pendingCount: number
}

/** A newest-relative page of the rendered retained history. */
export interface TerminalPageResult extends TerminalReadResult { page: { text: string; totalLines: number; lineBegin: number; lineEnd: number } }

/** Explicit retained-history page measured backward from the newest line. */
export interface TerminalReadRequest { offset: number; count: number }
/** Explicit model input; tool consumers resolve the submit default. */
export interface TerminalSendRequest { text: string; submit: boolean }
/** A queued foreground signal. */
export interface TerminalSignalRequest { signal: SubprocessTerminalSignal }
/** Terminal facts after a queued mutation settles and its received output drains. */
export interface TerminalOperationResult extends TerminalReadResult { waitReason: WaitReason; queueTimeMs: number; output: string; outputTruncated: boolean }

interface OperationDetails { queueTimeMs: number; output: string; outputTruncated: boolean }

/** Human input authority valid only while its exact queue entry remains active. */
export interface HumanLease {
  readonly done: Promise<TerminalOperationResult>
  /** @param text - exact additional input. @returns Completion of this accepted write. */
  input(text: string): Promise<void>
  /** @returns Settlement after SIGINT recovery; closes admission immediately. */
  cancel(): Promise<TerminalOperationResult>
}

/** Generation-bound server attachment; sockets and controller ownership are separate consumers. */
export interface TerminalAttachment {
  readonly generation: number
  /** @returns Current or retained final generation facts, without queue admission. */
  read(): TerminalReadResult
  /** @param listener - future generation events. @returns Unsubscribe function. */
  subscribe(listener: (event: TerminalEvent) => void): () => void
  /** @param input - first atomic human input. @param signal - cancellation. @param queued - number of earlier accepted mutations, including the active holder. @returns Granted human lease. */
  begin(input: string, signal?: AbortSignal, queued?: (position: number) => void): Promise<HumanLease>
  /** @param target - exact published model operation. @param signal - cancellation for the transferred human lease. @returns Granted in-place human lease. */
  takeover(target: TakeoverId, signal?: AbortSignal): Promise<HumanLease>
}

interface Binding {
  closed: boolean
  accepted: number
  reservations: Set<{ queued: ((position: number) => void) | undefined }>
  nextOperation: number
  barrier: Promise<void> | undefined
  admission: Promise<void> | undefined
  disposal: Promise<void> | undefined
  removeFence: () => void
  removeLifetime: () => void | Promise<void>
}

interface Creation {
  controller: AbortController
  promise: Promise<TerminalRecord>
}

/** Owner lifecycle and quiet admission changes consumed by generation-bound transports. */
export type TerminalLifecycleEvent = { agent: Agent; type: 'reset' | 'disposed' | 'state' }

declare module '@deepseek-ai/cordis' {
  interface Context { interactiveTerminals: InteractiveTerminalService }
  interface Events {
    /** Resource ownership changed after its mutation. @mode emit */
    'interactive-terminal/ownership'(): void
  }
}

/** Registered terminal service; every input mutation is granted by a generation queue. */
export class InteractiveTerminalService extends Service {
  static inject = ['agents', 'subprocess', 'sandboxPolicy']
  static Config = ConfigSchema
  private readonly records = new WeakMap<Agent, TerminalRecord>()
  private readonly creating = new WeakMap<Agent, Creation>()
  private readonly pendingOwners = new Set<Agent>()
  private readonly live = new Set<TerminalRecord>()
  private readonly bindings = new Map<Agent, Binding>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private readonly settledOwners = new WeakSet<Agent>()
  private disposal: Promise<void> | undefined
  private closed = false
  private readonly listeners = new Set<(event: TerminalLifecycleEvent) => void | Promise<void>>()

  /** @param ctx - mounted Cordis services. @param config - resolved deployment settings. */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'interactiveTerminals')
    validateConfig(config)
    ctx.on('agent/disposed', ({ agent }) => this.disposeAgent(agent))
    ctx.effect(() => () => this.dispose(), 'interactive terminal teardown')
  }

  /** Pending and live owners, counted once across generation replacement. */
  get size(): number { return new Set([...this.pendingOwners, ...[...this.live].map(record => record.owner)]).size }

  /** @param listener - Lifecycle observer; owner disposal awaits disposed callbacks concurrently with process termination. @returns Idempotent unsubscribe. */
  subscribe(listener: (event: TerminalLifecycleEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @returns Copied counts from the authoritative owner bindings and live generation registry. */
  ownership(): ReadonlyArray<{ readonly owner: Agent; readonly generations: readonly number[]; readonly queued: number }> {
    const owners = new Set([...this.bindings.keys(), ...this.pendingOwners, ...[...this.live].map(record => record.owner)])
    return [...owners].map(owner => ({ owner, generations: [...this.live].filter(record => record.owner === owner).map(record => record.generation), queued: this.bindings.get(owner)?.accepted ?? 0 }))
  }

  /** @param owner - exact Agent. @returns Whether owner cleanup or its whole scope has settled. */
  isDisposed(owner: Agent): boolean { return this.settledOwners.has(owner) || (owner.ctx.fiber.uid === null && owner.ctx.fiber.inertia === undefined) }

  /**
   * Bind calls to an exact Agent obtained from tool execution or the live registry.
   * @param agent - current live Agent object; same-id substitutes are rejected.
   * @returns Owner-bound methods, without accepting another identity from callers.
   */
  forAgent(agent: Agent) {
    this.binding(agent)
    return {
      ensure: (signal?: AbortSignal) => this.ensure(agent, signal),
      read: (request: TerminalReadRequest, signal?: AbortSignal) => this.read(agent, request, signal),
      send: (request: TerminalSendRequest, signal?: AbortSignal) => this.send(agent, request, signal),
      signal: (request: TerminalSignalRequest, signal?: AbortSignal) => this.signal(agent, request, signal),
      reset: (signal?: AbortSignal) => this.reset(agent, signal),
      attach: () => this.attach(agent),
    }
  }

  /**
   * Share one unpublished allocation and preserve an exited record until explicit reset.
   * @param agent - exact live owner.
   * @param signal - allocation cancellation; the initiating caller owns a shared creation.
   * @returns Published generation, or the retained exited generation.
   */
  async ensure(agent: Agent, signal?: AbortSignal): Promise<TerminalRecord> {
    signal?.throwIfAborted()
    const binding = this.binding(agent)
    if (binding.barrier) await waitFor(binding.barrier, signal)
    this.assertOwner(agent)
    return waitFor(this.ensureCurrent(agent, signal), signal)
  }

  /**
   * Read a retained-history page without waiting for mutation ownership.
   * @param agent - exact live owner.
   * @param request - explicit line offset and count; viewport stays complete.
   * @param signal - cancellation while awaiting lazy allocation.
   * @returns Screen, process, and queue facts.
   */
  async read(agent: Agent, request: TerminalReadRequest, signal?: AbortSignal): Promise<TerminalPageResult> {
    signal?.throwIfAborted()
    const record = this.records.get(agent)
    this.binding(agent)
    const state = this.state(record ?? await this.ensure(agent, signal))
    const lines = state.text.history
    const end = Math.max(0, lines.length - request.offset)
    const start = Math.max(0, end - request.count)
    return { ...state, page: { text: lines.slice(start, end).join('\n'), totalLines: lines.length, lineBegin: start, lineEnd: end } }
  }

  /**
   * Queue one model write and await readiness or cancellation recovery.
   * @param agent - exact live owner.
   * @param request - input with resolved newline policy.
   * @param signal - queued removal or active SIGINT recovery.
   * @returns Terminal facts and the operation's settlement reason.
   */
  async send(agent: Agent, request: TerminalSendRequest, signal?: AbortSignal): Promise<TerminalOperationResult> {
    const text = request.text + (request.submit ? '\r' : '')
    this.checkInput(text)
    const accepted = this.accept(agent, 'model-send', record => record.terminal.write(text), signal)
    const { record, operation, details } = await accepted
    return this.settled(record, operation, details)
  }

  /**
   * Queue a signal without bypassing earlier human or model input.
   * @param agent - exact live owner.
   * @param request - allowed foreground signal.
   * @param signal - operation cancellation.
   * @returns Settlement facts and the group actually signalled, when delivered.
   */
  async signal(agent: Agent, request: TerminalSignalRequest, signal?: AbortSignal): Promise<TerminalOperationResult & { processGroupId: number | undefined }> {
    let processGroupId: number | undefined
    const { record, operation, details } = await this.accept(agent, 'signal', async record => { processGroupId = await record.terminal.signalForeground(request.signal) }, signal)
    return { ...await this.settled(record, operation, details), processGroupId }
  }

  /**
   * Admit a FIFO generation handoff; later mutations await its completion.
   * Cancellation before replacement retains the predecessor's outcome; a failed replacement blocks ordinary mutations until another reset.
   * @param agent - exact live owner.
   * @param signal - cancellation before grant or during replacement allocation.
   * @returns Fresh generation facts after the controlled startup prompt.
   */
  async reset(agent: Agent, signal?: AbortSignal): Promise<TerminalReadResult & { queueTimeMs: number; waitReason: 'prompt' }> {
    const acceptedAt = performance.now()
    const binding = this.binding(agent)
    const release = this.reserve(binding, agent)
    const previous = binding.barrier
    const admission = binding.admission
    let replacementStarted = false
    const result = (record: TerminalRecord, queueTimeMs: number) => {
      const state = this.state(record)
      // This completed reset still owns its reservation until the finally handler.
      return { ...state, pendingCount: Math.max(0, state.pendingCount - 1), queueTimeMs, waitReason: 'prompt' as const }
    }
    const resetting = (async () => {
      // Explicit reset may recover a failed handoff; ordinary mutations retain its rejection.
      if (previous) await waitFor(previous.catch(() => undefined), signal)
      if (admission) await waitFor(admission, signal)
      signal?.throwIfAborted()
      this.assertOwner(agent)
      if (!this.records.has(agent) && !this.creating.has(agent)) {
        replacementStarted = true
        this.publish({ agent, type: 'reset' })
        const queueTimeMs = performance.now() - acceptedAt
        return result(await this.ensureCurrent(agent, signal), queueTimeMs)
      }
      const record = await waitFor(this.ensureCurrent(agent), signal)
      let replacing: Promise<TerminalRecord> | undefined
      let queueTimeMs = 0
      const replace = () => { replacementStarted = true; queueTimeMs = performance.now() - acceptedAt; return replacing = this.createRecord(agent, record.generation + 1, signal, record) }
      const status = record.terminal.queue.status()
      if (status === 'exited' || status === 'disposed') return result(await replace(), queueTimeMs)
      const operation = record.terminal.queue.enqueue({ id: String(++binding.nextOperation), kind: 'reset' }, async () => { await replace() }, signal)
      try {
        await operation.lease
      } catch (error) {
        if (!replacing) {
          if (record.terminal.queue.status() !== 'exited') throw error
          signal?.throwIfAborted()
          await record.terminal.done
          this.assertOwner(agent)
          await replace()
        }
      }
      return result(await replacing!, queueTimeMs)
    })().finally(release)
    // A cancelled follower releases its caller immediately but cannot bypass an earlier handoff.
    binding.barrier = Promise.allSettled([previous, admission, resetting]).then(() => resetting).then(() => undefined, error => {
      if (!replacementStarted && signal?.aborted) return previous
      throw error
    })
    void binding.barrier.catch(() => undefined)
    return resetting
  }

  /**
   * Attach reads and human leases to the current exact generation.
   * @param agent - live Agent resolved through the public registry by the Web consumer.
   * @returns Snapshot/subscription and queued human-input capabilities.
   */
  async attach(agent: Agent): Promise<TerminalAttachment> {
    const record = await this.ensure(agent)
    const lease = (operation: EnqueuedOperation, details: Promise<OperationDetails>, initialBytes: number): HumanLease => {
      let bytes = initialBytes
      const done = this.settled(record, operation, details)
      void done.catch(() => undefined)
      return {
        done,
        input: async text => {
          const next = bytes + Buffer.byteLength(text)
          if (next > this.config.maxInputBytes) throw new Error('terminal input exceeds maxInputBytes')
          const appended = operation.append(() => record.terminal.write(text))
          bytes = next
          await appended
        },
        cancel: () => { operation.cancel(); return done },
      }
    }
    return {
      generation: record.generation,
      read: () => this.state(record),
      subscribe: listener => record.terminal.subscribe(listener),
      begin: async (input, signal, queued) => {
        const bytes = this.checkInput(input)
        const { operation, details } = await this.accept(agent, 'human', current => current.terminal.write(input), signal, record, queued)
        await operation.lease
        return lease(operation, details, bytes)
      },
      takeover: async (target, signal) => {
        signal?.throwIfAborted()
        this.assertOwner(agent)
        if (this.records.get(agent) !== record) throw new Error('terminal attachment generation is stale')
        const operation = record.terminal.queue.takeover(target, signal)
        await operation.lease
        return lease(operation, Promise.resolve({ queueTimeMs: 0, output: '', outputTruncated: false }), 0)
      },
    }
  }

  /**
   * Reject a mode change while this owner has pending or live process resources.
   * @param agent - exact owner whose session policy is being changed.
   */
  assertSandboxChangeAllowed(agent: Agent): void {
    const record = this.records.get(agent)
    if (this.pendingOwners.has(agent) || (record && this.live.has(record))) throw new Error('cannot change sandbox mode while terminal is active')
  }

  /**
   * Fence further calls and await every resource owned by this exact Agent.
   * @param agent - owner being detached or explicitly closed.
   * @returns Completion after pending creation rollback and live process teardown.
   */
  disposeAgent(agent: Agent): Promise<void> {
    const wasDisposed = this.disposedOwners.has(agent)
    this.disposedOwners.add(agent)
    const binding = this.bindings.get(agent)
    if (!binding) return Promise.resolve()
    binding.closed = true
    this.creating.get(agent)?.controller.abort(new Error('terminal Agent disposed'))
    binding.disposal ??= (async () => {
      const errors: unknown[] = []
      const revoked = wasDisposed ? Promise.resolve() : Promise.all([...this.listeners].map(async listener => listener({ agent, type: 'disposed' }))).then(() => undefined)
      void revoked.catch(() => undefined)
      const pending = this.creating.get(agent)
      if (pending) {
        try { await pending.promise } catch (error) { if (error instanceof AggregateError) errors.push(error) }
      }
      const record = this.records.get(agent)
      if (record) {
        try { await record.terminal.dispose(); this.live.delete(record) } catch (error) { errors.push(error) }
      }
      try { await revoked } catch (error) { errors.push(error) }
      await Promise.allSettled([binding.admission, binding.barrier])
      if (errors.length) throw new AggregateError(errors, 'terminal owner cleanup failed')
      this.records.delete(agent)
      binding.removeFence()
      this.bindings.delete(agent)
      await binding.removeLifetime()
      this.settledOwners.add(agent)
      this.ctx.emit('interactive-terminal/ownership')
    })()
    return binding.disposal
  }

  /** Stop intake and await reverse-creation-order cleanup, including pending allocations. */
  dispose(): Promise<void> {
    this.closed = true
    for (const agent of this.pendingOwners) this.creating.get(agent)?.controller.abort(new Error('terminal service disposed'))
    this.disposal ??= (async () => {
      const errors: unknown[] = []
      const owners = new Set([...this.pendingOwners].reverse().concat([...this.live].reverse().map(record => record.owner), [...this.bindings.keys()].reverse()))
      for (const owner of owners) {
        try { await this.disposeAgent(owner) } catch (error) { errors.push(error) }
      }
      for (const binding of this.bindings.values()) {
        try { await binding.removeLifetime() } catch (error) { errors.push(error) }
      }
      this.bindings.clear()
      this.listeners.clear()
      if (errors.length) throw new AggregateError(errors, 'terminal service cleanup failed')
    })()
    return this.disposal
  }

  private ensureCurrent(agent: Agent, signal?: AbortSignal): Promise<TerminalRecord> {
    this.assertOwner(agent)
    const pending = this.creating.get(agent)
    if (pending) return pending.promise
    const record = this.records.get(agent)
    return record ? Promise.resolve(record) : this.createRecord(agent, 1, signal)
  }

  private createRecord(agent: Agent, generation: number, signal?: AbortSignal, previous?: TerminalRecord): Promise<TerminalRecord> {
    const alreadyCounted = previous && this.live.has(previous)
    if (!alreadyCounted && this.size >= this.config.maxSessions) return Promise.reject(new Error('terminal capacity reached'))
    const controller = new AbortController()
    const allocationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    this.pendingOwners.add(agent)
    let cleanupFailed = false
    const creation: Creation = { controller, promise: Promise.resolve().then(async () => {
      if (previous) {
        this.publish({ agent, type: 'reset' })
        await previous.terminal.dispose()
      }
      allocationSignal.throwIfAborted()
      this.assertOwner(agent)
      const sandbox = agent.ctx.get('sandbox')
      const subprocess = agent.ctx.get('subprocess')
      const sandboxPolicy = agent.ctx.get('sandboxPolicy')
      if (!subprocess || !sandboxPolicy) throw new Error('terminal Agent requires subprocess and sandbox policy providers')
      const terminal = await TerminalGeneration.create({ session: agent.session, subprocess, sandboxPolicy, ...(sandbox ? { sandbox } : {}) }, this.config, generation, allocationSignal)
      try { this.assertOwner(agent) } catch (error) { await terminal.dispose(); throw error }
      const record: TerminalRecord = { owner: agent, generation, terminal }
      this.records.set(agent, record)
      if (previous) this.live.delete(previous)
      this.live.add(record)
      this.ctx.emit('interactive-terminal/ownership')
      void terminal.done.then(() => this.exited(record), () => this.exited(record)).catch(error => this.ctx.logger('interactive-terminals').warn(error))
      return record
    }).catch(error => {
      // Generation rollback failures retain capacity and the sandbox-mode fence.
      cleanupFailed = error instanceof AggregateError
      throw error
    }).finally(() => {
      if (!cleanupFailed) { this.creating.delete(agent); this.pendingOwners.delete(agent) }
    }) }
    this.creating.set(agent, creation)
    return creation.promise
  }

  private async exited(record: TerminalRecord): Promise<void> {
    await record.terminal.dispose()
    this.live.delete(record)
    this.ctx.emit('interactive-terminal/ownership')
  }

  private async accept(agent: Agent, kind: Exclude<OperationKind, 'reset' | 'disconnect-recovery'>, grant: (record: TerminalRecord) => void | Promise<void>, signal?: AbortSignal, expected?: TerminalRecord, queued?: (position: number) => void): Promise<{ record: TerminalRecord; operation: EnqueuedOperation; details: Promise<OperationDetails> }> {
    const acceptedAt = performance.now()
    const binding = this.binding(agent)
    const release = this.reserve(binding, agent, queued)
    const id = String(++binding.nextOperation)
    const barrier = binding.barrier
    const previous = binding.admission
    const admission = (async () => {
      try {
        if (barrier) await waitFor(barrier, signal)
        if (previous) await waitFor(previous, signal)
        signal?.throwIfAborted()
        const record = await waitFor(this.ensureCurrent(agent, signal), signal)
        this.assertOwner(agent)
        if (expected && record !== expected) throw new Error('terminal attachment generation is stale')
        let queueTimeMs: number | undefined
        let finish: ReturnType<TerminalGeneration['captureOutput']> | undefined
        const operation = record.terminal.queue.enqueue({ id, kind }, () => {
          queueTimeMs = performance.now() - acceptedAt
          if (kind !== 'human') finish = record.terminal.captureOutput(id)
          return grant(record)
        }, signal)
        const details = operation.result.then(async () => {
          const waited = queueTimeMs ?? performance.now() - acceptedAt
          const captured = await finish?.()
          return { queueTimeMs: waited, output: captured?.output ?? '', outputTruncated: captured?.truncated ?? false }
        }, async error => { await finish?.(); throw error })
        void details.catch(() => undefined)
        void operation.completion.then(release, release)
        return { record, operation, details }
      } catch (error) { release(); throw error }
    })()
    binding.admission = Promise.allSettled([previous, admission]).then(() => undefined)
    return admission
  }

  private reserve(binding: Binding, agent: Agent, queued?: (position: number) => void): () => void {
    if (binding.accepted >= this.config.maxQueuedOperations) throw new Error('terminal queue is full')
    binding.accepted += 1
    const reservation = { queued }
    binding.reservations.add(reservation)
    const notify = () => {
      this.publish({ agent, type: 'state' })
      let position = 0
      for (const item of binding.reservations) {
        try { item.queued?.(position) } catch (error) { this.ctx.logger('interactive-terminals').warn(error) }
        position += 1
      }
    }
    notify()
    return () => { binding.accepted -= 1; binding.reservations.delete(reservation); notify() }
  }

  private publish(event: TerminalLifecycleEvent): void {
    for (const listener of this.listeners) {
      try { void Promise.resolve(listener(event)).catch(error => this.ctx.logger('interactive-terminals').warn(error)) } catch (error) { this.ctx.logger('interactive-terminals').warn(error) }
    }
  }

  private binding(agent: Agent): Binding {
    this.assertOwner(agent)
    const existing = this.bindings.get(agent)
    if (existing) return existing
    const binding: Binding = { closed: false, accepted: 0, reservations: new Set(), nextOperation: 0, barrier: undefined, admission: undefined, disposal: undefined, removeFence: () => undefined, removeLifetime: () => undefined }
    this.bindings.set(agent, binding)
    binding.removeFence = agent.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      if (session !== agent.session || event.type !== 'sandbox/mode') return
      const policy = agent.ctx.get('sandboxPolicy')
      if (!policy) throw new Error('terminal Agent requires a sandbox policy provider')
      const current = effectiveSandboxMode(session.events) ?? policy.defaultMode
      if (event.data.mode !== current) this.assertSandboxChangeAllowed(agent)
    }, { global: true })
    binding.removeLifetime = agent.ctx.effect(() => () => this.disposeAgent(agent), 'interactive terminal Agent teardown')
    return binding
  }

  private assertOwner(agent: Agent): void {
    if (this.closed || this.disposedOwners.has(agent) || this.bindings.get(agent)?.closed) throw new Error('terminal owner or service is disposed')
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('terminal owner is not the exact registered Agent')
  }

  private checkInput(text: string): number {
    const bytes = Buffer.byteLength(text)
    if (bytes > this.config.maxInputBytes) throw new Error('terminal input exceeds maxInputBytes')
    return bytes
  }

  private state(record: TerminalRecord): TerminalReadResult {
    const holder = record.terminal.queue.holder()?.kind ?? null
    const pendingCount = Math.max(0, (this.bindings.get(record.owner)?.accepted ?? 0) - Number(holder !== null))
    return { generation: record.generation, snapshot: record.terminal.snapshot(), status: record.terminal.status(), queueStatus: record.terminal.queue.status(), text: record.terminal.text(), holder, takeoverId: record.terminal.queue.takeoverId(), pendingCount }
  }

  private async settled(record: TerminalRecord, operation: EnqueuedOperation, details: Promise<OperationDetails>): Promise<TerminalOperationResult> {
    const captured = await details
    const result = await operation.result
    if (result.waitReason === 'session_exit') await record.terminal.done
    return { ...this.state(record), ...result, ...captured }
  }
}

export default InteractiveTerminalService

/** Await shared work without transferring cancellation to its owner. */
async function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return pending
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([pending, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
