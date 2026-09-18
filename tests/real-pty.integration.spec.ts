import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxUnavailableError, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as interactiveTerminal from '../src/index.ts'
import { DEFAULT_CONFIG, type Config } from '../src/config.ts'
import { fakeAgent, disposeFakeAgent } from './fixtures/fake-agent.ts'
import type { TerminalGeneration } from '../src/terminal.ts'

/** Native-provider fixture exposed through Agent-bound operations. */
export interface RealPtyHarness {
  send(agentId: string, request: { text: string; submit: boolean }): Promise<{ output: string }>
  reset(agentId: string): Promise<void>
  generation(agentId: string): number
  dispose(): Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function startHarnessFixture(options: { config?: Partial<Config>; mode?: SandboxMode; sandbox?: boolean } = {}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-iterm-native-')))
  const ctx = new Context()
  const handles: Array<{ handle: SubprocessTerminalHandle; done: boolean; terminated: boolean; signals: string[] }> = []
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    try {
      await ctx.fiber.dispose()
      await Promise.all(handles.map(entry => entry.handle.done))
      expect(handles.every(entry => entry.done && entry.terminated)).toBe(true)
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })()
  cleanups.push(dispose)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: options.mode ?? 'danger-full-access', workspaceRoot: workspace })
  if (options.sandbox) await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(LocalSubprocessRuntime)
  const spawn = ctx.subprocess.spawnTerminal.bind(ctx.subprocess)
  ctx.subprocess.spawnTerminal = async spec => {
    const handle = await spawn(spec)
    const entry = { handle, done: false, terminated: false, signals: [] as string[] }
    handles.push(entry)
    void handle.done.then(() => { entry.done = true }, () => undefined)
    const terminate = handle.terminate.bind(handle)
    handle.terminate = async () => { await terminate(); entry.terminated = true }
    const signalForeground = handle.signalForeground.bind(handle)
    handle.signalForeground = async signal => { entry.signals.push(signal); return signalForeground(signal) }
    return handle
  }
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ inject: ['webServer'], apply: scope => { new HostConnectionService(scope, []) } })
  await ctx.plugin(interactiveTerminal, { ...DEFAULT_CONFIG, operationTimeoutMs: 10000, disposeGraceMs: 500, pollIntervalMs: 100, ...options.config })
  let agentContext!: Context
  await ctx.plugin({ inject: ['agents', 'sessions', 'subprocess', 'sandboxPolicy', ...(options.sandbox ? ['sandbox'] : [])], apply: scope => { agentContext = scope } })
  const service = ctx.interactiveTerminals
  const agents = new Map<string, Agent>()
  const agent = (id: string) => {
    let owner = agents.get(id)
    if (!owner) { owner = fakeAgent(id, agentContext); agents.set(id, owner) }
    return owner
  }
  await agent('a').ctx.fiber
  await agent('b').ctx.fiber
  expect(ctx.agents.get(agent('a').id) === agent('a')).toBe(true)
  const fixture = {
    ctx, service, agent, handles, workspace,
    send: (id: string, request: { text: string; submit: boolean }) => service.send(agent(id), request),
    reset: async (id: string) => { await service.reset(agent(id)) },
    generation: (id: string) => service.ownership().find(record => record.owner === agent(id))?.generations[0] ?? 0,
    dispose,
  } satisfies RealPtyHarness & Record<string, unknown>
  return fixture
}

/** Observe rendered native output without relying on terminal echo or timed sleeps. */
function waitForText(terminal: TerminalGeneration, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`missing native output: ${text}`)) }, 10000)
    const check = () => {
      const current = terminal.text()
      if (![...current.history, current.viewport].join('\n').includes(text)) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const unsubscribe = terminal.subscribe(check)
    check()
  })
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Only documented backend unavailability can skip a confined startup. */
async function requireConfinedStartup(start: () => Promise<unknown>, skip: (reason: string) => never): Promise<void> {
  try { await start() } catch (error) {
    if (error instanceof SandboxUnavailableError) skip(`${error.code}: ${error.message}`)
    throw error
  }
}

describe('native confinement availability', () => {
  it('skips the documented unavailable backend and propagates unrelated startup errors', async () => {
    const skipped = new Error('test skip sentinel')
    let reason: string | undefined
    const skip = (message: string): never => { reason = message; throw skipped }
    const unavailable = new SandboxUnavailableError('workspace-write', 'no usable test backend')
    await expect(requireConfinedStartup(() => Promise.reject(unavailable), skip)).rejects.toBe(skipped)
    expect(reason).toContain('SANDBOX_UNAVAILABLE')
    reason = undefined
    const other = new Error('SANDBOX_UNAVAILABLE appears only in arbitrary text')
    await expect(requireConfinedStartup(() => Promise.reject(other), skip)).rejects.toBe(other)
    expect(reason).toBeUndefined()
    await requireConfinedStartup(() => Promise.resolve(), skip)
    expect(reason).toBeUndefined()
  })
})

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('real PTY integration', { timeout: 20000 }, () => {
  it('attributes the complete multiline model submission before granting its follower', async () => {
    const app = await startHarnessFixture()
    const first = app.send('a', { text: "printf 'MULTILINE_%s\\n' ONE\nsleep 0.2; printf 'MULTILINE_%s\\n' TWO", submit: true })
    const follower = app.send('a', { text: "printf 'MULTILINE_%s\\n' FOLLOWER", submit: true })
    const [firstResult, followerResult] = await Promise.all([first, follower])
    expect(firstResult.output).toContain('MULTILINE_TWO')
    expect(firstResult.output).not.toContain('MULTILINE_FOLLOWER')
    expect(followerResult.output).toContain('MULTILINE_FOLLOWER')
    expect(followerResult.output).not.toContain('MULTILINE_TWO')
  })

  it('retains human multiline paste ownership through the final command', async () => {
    const app = await startHarnessFixture()
    const attachment = await app.service.attach(app.agent('a'))
    const human = await attachment.begin("printf 'PASTE_%s\\n' ONE\nsleep 0.2; printf 'PASTE_%s\\n' TWO\r")
    const follower = app.send('a', { text: "printf 'PASTE_%s\\n' FOLLOWER", submit: true })
    const done = await human.done
    expect([...done.text.history, done.text.viewport].join('\n')).toContain('PASTE_TWO')
    expect((await follower).output).not.toContain('PASTE_TWO')
  })

  it('preserves an accepted reset across predecessor natural exit before its follower', async () => {
    const app = await startHarnessFixture()
    await app.service.ensure(app.agent('a'))
    const exiting = app.send('a', { text: 'sleep 0.2; exit 7', submit: true })
    const resetting = app.service.reset(app.agent('a'))
    const follower = app.send('a', { text: "printf 'RESET_%s\\n' FOLLOWER", submit: true })
    const [exitResult, resetResult, followerResult] = await Promise.all([exiting, resetting, follower])
    expect(exitResult).toMatchObject({ generation: 1, waitReason: 'session_exit', status: { kind: 'exited', exitCode: 7 } })
    expect(resetResult).toMatchObject({ generation: 2, waitReason: 'prompt' })
    expect(followerResult).toMatchObject({ generation: 2, waitReason: 'prompt' })
    expect(followerResult.output).toContain('RESET_FOLLOWER')
    expect(app.handles).toHaveLength(2)
  })

  it('persists shell state for one Agent and isolates another Agent', async () => {
    const app = await startHarnessFixture()
    try {
      await app.send('a', { text: 'mkdir child; cd child; export DSH_ITERM_VALUE=alpha', submit: true })
      expect((await app.send('a', { text: 'printf %s "$DSH_ITERM_VALUE"', submit: true })).output).toContain('alpha')
      expect((await app.send('a', { text: 'pwd', submit: true })).output).toContain(join(app.workspace, 'child'))
      expect((await app.send('b', { text: 'printf "ISOLATED_%s\\n" "${DSH_ITERM_VALUE-unset}"; pwd', submit: true })).output).toContain(`ISOLATED_unset\n${app.workspace}`)
      await expect(app.service.ensure({ ...app.agent('a') })).rejects.toThrow()
    } finally { await app.dispose() }
  })

  it('keeps geometry fixed and replaces only on reset', async () => {
    const app = await startHarnessFixture()
    try {
      expect((await app.send('a', { text: 'printf "%sx%s" "$LINES" "$COLUMNS"', submit: true })).output).toContain('40x160')
      const before = app.generation('a')
      expect((await app.send('a', { text: 'stty size', submit: true })).output).toContain('40 160')
      expect((await app.service.attach(app.agent('a'))).read().snapshot).toMatchObject({ rows: 40, cols: 160 })
      expect(app.generation('a')).toBe(before)
      await app.reset('a')
      expect(app.generation('a')).toBe(before + 1)
      expect(app.handles[0]).toMatchObject({ done: true, terminated: true })
      expect(app.handles[1]).toMatchObject({ done: false, terminated: false })
      expect((await app.send('a', { text: 'stty size', submit: true })).output).toContain('40 160')
    } finally { await app.dispose() }
  })

  it.runIf(process.platform === 'linux')('recognizes a real foreground stdin read and returns to the controlled prompt', async () => {
    const app = await startHarnessFixture()
    const first = await app.send('a', { text: `/bin/bash -c 'read -r value; printf "CHILD_%s\\n" "$value"'`, submit: true })
    expect(first.waitReason).toBe('stdin_read')
    const second = await app.send('a', { text: 'accepted', submit: true })
    expect(second.waitReason).toBe('prompt')
    expect(second.output).toContain('CHILD_accepted')
  })

  it('retains human ownership across REPL Enter and admits later mutations in FIFO order', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const { terminal } = await app.service.ensure(agent)
    const attachment = await app.service.attach(agent)
    const human = await attachment.begin(`/bin/bash -c 'printf "REPL_%s\\n" READY; while IFS= read -r line; do printf "ECHO_%s\\n" "$line"; done'\r`)
    await waitForText(terminal, 'REPL_READY')
    const first = app.send('a', { text: 'printf "QUEUE_%s\\n" FIRST', submit: true })
    const second = app.send('a', { text: 'printf "QUEUE_%s\\n" SECOND', submit: true })
    await human.input('hello\r')
    await waitForText(terminal, 'ECHO_hello')
    expect(attachment.read()).toMatchObject({ holder: 'human', pendingCount: 2 })
    expect(terminal.text().viewport).not.toContain('QUEUE_FIRST')
    await human.input('\u0004')
    expect((await human.done).waitReason).toBe('prompt')
    expect((await first).output).toContain('QUEUE_FIRST')
    expect((await second).output).toContain('QUEUE_SECOND')
    const text = [...terminal.text().history, terminal.text().viewport].join('\n')
    expect(text.indexOf('QUEUE_FIRST')).toBeLessThan(text.indexOf('QUEUE_SECOND'))
  })

  it('hands a delayed local child to a human in place before granting its follower', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const record = await app.service.ensure(agent)
    const script = 'process.stdout.write("HANDOFF_YN?\\n"); setTimeout(() => { process.stdin.once("data", data => { process.stdout.write(`HANDOFF_ANSWER_${data.toString().trim()}\\n`); process.stdin.pause() }); process.stdin.resume() }, 500)'
    const model = app.service.send(agent, { text: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`, submit: true })
    await waitForText(record.terminal, 'HANDOFF_YN?')
    const attachment = await app.service.attach(agent)
    const target = attachment.read().takeoverId
    expect(target).not.toBeNull()
    const follower = app.send('a', { text: 'printf "HANDOFF_%s\\n" FOLLOWER', submit: true })

    const human = await attachment.takeover(target!)
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff', generation: record.generation, holder: 'human', pendingCount: 1 })
    await human.input('Y\r')
    await waitForText(record.terminal, 'HANDOFF_ANSWER_Y')
    await expect(human.done).resolves.toMatchObject({ waitReason: 'prompt' })
    await expect(follower).resolves.toMatchObject({ output: expect.stringContaining('HANDOFF_FOLLOWER'), generation: record.generation })
    expect((await app.service.ensure(agent)).terminal).toBe(record.terminal)
    expect(app.handles[0]!.signals).toEqual([])
  })

  it('does not write a takeover answer after the original native prompt is authoritative', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const record = await app.service.ensure(agent)
    const captureObservation = record.terminal.queue.captureObservation.bind(record.terminal.queue)
    let releasePrompt: (() => void) | undefined
    record.terminal.queue.captureObservation = () => {
      const observe = captureObservation()
      return observation => {
        if (observation === 'prompt') releasePrompt = () => observe(observation)
        else observe(observation)
      }
    }
    const model = app.service.send(agent, { text: 'printf "HANDOFF_RACE_%s\\n" READY', submit: true })
    await waitForText(record.terminal, 'HANDOFF_RACE_READY')
    await vi.waitFor(() => expect(releasePrompt).toBeTypeOf('function'))
    const attachment = await app.service.attach(agent)
    const human = await attachment.takeover(attachment.read().takeoverId!)
    const follower = app.send('a', { text: 'printf "HANDOFF_RACE_%s\\n" FOLLOWER', submit: true })
    const answer = human.input('STALE_ANSWER\r')
    record.terminal.queue.captureObservation = captureObservation

    releasePrompt!()

    await expect(answer).rejects.toThrow('closed')
    await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
    await expect(human.done).resolves.toMatchObject({ waitReason: 'prompt' })
    await expect(follower).resolves.toMatchObject({ output: expect.stringContaining('HANDOFF_RACE_FOLLOWER') })
    const text = [...record.terminal.text().history, record.terminal.text().viewport].join('\n')
    expect(text).not.toContain('STALE_ANSWER')
    expect(app.handles[0]!.signals).toEqual([])
  })

  it('refuses top-shell SIGKILL in both layers and kills an actual foreground child', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const { terminal } = await app.service.ensure(agent)
    const handle = app.handles[0]!.handle
    await expect(terminal.signalForeground('SIGKILL')).rejects.toThrow('top-level shell')
    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow('terminate the terminal session')
    const human = await (await app.service.attach(agent)).begin(`/bin/bash -c 'printf "KILL_%s\\n" READY; read -r value'\r`)
    await waitForText(terminal, 'KILL_READY')
    const group = await terminal.signalForeground('SIGKILL')
    expect(group).not.toBe(handle.pid)
    expect((await human.done).waitReason).toBe('prompt')
    expect(terminal.status()).toEqual({ kind: 'running' })
  })

  it.runIf(process.platform === 'linux')('delivers a queued service signal after native stdin readiness yields ownership', async () => {
    const app = await startHarnessFixture()
    expect((await app.send('a', { text: `/bin/bash -c 'read -r value'`, submit: true })).waitReason).toBe('stdin_read')
    const result = await app.service.signal(app.agent('a'), { signal: 'SIGKILL' })
    expect(result.processGroupId).not.toBe(app.handles[0]!.handle.pid)
    expect(result.waitReason).toBe('prompt')
    expect(result.status).toEqual({ kind: 'running' })
  })

  it('recovers cancellation of a live command before granting a queued follower', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const { terminal } = await app.service.ensure(agent)
    const controller = new AbortController()
    const operation = app.service.send(agent, { text: `/bin/bash -c 'printf "CANCEL_%s\\n" READY; exec sleep 60'`, submit: true }, controller.signal)
    await waitForText(terminal, 'CANCEL_READY')
    const follower = app.send('a', { text: 'printf "AFTER_%s\\n" CANCEL', submit: true })
    controller.abort()
    expect((await operation).waitReason).toBe('cancelled')
    expect((await follower).output).toContain('AFTER_CANCEL')
  })

  it('recovers an operation timeout through native SIGINT', async () => {
    const app = await startHarnessFixture({ config: { operationTimeoutMs: 1000 } })
    const result = await app.send('a', { text: 'sleep 60', submit: true })
    expect(result.waitReason).toBe('timeout')
    expect(result.queueStatus).toBe('ready')
    expect((await app.send('a', { text: 'printf "AFTER_%s\\n" TIMEOUT', submit: true })).output).toContain('AFTER_TIMEOUT')
  })

  it.runIf(process.platform === 'darwin')('reports the rc.8 macOS stdin-observation limit and recovers the blocked read', async () => {
    const app = await startHarnessFixture({ config: { operationTimeoutMs: 1000 } })
    const { terminal } = await app.service.ensure(app.agent('a'))
    const operation = app.send('a', { text: `/bin/bash -c 'printf "READ_%s\\n" READY; read -r value'`, submit: true })
    await waitForText(terminal, 'READ_READY')
    expect(await app.handles[0]!.handle.inspectForeground()).toMatchObject({ inputWaiting: false })
    expect((await operation).waitReason).toBe('timeout')
    expect((await app.send('a', { text: 'printf "READ_%s\\n" RECOVERED', submit: true })).output).toContain('READ_RECOVERED')
  })

  it('retains a naturally exited shell until explicit reset and joins its child tree', async () => {
    const app = await startHarnessFixture()
    const agent = app.agent('a')
    const { terminal } = await app.service.ensure(agent)
    await app.send('a', { text: 'sleep 60 &', submit: true })
    await app.handles[0]!.handle.inspectForeground()
    const result = await app.send('a', { text: 'disown; exit 7', submit: true })
    expect(result.waitReason).toBe('session_exit')
    expect(await terminal.done).toEqual({ exitCode: 7, signal: null })
    const retained = await app.service.read(agent, { offset: 0, count: 10 })
    expect(retained.status).toMatchObject({ kind: 'exited', exitCode: 7 })
    expect((await app.service.ensure(agent)).terminal).toBe(terminal)
    await expect(app.send('a', { text: 'echo invalid', submit: true })).rejects.toThrow(/exited|disposed/)
    await app.reset('a')
    expect(app.handles[0]).toMatchObject({ done: true, terminated: true })
    expect(app.generation('a')).toBe(2)
  })

  it('joins exact-Agent teardown and preserves the sibling shell', async () => {
    const app = await startHarnessFixture()
    const left = app.agent('a')
    const right = app.agent('b')
    const leftRecord = await app.service.ensure(left)
    await app.service.ensure(right)
    const operation = app.service.send(left, { text: `/bin/bash -c 'printf "DISPOSE_%s\\n" READY; exec sleep 60'`, submit: true })
    await waitForText(leftRecord.terminal, 'DISPOSE_READY')
    await disposeFakeAgent(left)
    expect((await operation).waitReason).toBe('cancelled')
    await leftRecord.terminal.done
    expect(app.handles[0]).toMatchObject({ done: true, terminated: true })
    expect(app.handles[1]).toMatchObject({ done: false, terminated: false })
    expect((await app.send('b', { text: 'printf "SIBLING_%s\\n" ALIVE', submit: true })).output).toContain('SIBLING_ALIVE')
    const rightRecord = await app.service.ensure(right)
    const human = await (await app.service.attach(right)).begin(`/bin/bash -c 'printf "APP_%s\\n" READY; exec sleep 60'\r`)
    await waitForText(rightRecord.terminal, 'APP_READY')
    await app.dispose()
    expect((await human.done).waitReason).toBe('cancelled')
    await rightRecord.terminal.done
    expect(app.service.size).toBe(0)
  })

  it('fails confined allocation closed without a sandbox provider', async () => {
    const app = await startHarnessFixture({ mode: 'workspace-write' })
    await expect(app.send('a', { text: 'echo forbidden', submit: true })).rejects.toThrow('sandbox unavailable')
    expect(app.handles).toHaveLength(0)
    expect(app.service.size).toBe(0)
  })

  it('enforces workspace writes with the actual local sandbox provider', async ({ skip }) => {
    const app = await startHarnessFixture({ mode: 'workspace-write', sandbox: true })
    await requireConfinedStartup(() => app.service.ensure(app.agent('a')), skip)
    // The public workspace-write policy also permits the platform temp root.
    const outside = await realpath(await mkdtemp(join(homedir(), '.dsh-iterm-denied-')))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const allowed = join(app.workspace, 'allowed')
    const denied = join(outside, 'denied')
    const result = await app.send('a', { text: `printf allowed > allowed; printf denied > ${shellQuote(denied)}`, submit: true })
    expect(result.waitReason).toBe('prompt')
    expect(await readFile(allowed, 'utf8')).toBe('allowed')
    await expect(access(denied)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.output).toMatch(/Operation not permitted|Permission denied|Read-only file system/)
  })

  it.runIf(process.env.DSH_TERMINAL_QUERY_DIAGNOSTIC === '1')('diagnoses cursor-query replies without a browser', async () => {
    const app = await startHarnessFixture()
    const result = await app.send('a', { text: `printf '\\033[6n'; read -rsn 1 -t 1 reply; printf 'QUERY_REPLY_BYTES_%s\\n' "\${#reply}"`, submit: true })
    console.info('cursor-query diagnostic:', result.output)
    expect(result.output).toContain('QUERY_REPLY_BYTES_0')
    expect(result.waitReason).toBe('prompt')
  })
})
