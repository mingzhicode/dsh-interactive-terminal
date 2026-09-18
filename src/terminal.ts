/** Transactional ownership of one fixed-geometry terminal process generation. */
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyRequest, SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessOutcome, SubprocessRuntime, SubprocessTerminalHandle, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { assertSupportedHost } from './config.ts'
import { ControlledPrompt, createPromptEnvironment } from './prompt.ts'
import type { ScreenSnapshot, TerminalStatus } from './protocol.ts'
import { OperationQueue } from './queue.ts'
import { TerminalScreen, truncateUtf8Tail, type TerminalText } from './screen.ts'

/** Agent session and the public services used to allocate its terminal. */
export interface TerminalOwner {
  session: NonNullable<SandboxPolicyRequest['session']>
  subprocess: Pick<SubprocessRuntime, 'spawnTerminal'>
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>
  sandbox?: Pick<SandboxProvider, 'confine'>
}

/** Ordered screen output and terminal lifecycle notifications. */
export type TerminalEvent =
  | { type: 'state' }
  | { type: 'output'; output: string; sequence: number }
  | { type: 'status'; status: TerminalStatus }
  | { type: 'error'; error: unknown }

interface OutputCapture {
  screen: TerminalScreen
  pending: Promise<void>
}

/** Owns independent queue, prompt recognition, screen, and process lifetime. */
export class TerminalGeneration {
  /** Mutation ownership belongs to this generation; grants call write or signalForeground. */
  readonly queue: OperationQueue
  /** Resolves after process exit and final screen ingestion; rejects on transport failure. */
  readonly done: Promise<SubprocessOutcome>
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  private readonly ready = Promise.withResolvers<void>()
  private readonly drained = Promise.withResolvers<void>()
  private readonly decoder = new TextDecoder()
  private writes = Promise.resolve()
  private state: TerminalStatus = { kind: 'running' }
  private finalSnapshot: ScreenSnapshot | undefined
  private finalText: TerminalText | undefined
  private readonly captures = new Map<string, OutputCapture>()
  private stopped = false
  private disposal: Promise<void> | undefined
  private poll: ReturnType<typeof setTimeout> | undefined
  private promptTimer: ReturnType<typeof setTimeout> | undefined
  private pendingPrompt: (() => void) | undefined

  private constructor(
    readonly generation: number,
    readonly prompt: ControlledPrompt,
    private readonly handle: SubprocessTerminalHandle,
    private readonly screen: TerminalScreen,
    private readonly cleanup: Array<() => void | Promise<void>>,
    private readonly config: Config,
  ) {
    this.queue = new OperationQueue(config, () => this.signalForeground('SIGINT'), () => this.publish({ type: 'state' }))
    this.done = Promise.all([handle.done, this.drained.promise]).then(([outcome]) => {
      this.state = { kind: 'exited', ...outcome }
      this.queue.observe('session_exit')
      this.finalSnapshot ??= this.screen.snapshot()
      clearTimeout(this.poll)
      this.ready.reject(new Error('terminal exited during startup'))
      this.publish({ type: 'status', status: this.state })
      return outcome
    }, error => {
      this.ready.reject(error)
      this.queue.observe('session_exit')
      this.publish({ type: 'error', error })
      throw error
    })
    // A live transport failure owns teardown even when no caller is awaiting done.
    void this.done.catch(() => this.dispose()).catch(error => process.emitWarning(String(error)))
    void this.ready.promise.catch(() => undefined)
    cleanup.push(() => this.stop())
    handle.output.on('data', this.onData)
    handle.output.once('end', this.onEnd)
    handle.output.on('error', this.onError)
    this.scheduleInspection()
  }

  /**
   * Allocate a confined terminal and publish it only after its controlled prompt.
   * @param owner - owning session and mounted public DSH services.
   * @param config - validated deployment settings.
   * @param generation - caller-owned generation counter.
   * @param signal - cancellation through allocation and controlled-prompt startup.
   * @returns A ready terminal with independent queue, parser, and screen.
   */
  static async create(owner: TerminalOwner, config: Config, generation: number, signal?: AbortSignal): Promise<TerminalGeneration> {
    signal?.throwIfAborted()
    assertSupportedHost(config)
    const policy = owner.sandboxPolicy.resolve({ session: owner.session })
    let argv = [config.shellPath, ...config.shellArgs]
    if (policy.mode !== 'danger-full-access') {
      if (!owner.sandbox) throw new Error(`sandbox unavailable for ${policy.mode}`)
      argv = owner.sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
    }
    const environment = createPromptEnvironment(String(owner.session.id))
    const handle = await owner.subprocess.spawnTerminal({ argv, cwd: policy.workspaceRoot, env: environment.env, rows: config.rows, cols: config.cols, graceMs: config.disposeGraceMs, signal })
    // Startup cancellation can prevent constructing the generation that exposes done.
    void handle.done.catch(() => undefined)
    const cleanup: Array<() => void | Promise<void>> = [() => handle.terminate()]
    let terminal: TerminalGeneration | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = Promise.withResolvers<never>()
    const abort = () => cancelled.reject(signal?.reason ?? new Error('terminal startup cancelled'))
    try {
      signal?.throwIfAborted()
      const screen = new TerminalScreen(config)
      cleanup.push(() => screen.dispose())
      terminal = new TerminalGeneration(generation, environment.prompt, handle, screen, cleanup, config)
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => cancelled.reject(new Error('terminal startup timed out before controlled prompt')), config.operationTimeoutMs)
      await Promise.race([terminal.ready.promise, cancelled.promise])
      signal?.throwIfAborted()
      if (terminal.stopped || terminal.state.kind === 'exited') throw new Error('terminal exited during startup')
      terminal.clearPendingPrompt()
      return terminal
    } catch (error) {
      try {
        if (terminal) await terminal.dispose()
        else await rollback(cleanup)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'terminal startup and rollback failed')
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * Write under a queue grant, without adding a newline.
   * @param input - exact terminal input text.
   * @returns Completion of transport delivery, not command completion.
   */
  async write(input: string): Promise<void> {
    this.assertRunning()
    await this.handle.write(input)
  }

  /**
   * Inspect then signal the foreground group; refuse SIGKILL of an observed shell.
   * Compatible providers resolve again before delivery and refuse shell SIGKILL there.
   * @param signal - supported terminal signal.
   * @returns Foreground group actually signalled by the provider.
   */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    this.assertRunning()
    const foreground = await this.handle.inspectForeground()
    this.assertRunning()
    if (!foreground) throw new Error('terminal foreground group unavailable')
    if (signal === 'SIGKILL' && foreground.processGroupId === this.handle.pid) throw new Error('refusing SIGKILL of top-level shell')
    return this.handle.signalForeground(signal)
  }

  /** @returns Current screen, or the retained final snapshot after teardown. */
  snapshot(): ScreenSnapshot { return this.finalSnapshot ?? this.screen.snapshot() }

  /** @returns Rendered active-buffer text retained after teardown. */
  text(): TerminalText { return this.finalText ?? this.screen.text() }

  /**
   * Capture rendered output for one granted operation, bounded during ingestion.
   * @param id - queue identity owning subsequently received output.
   * @returns An idempotent finalizer that closes admission, drains received output, and releases its screen.
   */
  captureOutput(id: string): () => Promise<{ output: string; truncated: boolean }> {
    const screen = new TerminalScreen({ ...this.config, rows: 1, scrollbackLines: Math.max(1, Math.min(this.config.scrollbackLines, Math.floor(this.config.maxToolOutputBytes / (4 * this.config.cols)))), scrollbackMaxBytes: this.config.maxToolOutputBytes })
    const capture: OutputCapture = { screen, pending: Promise.resolve() }
    this.captures.set(id, capture)
    let result: Promise<{ output: string; truncated: boolean }> | undefined
    return () => {
      if (result) return result
      this.captures.delete(id)
      result = capture.pending.then(() => {
        const text = screen.text()
        const bounded = truncateUtf8Tail([...text.history, text.viewport].join('\n'), this.config.maxToolOutputBytes)
        return { output: bounded.text, truncated: bounded.truncated || text.truncated }
      }).finally(() => screen.dispose())
      return result
    }
  }

  /** @returns Top-level process status, retained after disposal. */
  status(): TerminalStatus { return this.state }

  /**
   * Subscribe to future events; consumers take a snapshot for initial state.
   * @param listener - observer whose exceptions cannot break terminal processing.
   * @returns Idempotent unsubscribe function.
   */
  subscribe(listener: (event: TerminalEvent) => void): () => void {
    if (!this.stopped) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Terminate exactly once, awaiting output ingestion and session quiescence. */
  dispose(): Promise<void> {
    this.disposal ??= rollback(this.cleanup)
    return this.disposal
  }

  private readonly onData = (chunk: Uint8Array): void => {
    const observe = this.queue.captureObservation()
    const operationId = this.queue.holder()?.id
    const capture = operationId === undefined ? undefined : this.captures.get(operationId)
    this.handle.output.pause()
    this.writes = this.writes.then(async () => {
      await this.ingest(this.decoder.decode(chunk, { stream: true }), observe, capture)
    }).catch(this.onError).finally(() => {
      if (this.stopped) return
      const output = this.handle.output
      // read() emits one data event for the aggregated bytes, retaining synchronous admission.
      if (output.readableLength > 0) output.read(Math.min(output.readableLength, output.readableHighWaterMark))
      else output.resume()
    })
    if (capture) capture.pending = this.writes
  }

  private readonly onEnd = (): void => {
    const observe = this.queue.captureObservation()
    const operationId = this.queue.holder()?.id
    const capture = operationId === undefined ? undefined : this.captures.get(operationId)
    this.writes = this.writes.then(async () => {
      await this.ingest(this.decoder.decode(), observe, capture)
    }).then(() => this.drained.resolve(), this.onError)
    if (capture) capture.pending = this.writes
  }

  private readonly onError = (error: unknown): void => {
    this.ready.reject(error)
    this.drained.reject(error)
  }

  private async ingest(output: string, observe: ReturnType<OperationQueue['captureObservation']>, capture?: OutputCapture): Promise<void> {
    if (output.length === 0) return
    clearTimeout(this.promptTimer)
    const sequence = await this.screen.write(output)
    if (capture) await capture.screen.write(output)
    if (this.stopped) return
    this.publish({ type: 'output', output, sequence })
    const prompts = this.prompt.consume(output, () => { this.pendingPrompt = () => observe('prompt') })
    if (prompts > 0) this.ready.resolve()
    if (this.pendingPrompt) this.schedulePrompt(this.pendingPrompt)
  }

  private scheduleInspection(): void {
    this.poll = setTimeout(async () => {
      await this.inspectInput()
      if (!this.stopped && this.state.kind === 'running') this.scheduleInspection()
    }, this.config.pollIntervalMs)
  }

  private async inspectInput(): Promise<void> {
    if (this.stopped || this.state.kind === 'exited' || this.queue.status() !== 'busy') return
    const observe = this.queue.captureObservation()
    try {
      const foreground = await this.handle.inspectForeground()
      if (!this.stopped && this.state.kind === 'running' && foreground?.inputWaiting && foreground.processGroupId !== this.handle.pid) observe('stdin_read')
    } catch (error) {
      if (!this.stopped) this.publish({ type: 'error', error })
    }
  }

  private cursorFollowsPrompt(): boolean {
    const { viewport, cursor } = this.screen.text()
    const line = viewport.split('\n')[cursor.y] ?? ''
    return line.slice(0, cursor.x).endsWith(this.prompt.env.PS1)
  }

  private schedulePrompt(candidate: () => void): void {
    this.promptTimer = setTimeout(() => {
      if (this.stopped || this.state.kind === 'exited' || this.pendingPrompt !== candidate || !this.cursorFollowsPrompt()) return
      this.pendingPrompt = undefined
      candidate()
    }, this.config.pollIntervalMs)
  }

  private clearPendingPrompt(): void {
    clearTimeout(this.promptTimer)
    this.promptTimer = undefined
    this.pendingPrompt = undefined
  }

  private async stop(): Promise<void> {
    this.stopped = true
    this.listeners.clear()
    clearTimeout(this.poll)
    this.clearPendingPrompt()
    this.queue.dispose()
    this.handle.output.off('data', this.onData)
    this.handle.output.off('end', this.onEnd)
    await this.writes
    this.finalSnapshot ??= this.screen.snapshot()
    this.finalText ??= this.screen.text()
    this.drained.resolve()
    // Keep the error observer until provider quiescence to consume late transport errors.
    this.cleanup.unshift(() => { this.handle.output.off('error', this.onError) })
  }

  private assertRunning(): void {
    if (this.stopped || this.state.kind === 'exited') throw new Error(`terminal is ${this.stopped ? 'disposed' : 'exited'}`)
  }

  private publish(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { process.emitWarning(`terminal listener failed: ${String(error)}`) }
    }
  }
}

async function rollback(cleanup: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = []
  let release: (() => void | Promise<void>) | undefined
  while ((release = cleanup.pop())) {
    try { await release() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'terminal rollback failed')
}
