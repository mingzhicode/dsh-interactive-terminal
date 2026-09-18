import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type { SubprocessOutcome, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { TerminalOwner } from '../../src/terminal.ts'
import { TerminalScreen } from '../../src/screen.ts'
import { deferred } from './fake-clock.ts'

/** Controllable implementation of the published terminal handle. */
export function fakeTerminalHandle() {
  const output = new PassThrough()
  const exit = deferred<SubprocessOutcome>()
  const pid = 123
  let foreground: SubprocessTerminalForeground | undefined = { processGroupId: 456, inputWaiting: false }
  const inspectForeground = vi.fn(async () => foreground)
  const deliverSignal = vi.fn((_processGroupId: number, _signal: SubprocessTerminalSignal) => undefined)
  const handle = {
    pid,
    output,
    done: exit.promise,
    write: vi.fn(async (_data: string) => undefined),
    inspectForeground,
    signalForeground: vi.fn(async (signal: SubprocessTerminalSignal) => {
      const current = await inspectForeground()
      if (!current) throw new Error('cannot resolve foreground process group')
      if (signal === 'SIGKILL' && current.processGroupId === pid) throw new Error('refusing to SIGKILL the terminal shell')
      deliverSignal(current.processGroupId, signal)
      return current.processGroupId
    }),
    deliverSignal,
    setForeground(value: SubprocessTerminalForeground | undefined) { foreground = value },
    terminate: vi.fn(async () => { output.end(); exit.resolve({ exitCode: null, signal: 'SIGTERM' }) }),
    exit(outcome: SubprocessOutcome = { exitCode: 0, signal: null }) { output.end(); exit.resolve(outcome) },
  } satisfies SubprocessTerminalHandle & { exit(outcome?: SubprocessOutcome): void; setForeground(value: SubprocessTerminalForeground | undefined): void; deliverSignal: typeof deliverSignal }
  return handle
}

export interface FakeOwnerOptions {
  handle?: SubprocessTerminalHandle
  spawnTerminal?: (spec: SubprocessTerminalSpawnSpec) => Promise<SubprocessTerminalHandle>
  confined?: boolean
  prompt?: boolean
  failScreen?: boolean
}

/** Owner with public services, keeping policy and spawning independently observable. */
export function fakeOwner(options: FakeOwnerOptions = {}): TerminalOwner {
  if (options.failScreen) vi.spyOn(TerminalScreen.prototype, 'write').mockRejectedValueOnce(new Error('screen failed'))
  // The policy fake only reads identity; no Session implementation is exercised here.
  const session = { id: 'test-session' } as TerminalOwner['session']
  return {
    session,
    sandboxPolicy: { resolve: vi.fn<TerminalOwner['sandboxPolicy']['resolve']>(() => ({ mode: options.confined ? 'workspace-write' : 'danger-full-access', workspaceRoot: '/workspace', sessionId: session.id })) },
    sandbox: { confine: vi.fn<NonNullable<TerminalOwner['sandbox']>['confine']>(argv => ({ argv: ['sandbox-runner', ...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })) },
    subprocess: {
      spawnTerminal: vi.fn(async spec => {
        const handle = await (options.spawnTerminal?.(spec) ?? options.handle ?? fakeTerminalHandle())
        if (options.prompt !== false) {
          const nonce = /133;D;([^;]+);/.exec(spec.env!.PROMPT_COMMAND!)![1]
          ;(handle.output as PassThrough).write(`\x1b]133;D;${nonce};0\x07dsh$ `)
        }
        return handle
      }),
    },
  }
}
