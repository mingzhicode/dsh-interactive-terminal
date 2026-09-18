/** Native collapsible panel contributed above the session composer. */
import { useId, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientTransport } from './protocol.ts'
import { useTerminal } from './use-terminal.ts'

/** The session-scoped slot supplies identity; the plugin injects transport and input policy. */
export interface TerminalOverlayProps {
  sessionId: SessionId
  transport: ClientTransport
  mobile: boolean
}

/** Keep the terminal view keyed to the public session identity. */
export function TerminalOverlay({ sessionId, transport, mobile }: TerminalOverlayProps) {
  return <SessionTerminal key={sessionId} sessionId={sessionId} transport={transport} mobile={mobile} />
}

function SessionTerminal({ sessionId, transport, mobile }: { sessionId: string; transport: ClientTransport; mobile: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [active, setActive] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const panelId = useId()
  const settingsId = useId()
  const { state, container, act } = useTerminal(sessionId, transport, mobile, active)
  return <section className="dsh-terminal" aria-label="Session terminal">
    <header className="dsh-terminal-header">
      <button className="dsh-terminal-toggle" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => { const open = !expanded; setExpanded(open); if (!open) setSettingsOpen(false); setActive(true) }}>
        <span className="dsh-terminal-chevron" aria-hidden="true">›</span>
        <span>Terminal</span>
      </button>
      <button className="dsh-terminal-settings-button" type="button" aria-label="Terminal settings" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={() => { const open = !settingsOpen; setSettingsOpen(open); if (open) { setExpanded(true); setActive(true) } }}>
        <span aria-hidden="true">⚙</span>
      </button>
    </header>
    <div id={panelId} hidden={!expanded} className="dsh-terminal-panel">
      <div className="dsh-terminal-status">
        <span>{mobile || state.mode === 'readonly' ? 'Read only' : 'Controller'}</span>
        <span role="status">{state.connection} {state.status}</span>
        {state.queuePosition !== null && <span>{state.queuePosition} ahead</span>}
        <span>{state.queueDepth} queued</span>
        <button type="button" disabled={!state.canTakeover} onClick={() => act('takeover')}>Take over input</button>
        <button type="button" disabled={state.lease !== 'granted' || state.connection !== 'connected'} onClick={() => act('end')}>Interrupt input</button>
      </div>
      <div id={settingsId} hidden={!settingsOpen} className="dsh-terminal-settings">
        <button type="button" onClick={() => act('retry')}>Reconnect</button>
        <button type="button" onClick={() => act('clear')}>Clear view</button>
        <button type="button" aria-label="Smaller terminal text" onClick={() => act('smaller')}>A−</button>
        <button type="button" aria-label="Larger terminal text" onClick={() => act('larger')}>A+</button>
        <button type="button" disabled={!state.canReset} onClick={() => setConfirm(true)}>Reset Terminal</button>
      </div>
      {confirm && <div role="alertdialog" aria-label="Reset terminal confirmation">
        <p>Reset the terminal and discard its current shell state?</p>
        <button type="button" disabled={!state.canReset} onClick={() => { setConfirm(false); act('reset') }}>Confirm reset</button>
        <button type="button" onClick={() => setConfirm(false)}>Cancel</button>
      </div>}
      {state.notice && <p role="alert">{state.notice}</p>}
      <div className="dsh-terminal-viewport" ref={container} />
    </div>
  </section>
}
