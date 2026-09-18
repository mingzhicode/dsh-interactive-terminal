/** Runtime checks of the package's exact-Agent resource ownership. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './service.ts'
import type {} from './transport.ts'

/** Companion Loader identity. */
export const name = 'dsh-interactive-terminal-invariant'
/** Registry owning the companion's installer. */
export const inject = ['invariants']

/** @param ctx - current service and transport. @param fail - package-attributed failure reporter. */
export function checkOwnership(ctx: Context, fail: InvariantFailure): void {
  const service = ctx.interactiveTerminals
  for (const row of service.ownership()) {
    if (row.generations.length > 1) fail(`Agent ${row.owner.id} owns multiple live terminal generations`)
    if (service.isDisposed(row.owner) && (row.generations.length || row.queued)) fail(`disposed Agent ${row.owner.id} retains terminal queue or process resources`)
  }
  for (const row of ctx.interactiveTerminalTransport.ownership()) {
    if (service.isDisposed(row.owner) && (row.sockets || row.pending)) fail(`disposed Agent ${row.owner.id} retains terminal sockets or queue work`)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  checkOwnership(ctx, fail)
  ctx.on('internal/dispatch', (_mode, event) => {
    if (event === 'interactive-terminal/ownership' || event === 'internal/status') checkOwnership(ctx, fail)
  }, { global: true })
}, { inject: ['interactiveTerminals', 'interactiveTerminalTransport'] })

/** @param ctx - invariant registry. @returns Registration disposer after installer setup. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('dsh-interactive-terminal', install))
