/** Session-view input ownership, authoritative replay, and xterm lifetime. */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ClientAttachment, ClientFrame, ClientTerminalState, ClientTransport, ServerFrame } from './protocol.ts'

type ClientPayload = ClientFrame extends infer Frame ? Frame extends ClientFrame ? Omit<Frame, 'version' | 'generation'> : never : never

interface ViewState extends ClientTerminalState {
  lease: 'none' | 'queued' | 'taking-over' | 'granted'
  queuePosition: number | null
  queueDepth: number
  status: string
  notice: string
  canInput: boolean
  canTakeover: boolean
  canReset: boolean
  takeoverId: Extract<ServerFrame, { type: 'terminal.status' }>['takeoverId']
}
const initial: ViewState = { mode: 'readonly', connection: 'collapsed', sequence: -1, pendingInput: '', lease: 'none', queuePosition: null, queueDepth: 0, status: '', notice: '', canInput: false, canTakeover: false, canReset: false, takeoverId: null }
type Command = 'takeover' | 'end' | 'reset' | 'retry' | 'clear' | 'larger' | 'smaller'

/** Keep renderer replies out of human input without muting pending output writes. */
function listenForHumanInput(terminal: Terminal, input: (data: string) => void): { dispose(): void } {
  let parserTask = false
  let focusDispatch = false
  // xterm 6.0.0's built-in parser handlers are synchronous. These families emit
  // device/status/color/window replies, including focus reports from DECSET 1004.
  const parsingReply = () => {
    parserTask = true
    queueMicrotask(() => { parserTask = false })
    return false
  }
  const handlers = [
    ...[
      { final: 'c' }, { prefix: '>', final: 'c' },
      { final: 'n' }, { prefix: '?', final: 'n' },
      { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
      { final: 't' }, { prefix: '?', final: 'h' },
    ].map(id => terminal.parser.registerCsiHandler(id, parsingReply)),
    terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, parsingReply),
    ...[4, 10, 11, 12].map(id => terminal.parser.registerOscHandler(id, parsingReply)),
    terminal.onData(data => { if (!parserTask && !focusDispatch) input(data) }),
  ]
  const textarea = terminal.textarea!
  const beforeFocus = () => { focusDispatch = true }
  const afterFocus = () => { focusDispatch = false }
  for (const event of ['focus', 'blur']) {
    textarea.addEventListener(event, beforeFocus, true)
    textarea.addEventListener(event, afterFocus)
  }
  return { dispose() {
    for (const handler of handlers) handler.dispose()
    for (const event of ['focus', 'blur']) {
      textarea.removeEventListener(event, beforeFocus, true)
      textarea.removeEventListener(event, afterFocus)
    }
  } }
}

/** Own one mounted view; collapse hides it without disconnecting its PTY. */
export function useTerminal(sessionId: string, transport: ClientTransport, mobile: boolean, active: boolean) {
  const container = useRef<HTMLDivElement>(null)
  const [state, setState] = useState(initial)
  const command = useRef<(command: Command) => void>(() => {})

  useEffect(() => {
    if (!active || !container.current) return
    let live = true
    let attempt = 0
    let view = { ...initial, connection: 'connecting' as ClientTerminalState['connection'] }
    let terminal: Terminal | undefined
    let inputDisposer: { dispose(): void } | undefined
    let attachment: ClientAttachment | undefined
    let resume: string | undefined
    let generation: number | undefined
    let bytes = 0
    let maxBytes = 0
    let inputBlocked = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let idleReady = false
    let attached = false
    let awaitingInitialStatus = true
    let leaseRestored = false
    let outputFailed = false
    const publish = () => {
      if (!live) return
      const controller = attached && !mobile && view.mode === 'controller' && view.connection === 'connected'
      view = {
        ...view,
        canInput: controller && !inputBlocked && (view.lease === 'granted' || view.lease === 'queued' || (view.lease === 'none' && idleReady)),
        canTakeover: controller && !inputBlocked && view.lease === 'none' && view.takeoverId !== null,
        canReset: controller,
      }
      if (terminal) terminal.options.disableStdin = !(attached && !mobile && view.mode === 'controller' && view.connection === 'connected')
      setState(view)
    }
    const discardInput = () => {
      if (view.pendingInput) view.notice = 'Unsent input discarded.'
      view.pendingInput = ''; view.lease = 'none'; view.queuePosition = null; bytes = 0; inputBlocked = false
    }
    const send = (frame: ClientPayload) => {
      if (generation === undefined) return false
      try { attachment!.send({ ...frame, version: 1, generation } as ClientFrame); return true }
      catch { disconnect(1006); return false }
    }
    const type = (input: string) => {
      if (!view.canInput || input.length === 0) {
        if (input.length > 0 && view.takeoverId !== null) { view.notice = 'Take over input before answering this operation.'; publish() }
        return
      }
      if (!input.isWellFormed() || bytes + new TextEncoder().encode(input).byteLength > maxBytes) {
        inputBlocked = true; view.notice = 'Input limit reached or invalid text. Interrupt input to recover.'; publish(); return
      }
      bytes += new TextEncoder().encode(input).byteLength
      if (view.lease === 'none') {
        view.lease = 'queued'
        send({ type: 'human.begin', input })
      } else if (view.lease === 'queued') view.pendingInput += input
      else send({ type: 'human.input', input })
      publish()
    }
    const connect = () => {
      if (!live) return
      clearTimeout(retryTimer)
      const current = ++attempt
      attachment?.dispose()
      attached = false; idleReady = false; generation = undefined
      awaitingInitialStatus = true; leaseRestored = false
      if (view.lease === 'granted') view.lease = 'queued'
      view.connection = 'connecting'; publish()
      attachment = transport.attach(sessionId, { readonly: mobile, ...(resume ? { resume } : {}) }, {
        frame(frame) { if (live && current === attempt) receive(frame) },
        close(code) { if (live && current === attempt) disconnect(code) },
      })
    }
    const disconnect = (code: number) => {
      attempt += 1
      attachment?.dispose()
      attached = false; idleReady = false
      view.connection = 'disconnected'
      if ([1007, 1008, 1009].includes(code)) {
        inputBlocked = true; view.notice = 'Terminal protocol error. Reconnect explicitly after correcting input.'
      } else if (code === 4002) {
        resume = undefined; discardInput(); view.notice = 'Terminal disposed. Reconnect when available.'
      } else {
        if (code === 4001) { resume = undefined; discardInput() }
        else view.notice = 'Connection lost; sent input will not be repeated.'
        retryTimer = setTimeout(connect, 250)
      }
      publish()
    }
    const writeOutput = (output: string) => {
      // xterm owns ordered buffering and its native pending-data limit.
      try { terminal!.write(output) }
      catch {
        outputFailed = true
        disconnect(1009)
        view.notice = 'Terminal output could not be rendered. Reconnect to restore the retained screen.'
        publish()
      }
    }
    const receive = (frame: ServerFrame) => {
      if (frame.type === 'terminal.snapshot') {
        if (generation !== undefined) { disconnect(1008); return }
        generation = frame.generation
        const s = frame.snapshot
        const fontSize = terminal?.options.fontSize ?? 14
        const focused = terminal?.textarea === document.activeElement
        // reset() does not discard queued writes; a snapshot gets its own renderer.
        inputDisposer?.dispose()
        terminal?.dispose()
        terminal = new Terminal({
          cols: s.cols,
          rows: s.rows,
          scrollback: frame.scrollbackLines,
          fontSize,
          disableStdin: true,
          allowProposedApi: true,
          theme: { background: '#ffffff', foreground: '#1f2937', cursor: '#111827', selectionBackground: '#bfdbfe' },
        })
        terminal.open(container.current!)
        inputDisposer = listenForHumanInput(terminal, type)
        if (focused) terminal.focus()
        view.sequence = s.sequence
        if (s.truncated) view.notice = 'Older history was truncated by the Host.'
        writeOutput(s.replay)
        publish(); return
      }
      if (generation === undefined || frame.generation !== generation) { disconnect(1008); return }
      switch (frame.type) {
        case 'terminal.attached':
          attached = true; maxBytes = frame.maxInputBytes; view.mode = frame.mode; view.connection = 'connected'
          if (frame.mode === 'controller') resume = frame.resume
          else {
            const discarded = view.pendingInput.length > 0
            discardInput()
            if (frame.reason === 'invalid-resume') resume = undefined
            const reason = frame.reason === 'controller-busy' ? 'Another view controls input.' : frame.reason === 'invalid-resume' ? 'Input lease expired. Reconnect to request control.' : ''
            view.notice = `${discarded ? 'Unsent input discarded. ' : ''}${reason}`.trim()
          }
          break
        case 'terminal.output':
          if (frame.sequence <= view.sequence) return
          if (frame.sequence !== view.sequence + 1) { connect(); return }
          view = { ...view, sequence: frame.sequence }
          writeOutput(frame.output)
          return
        case 'terminal.status':
          if (awaitingInitialStatus && !leaseRestored && view.lease !== 'none') discardInput()
          awaitingInitialStatus = false
          idleReady = frame.status.kind === 'running' && frame.queueStatus === 'ready' && frame.holder === null && frame.pendingCount === 0
          view.takeoverId = frame.takeoverId
          view.status = frame.status.kind === 'exited'
            ? `Exited (${frame.status.exitCode ?? frame.status.signal ?? 'unknown'})`
            : frame.holder === 'model-send' ? 'model'
              : frame.holder ?? frame.queueStatus
          view.queueDepth = frame.pendingCount
          break
        case 'human.queued': leaseRestored = true; view.lease = 'queued'; view.queuePosition = frame.position; break
        case 'human.granted': {
          leaseRestored = true
          view.lease = 'granted'; view.queuePosition = null
          const pending = view.pendingInput; view.pendingInput = ''
          if (pending) send({ type: 'human.input', input: pending })
          terminal?.focus()
          break
        }
        case 'human.revoked': discardInput(); break
        case 'terminal.error': inputBlocked = true; view.notice = frame.message; break
        case 'heartbeat': break
      }
      publish()
    }
    command.current = action => {
      if (!live) return
      switch (action) {
        case 'takeover':
          if (view.canTakeover && view.takeoverId !== null) {
            const target = view.takeoverId
            view.lease = 'taking-over'; view.queuePosition = null; view.notice = ''
            send({ type: 'human.takeover', target })
          }
          break
        case 'end': if (view.lease === 'granted' && view.connection === 'connected') { send({ type: 'human.cancel' }); view.canInput = false; inputBlocked = true }; break
        case 'reset': if (view.canReset) send({ type: 'terminal.reset', confirmed: true }); break
        case 'retry':
          if (outputFailed) { outputFailed = false; view.notice = '' }
          inputBlocked = false; connect(); break
        case 'clear': terminal?.clear(); break
        case 'larger': if (terminal) terminal.options.fontSize = Math.min(28, (terminal.options.fontSize ?? 14) + 1); break
        case 'smaller': if (terminal) terminal.options.fontSize = Math.max(8, (terminal.options.fontSize ?? 14) - 1); break
      }
      publish()
    }
    const cleanup = () => {
      if (!live) return
      live = false; attempt += 1; clearTimeout(retryTimer); attachment?.dispose(); inputDisposer?.dispose(); terminal?.dispose()
      resume = undefined; view.pendingInput = ''; command.current = () => {}
    }
    const untrack = transport.track(cleanup)
    connect()
    return () => { cleanup(); untrack() }
  }, [sessionId, transport, mobile, active])

  return { state, container, act: (action: Command) => command.current(action) }
}
