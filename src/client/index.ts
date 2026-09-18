/// <reference path="./css.d.ts" preserve="true" />
/** Additive browser terminal contribution; all resources follow the client fiber. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import './platform.ts'
import { TerminalOverlay } from './TerminalOverlay.tsx'
import { createTerminalClientTransport } from './protocol.ts'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

/** Services required by the browser plugin. */
export const inject = ['slots', 'connection']

/** Register the session-scoped dock and effect-owned renderer/socket lifetime. */
export function apply(ctx: ClientContext): void {
  const transport = createTerminalClientTransport(ctx.connection)
  ctx.effect(() => () => transport.dispose())
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-interactive-terminal', order: 100,
    inject: () => ({ transport, mobile: window.matchMedia('(pointer: coarse)').matches }),
  }, TerminalOverlay))
}
