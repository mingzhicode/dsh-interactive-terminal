/** Host Loader entry for the shared model/browser terminal. */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-client-connection'
import { assertSupportedHost, type Config as TerminalConfig } from './config.ts'
import { InteractiveTerminalService } from './service.ts'
import { TerminalTransport } from './transport.ts'
import { registerTerminalTools } from './tools.ts'

/** Loader plugin identity. */
export const name = 'dsh-interactive-terminal'
/** Host services used by the assembled plugin. */
export const inject = ['agents', 'subprocess', 'sandboxPolicy', 'tools', 'systemPrompt', 'connection', 'webServer']
/** Resolve deployment defaults before activation. */
export { ConfigSchema as Config } from './config.ts'
/** Public service diagnostics and Agent-bound terminal operations. */
export type { InteractiveTerminalService } from './service.ts'
/** Public transport ownership diagnostics. */
export type { TerminalTransport } from './transport.ts'

/** @param ctx - Host plugin fiber. @param config - schema-resolved deployment settings. */
export function apply(ctx: Context, config: TerminalConfig): void {
  assertSupportedHost(config)
  const service = new InteractiveTerminalService(ctx, config)
  let transport: TerminalTransport | undefined
  ctx.plugin({
    inject: ['interactiveTerminals', 'agents', 'tools', 'systemPrompt', 'connection', 'webServer'],
    apply(consumer) {
      registerTerminalTools(consumer, config)
      transport = new TerminalTransport(consumer, config)
    },
  })
  ctx.effect(() => async () => {
    // Recovery can await a provider write which only process termination releases.
    const results = await Promise.allSettled([service.dispose(), transport?.dispose()])
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'interactive terminal plugin cleanup failed')
  }, 'interactive terminal coordinated teardown')
}
