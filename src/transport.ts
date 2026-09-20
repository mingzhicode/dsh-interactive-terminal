/** Exact-Agent, single-use Web credentials and generation-bound controller sockets. */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Config } from './config.ts'
import { assertNever, type ClientFrame, type ServerFrame, type TakeoverId } from './protocol.ts'
import type { HumanLease, TerminalAttachment, TerminalOperationResult, TerminalReadResult } from './service.ts'
import type { TerminalEvent } from './terminal.ts'

/** Trusted RPC channel; its only endpoint is token. */
export const RPC_CHANNEL = '/dsh-interactive-terminal'
/** Exact WebSocket route, without query parameters. */
export const WS_PATH = '/dsh-interactive-terminal/ws'
/** Negotiated protocol; credentials travel in a second, unselected token.<raw> subprotocol. */
export const WS_PROTOCOL = 'dsh-interactive-terminal.v1'
const TOKEN_TTL_MS = 10_000
const secret = () => randomBytes(32).toString('base64url')
const digest = (raw: string) => createHash('sha256').update(raw).digest('base64url')

interface AttachToken {
  agent: Agent
  expiresAt: number
  epoch: number
  readonly: boolean
  resume: { controller: Controller; proof: string } | 'invalid' | undefined
}
interface HumanOperation {
  abort: AbortController
  lease?: HumanLease
  position?: number
  done: Promise<void>
}
type HandoffSettlement =
  | { kind: 'completed'; result: TerminalOperationResult }
  | { kind: 'failed'; state: TerminalReadResult }
interface HandoffObserver {
  failedState(): TerminalReadResult
  settled(outcome: HandoffSettlement): void
}
interface Controller {
  agent: Agent
  proof: string
  socket: Connection | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  recovering: boolean
  operation: HumanOperation | undefined
}
interface Connection {
  socket: WebSocket
  token: AttachToken
  attachment?: TerminalAttachment
  controller?: Controller
  unsubscribe?: () => void
  closing?: ReturnType<typeof setTimeout>
  closed: Promise<void>
  bufferLimit: number
}

/** Owns public registrations, attach credentials, sockets, and disconnect recovery. */
export class TerminalTransport {
  static inject = ['connection', 'webServer', 'agents', 'interactiveTerminals']
  private readonly tokens = new Map<string, AttachToken>()
  private readonly epochs = new WeakMap<Agent, number>()
  private readonly disposedOwners = new WeakSet<Agent>()
  private readonly controllers = new Map<Agent, Controller>()
  private readonly connections = new Set<Connection>()
  private readonly pending = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly disposers: Array<() => void | Promise<void>> = []
  private readonly server: WebSocketServer
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private disposal: Promise<void> | undefined

  /** @param ctx - public host services. @param config - validated terminal settings. */
  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.disposers.push(ctx.provide('interactiveTerminalTransport', this))
    this.server = new WebSocketServer({ noServer: true, maxPayload: config.maxInputBytes * 6 + 256, perMessageDeflate: false, handleProtocols: () => WS_PROTOCOL })
    ctx.effect(() => () => this.dispose(), 'interactive terminal Web transport')
    const own = (install: () => () => void | Promise<void>) => { const remove = ctx.effect(install); this.disposers.push(remove) }
    own(() => ctx.interactiveTerminals.subscribe(event => {
      if (event.type !== 'state') return this.revoke(event.agent, event.type === 'reset' ? 4001 : 4002)
      else for (const connection of this.connections) if (connection.token.agent === event.agent) this.status(connection)
    }))
    own(() => ctx.connection.rpc.handle(RPC_CHANNEL, this.rpc, { authority: 'trusted-host' }))
    own(() => ctx.webServer.registerUpgrade({ path: WS_PATH, handler: (request, socket, head) => this.upgrade(request, socket, head) }))
  }

  /** @returns Counts derived from retained sockets and controller operations, grouped by exact Agent. */
  ownership(): ReadonlyArray<{ readonly owner: Agent; readonly sockets: number; readonly pending: number }> {
    const owners = new Set([...this.controllers.keys(), ...[...this.connections].map(connection => connection.token.agent)])
    return [...owners].map(owner => ({ owner, sockets: [...this.connections].filter(connection => connection.token.agent === owner).length, pending: Number(this.controllers.get(owner)?.operation !== undefined) }))
  }

  /** @param agent - exact live owner. @param options - browser read-only intent and private reconnect proof. @returns One-use credential, valid for ten seconds. */
  async issueToken(agent: Agent, options: { readonly?: boolean; resume?: string } = {}): Promise<string> {
    if (this.stopped) throw new Error('terminal transport disposed')
    this.ctx.interactiveTerminals.forAgent(agent)
    this.prune()
    const raw = secret()
    const controller = this.controllers.get(agent)
    const resume = options.resume === undefined ? undefined : controller && digest(options.resume) === controller.proof && !controller.recovering ? { controller, proof: controller.proof } : 'invalid'
    this.tokens.set(digest(raw), { agent, expiresAt: Date.now() + TOKEN_TTL_MS, epoch: this.epochs.get(agent) ?? 0, readonly: options.readonly ?? false, resume })
    this.schedulePrune()
    return raw
  }

  /** @param raw - presented one-use secret. @param agent - exact expected owner. @returns Consumed owner-bound credential. */
  async consumeToken(raw: string, agent: Agent): Promise<AttachToken> { return this.takeToken(raw, agent) }

  /** @param request - same-origin upgrade request. @param socket - owned HTTP socket. @param head - unconsumed upgrade bytes. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (request.url !== WS_PATH || !sameOrigin(request)) throw new Error('invalid request')
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(part => part.trim())
      if (protocols?.length !== 2 || protocols[0] !== WS_PROTOCOL || !/^token\.[A-Za-z0-9_-]{43}$/.test(protocols[1]!)) throw new Error('invalid protocol')
      const token = this.takeToken(protocols[1]!.slice(6))
      this.server.handleUpgrade(request, socket, head, ws => {
        let resolve!: () => void
        const connection: Connection = { socket: ws, token, bufferLimit: this.config.scrollbackMaxBytes, closed: new Promise<void>(done => { resolve = done }) }
        this.connections.add(connection)
        ws.on('error', () => this.close(connection, 1011, 'terminal-transport-error'))
        ws.on('close', () => {
          clearTimeout(connection.closing)
          connection.unsubscribe?.()
          this.connections.delete(connection)
          this.disconnected(connection)
          resolve()
        })
        ws.on('message', (data, binary) => this.message(connection, data, binary))
        this.track(this.attach(connection))
      })
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }
  }

  /** Stop new work, revoke credentials, cancel existing human operations, and await cleanup. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.stopped = true
    this.lifetime.abort(new Error('terminal transport disposed'))
    clearTimeout(this.timer)
    this.tokens.clear()
    const sockets = [...this.connections]
    const operations = [...this.controllers.values()].map(controller => this.recover(controller))
    for (const connection of sockets) this.close(connection, 4002, 'terminal-disposed')
    this.disposal = (async () => {
      const removals = await Promise.allSettled(this.disposers.reverse().map(remove => Promise.resolve().then(remove)))
      const settled = await Promise.allSettled([...operations, ...sockets.map(connection => connection.closed), ...this.pending])
      await new Promise<void>(resolve => this.server.close(() => resolve()))
      const errors = [...removals, ...settled].filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'terminal transport cleanup failed')
    })()
    return this.disposal
  }

  private readonly rpc: ConnectionRpcHandler = async (endpoint, payload, signal) => {
    if (endpoint !== 'token' || !object(payload) || !only(payload, ['sessionId', 'readonly', 'resume']) || typeof payload.sessionId !== 'string' || !payload.sessionId || typeof payload.readonly !== 'boolean' || (payload.resume !== undefined && (typeof payload.resume !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.resume)))) {
      return { ok: false, error: { code: 'bad-request', message: 'invalid terminal token request', details: { issues: [] } } }
    }
    if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'terminal request cancelled', details: {} } }
    const id = SessionId(payload.sessionId)
    const agent = this.ctx.agents.get(id)
    if (!agent) return { ok: false, error: { code: 'session-not-found', message: 'terminal session is not live', details: { sessionId: id } } }
    try {
      const token = await this.issueToken(agent, { readonly: payload.readonly, ...(typeof payload.resume === 'string' ? { resume: payload.resume } : {}) })
      return { ok: true, value: { token, version: 1, path: WS_PATH, protocol: WS_PROTOCOL, expiresInMs: TOKEN_TTL_MS } }
    } catch { return { ok: false, error: { code: 'internal', message: 'terminal transport unavailable', details: {} } } }
  }

  private takeToken(raw: string, expected?: Agent): AttachToken {
    this.prune()
    const key = digest(raw)
    const token = this.tokens.get(key)
    if (this.stopped || !token || (expected && token.agent !== expected) || this.ctx.agents.get(token.agent.id) !== token.agent || token.epoch !== (this.epochs.get(token.agent) ?? 0)) throw new Error('invalid or expired terminal token')
    this.tokens.delete(key)
    this.schedulePrune()
    return token
  }

  private prune(): void {
    for (const [key, token] of this.tokens) if (token.expiresAt <= Date.now()) this.tokens.delete(key)
  }

  private schedulePrune(): void {
    clearTimeout(this.timer)
    if (this.tokens.size) {
      const next = Math.min(...[...this.tokens.values()].map(token => token.expiresAt))
      this.timer = setTimeout(() => { this.prune(); this.schedulePrune() }, Math.max(0, next - Date.now()))
      this.timer.unref()
    }
  }

  private async attach(connection: Connection): Promise<void> {
    try {
      const attachment = await this.ctx.interactiveTerminals.attach(connection.token.agent)
      if (this.stopped || connection.socket.readyState !== WebSocket.OPEN || connection.token.epoch !== (this.epochs.get(connection.token.agent) ?? 0)) return
      connection.attachment = attachment
      let ready = false
      let watermark = -1
      const buffered: TerminalEvent[] = []
      const publish = (event: TerminalEvent) => {
        if (!ready) { buffered.push(event); return }
        switch (event.type) {
          case 'output':
            if (event.sequence > watermark) { watermark = event.sequence; this.send(connection, { type: 'terminal.output', output: event.output, sequence: event.sequence }) }
            break
          case 'state':
          case 'status': this.status(connection); break
          case 'error': this.send(connection, { type: 'terminal.error', code: 'transport-failed', message: 'Terminal transport failed.' }); break
          default: assertNever(event)
        }
      }
      connection.unsubscribe = attachment.subscribe(publish)
      const state = attachment.read()
      watermark = state.snapshot.sequence
      this.send(connection, { type: 'terminal.snapshot', snapshot: state.snapshot, scrollbackLines: this.config.scrollbackLines })
      this.claim(connection)
      this.status(connection)
      ready = true
      for (const event of buffered) publish(event)
    } catch {
      this.close(connection, 1011, 'terminal-attach-failed')
    }
  }

  private claim(connection: Connection): void {
    const { agent, resume, readonly } = connection.token
    const current = this.controllers.get(agent)
    let reason: 'readonly' | 'invalid-resume' | 'controller-busy' | undefined
    if (readonly) reason = 'readonly'
    else if (resume === 'invalid' || (resume && (resume.controller !== current || resume.proof !== current.proof || current.recovering))) reason = 'invalid-resume'
    else if (current && (current.socket || current.recovering || resume?.controller !== current)) reason = 'controller-busy'
    if (reason) { this.send(connection, { type: 'terminal.attached', mode: 'readonly', reason, maxInputBytes: this.config.maxInputBytes }); return }
    const raw = secret()
    const controller: Controller = current ?? { agent, proof: '', socket: undefined, timer: undefined, recovering: false, operation: undefined }
    clearTimeout(controller.timer)
    controller.timer = undefined
    controller.proof = digest(raw)
    controller.socket = connection
    connection.controller = controller
    this.controllers.set(agent, controller)
    this.send(connection, { type: 'terminal.attached', mode: 'controller', resume: raw, maxInputBytes: this.config.maxInputBytes })
    if (controller.operation?.lease) this.send(connection, { type: 'human.granted' })
    else if (controller.operation?.position !== undefined) this.send(connection, { type: 'human.queued', position: controller.operation.position })
  }

  private message(connection: Connection, data: RawData, binary: boolean): void {
    if (this.stopped || connection.closing) return
    try {
      if (binary || !connection.attachment) throw new Error('invalid frame')
      const frame = parseFrame(data.toString(), connection.attachment.generation, this.config.maxInputBytes)
      if (frame.type === 'heartbeat') { this.send(connection, { type: 'heartbeat' }); return }
      const controller = connection.controller
      if (!controller || controller.socket !== connection || controller.recovering) throw new Error('not controller')
      switch (frame.type) {
        case 'human.begin':
          if (controller.operation) throw new Error('already begun')
          {
            const state = connection.attachment.read()
            if (state.queueStatus !== 'ready' || state.holder !== null || state.pendingCount !== 0) {
              this.error(connection)
              this.send(connection, { type: 'human.revoked' })
              break
            }
          }
          this.begin(connection, controller, frame.input)
          break
        case 'human.takeover':
          if (controller.operation) throw new Error('already begun')
          this.takeover(connection, controller, frame.target)
          break
        case 'human.input':
          if (!controller.operation?.lease) throw new Error('not granted')
          this.track(controller.operation.lease.input(frame.input).catch(() => { this.error(connection); this.cancel(controller) }))
          break
        case 'human.cancel': this.cancel(controller); break
        case 'terminal.reset':
          this.track(this.ctx.interactiveTerminals.reset(connection.token.agent, this.lifetime.signal).then(() => undefined, () => this.error(connection)))
          break
        default: assertNever(frame)
      }
    } catch { this.close(connection, 1008, 'terminal-protocol-error') }
  }

  private begin(connection: Connection, controller: Controller, input: string): void {
    this.operate(controller, operation => connection.attachment!.begin(input, operation.abort.signal, position => {
      operation.position = position
      if (!operation.lease && !operation.abort.signal.aborted && controller.socket) this.send(controller.socket, { type: 'human.queued', position })
    }))
  }

  private takeover(connection: Connection, controller: Controller, target: TakeoverId): void {
    this.operate(
      controller,
      operation => connection.attachment!.takeover(target, operation.abort.signal),
      {
        failedState: () => connection.attachment!.read(),
        settled: outcome => this.notifyHandoff(controller.agent, outcome),
      },
    )
  }

  private operate(controller: Controller, acquire: (operation: HumanOperation) => Promise<HumanLease>, observer?: HandoffObserver): void {
    const operation: HumanOperation = { abort: new AbortController(), done: Promise.resolve() }
    controller.operation = operation
    operation.done = (async () => {
      let lease: HumanLease | undefined
      try {
        lease = await acquire(operation)
        operation.lease = lease
        if (controller.socket) this.send(controller.socket, { type: 'human.granted' })
        const result = await lease.done
        observer?.settled({ kind: 'completed', result })
      } catch {
        if (lease && observer) observer.settled({ kind: 'failed', state: observer.failedState() })
        if (!operation.abort.signal.aborted && controller.socket) this.error(controller.socket)
      }
      finally {
        if (controller.operation === operation) controller.operation = undefined
        if (controller.socket) { this.send(controller.socket, { type: 'human.revoked' }); this.status(controller.socket) }
      }
    })()
    this.track(operation.done)
  }

  private notifyHandoff(agent: Agent, outcome: HandoffSettlement): void {
    if (this.stopped || this.disposedOwners.has(agent) || this.ctx.agents.get(agent.id) !== agent || this.ctx.interactiveTerminals.isDisposed(agent)) return
    const state = outcome.kind === 'completed' ? outcome.result : outcome.state
    const reason = outcome.kind === 'completed' ? ` waitReason=${outcome.result.waitReason}` : ''
    const label = outcome.kind === 'completed' ? 'finished' : 'failed'
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: `Shared terminal human handoff ${label}.\n`
          + `generation=${state.generation} sequence=${state.snapshot.sequence}${reason} terminalStatus=${JSON.stringify(state.status)}\n`
          + 'Before sending terminal input or signals, call shared_terminal_read and inspect its newest retained history page plus viewport. The read is cumulative for this terminal generation, not isolated to this handoff.',
      }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-interactive-terminal',
        form: 'notice',
        summary: `Shared terminal human handoff ${label}${outcome.kind === 'completed' ? ` (${outcome.result.waitReason})` : ''}`,
      },
    })
    try {
      if (agent.status === 'idle') agent.followup(message)
      else agent.inject(message)
    } catch (error) {
      this.ctx.logger('interactive-terminals').warn(error)
    }
  }

  private cancel(controller: Controller): void {
    controller.operation?.abort.abort(new Error('terminal human cancelled'))
  }

  private disconnected(connection: Connection): void {
    const controller = connection.controller
    if (!controller || controller.socket !== connection) return
    controller.socket = undefined
    if (controller.recovering || this.stopped) return
    controller.timer = setTimeout(() => { this.track(this.recover(controller)) }, this.config.disconnectGraceMs)
  }

  private async recover(controller: Controller): Promise<void> {
    clearTimeout(controller.timer)
    controller.timer = undefined
    controller.recovering = true
    controller.proof = ''
    this.cancel(controller)
    await controller.operation?.done
    if (this.controllers.get(controller.agent) === controller) this.controllers.delete(controller.agent)
  }

  private async revoke(agent: Agent, code: 4001 | 4002): Promise<void> {
    if (code === 4002) this.disposedOwners.add(agent)
    this.epochs.set(agent, (this.epochs.get(agent) ?? 0) + 1)
    for (const [key, token] of this.tokens) if (token.agent === agent) this.tokens.delete(key)
    this.schedulePrune()
    const controller = this.controllers.get(agent)
    const recovery = controller ? this.recover(controller) : Promise.resolve()
    this.track(recovery)
    const connections = [...this.connections].filter(connection => connection.token.agent === agent)
    for (const connection of connections) this.close(connection, code, code === 4001 ? 'terminal-reset' : 'terminal-disposed')
    await Promise.all([recovery, ...connections.map(connection => connection.closed)])
    this.ctx.emit('interactive-terminal/ownership')
  }

  private status(connection: Connection): void {
    if (!connection.attachment) return
    const { status, queueStatus, holder, takeoverId, pendingCount } = connection.attachment.read()
    this.send(connection, { type: 'terminal.status', status, queueStatus, holder, takeoverId, pendingCount })
  }

  private error(connection: Connection): void {
    this.send(connection, { type: 'terminal.error', code: 'operation-failed', message: 'Terminal operation failed; check terminal status before retrying.' })
  }

  private send(connection: Connection, frame: ServerPayload): void {
    if (connection.socket.readyState !== WebSocket.OPEN || !connection.attachment) return
    const encoded = JSON.stringify({ ...frame, version: 1, generation: connection.attachment.generation })
    // One encoded replay (viewport and JSON escaping included) plus the configured live backlog.
    if (frame.type === 'terminal.snapshot') connection.bufferLimit = Buffer.byteLength(encoded) + this.config.scrollbackMaxBytes
    if (connection.socket.bufferedAmount + Buffer.byteLength(encoded) > connection.bufferLimit) { this.close(connection, 1013, 'terminal-slow-consumer'); return }
    connection.socket.send(encoded)
  }

  private close(connection: Connection, code: number, reason: string): void {
    connection.unsubscribe?.()
    if (connection.socket.readyState === WebSocket.CLOSED || connection.closing) return
    connection.socket.close(code, reason)
    connection.closing = setTimeout(() => connection.socket.terminate(), this.config.disposeGraceMs)
  }

  private track(work: Promise<void>): void {
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(error => this.ctx.logger('interactive-terminals').warn(error))
  }
}

type ServerPayload = ServerFrame extends infer Frame ? Frame extends ServerFrame ? Omit<Frame, 'version' | 'generation'> : never : never

function sameOrigin(request: IncomingMessage): boolean {
  if (!request.headers.origin || !request.headers.host) return false
  try {
    const origin = new URL(request.headers.origin)
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && origin.host === request.headers.host && origin.username === '' && origin.password === '' && origin.pathname === '/' && !origin.search && !origin.hash
  } catch { return false }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) }

function parseFrame(raw: string, generation: number, maxInputBytes: number): ClientFrame {
  const frame: unknown = JSON.parse(raw)
  if (!object(frame) || frame.version !== 1 || frame.generation !== generation) throw new Error('invalid frame')
  const keys = ['version', 'generation', 'type']
  switch (frame.type) {
    case 'human.begin':
    case 'human.input':
      if (!only(frame, [...keys, 'input']) || typeof frame.input !== 'string' || !frame.input.isWellFormed() || Buffer.byteLength(frame.input) > maxInputBytes) throw new Error('invalid input')
      return { version: 1, generation, type: frame.type, input: frame.input }
    case 'human.takeover':
      if (!only(frame, [...keys, 'target']) || typeof frame.target !== 'string' || !/^[1-9]\d*$/.test(frame.target)) throw new Error('invalid takeover target')
      return { version: 1, generation, type: frame.type, target: frame.target as Extract<ClientFrame, { type: 'human.takeover' }>['target'] }
    case 'terminal.reset':
      if (!only(frame, [...keys, 'confirmed']) || frame.confirmed !== true) throw new Error('unconfirmed reset')
      return { version: 1, generation, type: frame.type, confirmed: true }
    case 'human.cancel':
    case 'heartbeat':
      if (!only(frame, keys)) throw new Error('unknown fields')
      return { version: 1, generation, type: frame.type }
    default: throw new Error('unknown frame')
  }
}

export default TerminalTransport

declare module '@deepseek-ai/cordis' {
  interface Context { interactiveTerminalTransport: TerminalTransport }
}
