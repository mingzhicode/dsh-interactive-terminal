import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessHandle, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { vi } from 'vitest'
import { InteractiveTerminalService } from '../../src/service.ts'
import { DEFAULT_CONFIG, type Config } from '../../src/config.ts'
import { fakeOwner, fakeTerminalHandle } from './fake-subprocess.ts'

const agentDisposers = new WeakMap<Agent, () => Promise<void>>()

export class FakeSubprocess extends SubprocessRuntime {
  readonly handles: ReturnType<typeof fakeTerminalHandle>[] = []
  override spawnTerminal = vi.fn(async (spec: SubprocessTerminalSpawnSpec) => {
    const handle = fakeTerminalHandle()
    this.handles.push(handle)
    return fakeOwner({ handle }).subprocess.spawnTerminal(spec)
  })
  override async resolveExecutable(command: string): Promise<string> { return command }
  override spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('pipe spawn is not used') }
}

/** Real Cordis lifecycle, Session and Agent registry with a public PTY fake. */
export function serviceContext() {
  const ctx = new Context()
  new SessionStore(ctx)
  new AgentRegistry(ctx)
  new SandboxPolicyService(ctx, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
  const subprocess = new FakeSubprocess(ctx)
  return { ctx, subprocess }
}

/** Agent implements the full public interface; its scope participates in real teardown. */
export function fakeAgent(id: string, ctx: Context = serviceContext().ctx, parent?: Agent): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const agent = {
    id: session.id, session, options: {}, ctx, status: 'idle',
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    cancel() {}, send() {}, followup() {}, steer() {}, inject() {},
    whenIdle: async () => undefined,
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) { return task(new AbortController().signal) },
  } satisfies Agent
  const scope = createScope(ctx, agent, parent ? { parent } : undefined)
  agent.ctx = scope.ctx
  agentDisposers.set(agent, () => scope.dispose())
  agent.ctx.agents.register(agent)
  return agent
}

/** Await scope-owned cleanup and registry removal through the real Cordis lifetime. */
export function disposeFakeAgent(agent: Agent): Promise<void> { return agentDisposers.get(agent)!() }

/** Construct the service with completely resolved deployment settings. */
export function makeService(overrides: Partial<Config> = {}, ctx = serviceContext().ctx): InteractiveTerminalService {
  return new InteractiveTerminalService(ctx, { ...DEFAULT_CONFIG, ...overrides })
}
