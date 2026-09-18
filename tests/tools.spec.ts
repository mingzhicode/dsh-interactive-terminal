import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolRuntime, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { boundTerminalResult, createTerminalToolDefinitions, registerTerminalTools } from '../src/tools.ts'
import { DEFAULT_CONFIG, MIN_TOOL_OUTPUT_BYTES, type Config } from '../src/config.ts'
import { fakeAgent, FakeSubprocess, makeService, serviceContext } from './fixtures/fake-agent.ts'
import { deferred } from './fixtures/fake-clock.ts'
import { fakeOwner, fakeTerminalHandle } from './fixtures/fake-subprocess.ts'

describe('shared terminal tools', () => {
  const disposers: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())) })
  function setup(overrides: Partial<Config> = {}) {
    const { ctx, subprocess } = serviceContext()
    const config = { ...DEFAULT_CONFIG, ...overrides }
    const service = makeService(config, ctx)
    new SystemPrompt(ctx, {})
    const tools = new ToolRuntime(ctx)
    const remove = registerTerminalTools(ctx, config)
    const agent = fakeAgent('tool-owner', ctx)
    disposers.push(async () => { remove(); await service.dispose() })
    let id = 0
    const execute = (name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ callId: CallId(String(++id)), name, arguments: args, agent, signal })
    return { ctx, subprocess, service, tools, agent, execute, remove }
  }

  it('defines exactly four closed tools without identity or policy selectors', () => {
    const definitions = createTerminalToolDefinitions(DEFAULT_CONFIG, setup().service)
    expect(definitions.map(tool => tool.name)).toEqual(['shared_terminal_send', 'shared_terminal_read', 'shared_terminal_signal', 'shared_terminal_reset'])
    for (const tool of definitions) {
      expect(tool.parameters.additionalProperties).toBe(false)
      expect(tool.isConcurrencySafe).toBeUndefined()
      expect(tool.presentCall?.({ sessionId: 'stale' })).toBeUndefined()
    }
    const schema = JSON.stringify(definitions.map(tool => tool.parameters))
    for (const forbidden of ['sessionId', 'ptyId', 'cwd', 'shellPath', 'env', 'sandbox']) expect(schema).not.toContain(forbidden)
    expect(definitions[0]!.presentCall?.({ text: 'echo hello' })).toMatchObject({ card: 'terminal', title: 'echo hello' })
    expect(definitions[1]!.presentCall?.({})).toMatchObject({ card: 'generic', kind: 'read' })
    expect(definitions[2]!.presentCall?.({ signal: 'SIGINT' })).toMatchObject({ card: 'generic', kind: 'execute' })
    expect(definitions[3]!.presentCall?.({})).toMatchObject({ card: 'generic', kind: 'delete' })
  })

  it('executes for an Agent whose scope does not inject terminal providers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const tools = ctx.tools
    await ctx.plugin({ inject: ['agents', 'subprocess', 'sandboxPolicy'], apply(owner) { makeService({}, owner) } })
    const service = ctx.interactiveTerminals
    registerTerminalTools(ctx, DEFAULT_CONFIG)
    disposers.push(async () => { await ctx.fiber.dispose() })
    let agent!: ReturnType<typeof fakeAgent>
    const scope = await ctx.plugin({ inject: ['agents', 'sessions'], apply(owner) { agent = fakeAgent('strict-owner', owner) } })
    disposers.push(() => scope.dispose())
    const result = await tools.execute({ callId: CallId('strict-read'), name: 'shared_terminal_read', arguments: {}, agent, signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(service.ownership().some(record => record.owner === agent)).toBe(true)
    const isolated = ctx.isolate('subprocess')
    await isolated.plugin(FakeSubprocess)
    const provider = isolated.get('subprocess') as FakeSubprocess
    let scopedAgent!: ReturnType<typeof fakeAgent>
    await isolated.plugin({ inject: ['agents', 'sessions'], apply(owner) { scopedAgent = fakeAgent('isolated-owner', owner) } })
    const scopedResult = await tools.execute({ callId: CallId('scoped-read'), name: 'shared_terminal_read', arguments: {}, agent: scopedAgent, signal: new AbortController().signal })
    expect(scopedResult.isError).toBe(false)
    expect(provider.handles).toHaveLength(1)
    expect((ctx.subprocess as FakeSubprocess).handles).toHaveLength(1)
  })

  it('rejects extra selectors and invalid values before allocating a terminal', async () => {
    const { execute, subprocess } = setup()
    for (const [name, args] of [
      ['shared_terminal_send', { text: 'ok', sessionId: 'other' }],
      ['shared_terminal_send', { text: 1 }],
      ['shared_terminal_read', { offset: -1 }],
      ['shared_terminal_read', { count: 1.5 }],
      ['shared_terminal_signal', { signal: 'SIGUSR1' }],
      ['shared_terminal_reset', { cwd: '/' }],
    ] as const) expect((await execute(name, args)).isError).toBe(true)
    expect(subprocess.spawnTerminal).not.toHaveBeenCalled()
  })

  it('routes exact Agent and signal through the real runtime and keeps output canonical', async () => {
    const { execute, agent, service, subprocess } = setup()
    const spy = vi.spyOn(service, 'send')
    const signal = new AbortController().signal
    const pending = execute('shared_terminal_send', { text: 'echo ok' }, signal)
    await vi.waitFor(() => expect(subprocess.handles[0]?.write).toHaveBeenCalledWith('echo ok\r'))
    const record = await service.ensure(agent)
    subprocess.handles[0]!.output.write(`ok\r\n${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
    const result = await pending
    expect(spy.mock.calls[0]).toEqual([agent, { text: 'echo ok', submit: true }, signal])
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result.value).toMatchObject({ waitReason: 'prompt', output: 'ok\ndsh$ ', queueStatus: 'ready', holder: null, pendingCount: 0, truncated: false })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    const definition = createTerminalToolDefinitions(DEFAULT_CONFIG, service)[0]!
    expect(validateJsonSchemaValue(definition.output.schema, { ...result.value as object, extra: true })).not.toEqual([])
    expect(definition.presentResult?.({ text: 'echo ok' }, { isError: false, content: [{ type: 'text', text: 'obsolete' }] })).toBeUndefined()
    expect(createTerminalToolDefinitions(DEFAULT_CONFIG, service)[0]!.presentResult?.({ text: 'echo ok' }, result)).toMatchObject({ card: 'terminal' })
    expect(agent.session.events).toEqual([])
  })

  it('returns a schema-valid human handoff result and instructs the model to wait', async () => {
    const { ctx, execute, agent, service, subprocess } = setup()
    const attachment = await service.attach(agent)
    const pending = execute('shared_terminal_send', { text: 'ask' })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalledWith('ask\r'))
    const target = attachment.read().takeoverId
    expect(target).not.toBeNull()
    const human = await attachment.takeover(target!)
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result.value).toMatchObject({ waitReason: 'human_handoff', holder: 'human' })
    expect(validateJsonSchemaValue(createTerminalToolDefinitions(DEFAULT_CONFIG, service)[0]!.output.schema, result.value)).toEqual([])
    const prompt = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:shared-terminal')?.text.toLowerCase() ?? ''
    expect(prompt).toContain('human handoff')
    expect(prompt).toContain('wait for the user')
    expect(prompt).toContain('do not send')
    await service.disposeAgent(agent)
    await human.done
  })

  it('bounds complete JSON including escaped and multibyte text', async () => {
    const { execute, service, agent, subprocess } = setup({ maxToolOutputBytes: 1024 })
    const record = await service.ensure(agent)
    const pending = execute('shared_terminal_send', { text: 'run' })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalled())
    subprocess.handles[0]!.output.write(`${'界"\\\n'.repeat(1000)}${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
    const result = await pending
    expect(result.isError).toBe(false)
    const text = result.content[0]
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('missing text')
    expect(Buffer.byteLength(text.text)).toBeLessThanOrEqual(1024)
    expect(JSON.parse(text.text)).toMatchObject({ truncated: true, status: { kind: 'running' }, waitReason: 'prompt' })
    expect(text.text).not.toContain('�')
  })

  it('fits the complete worst-case required metadata at the protocol minimum', () => {
    const n = Number.MAX_SAFE_INTEGER
    const result = boundTerminalResult({ generation: n, sequence: n, rows: n, cols: n, viewport: '界'.repeat(2000), cursor: { x: n, y: n }, status: { kind: 'exited', exitCode: -n, signal: 'SIGVTALRM' }, queueStatus: 'disposed', holder: 'disconnect-recovery', pendingCount: n, queueTimeMs: Number.MAX_VALUE, waitReason: 'session_exit', output: '\\"\n'.repeat(2000), processGroupId: n, text: '界'.repeat(2000), totalLines: n, lineBegin: n, lineEnd: n, truncated: false }, MIN_TOOL_OUTPUT_BYTES)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MIN_TOOL_OUTPUT_BYTES)
    expect(result).toMatchObject({ truncated: true, status: { kind: 'exited', signal: 'SIGVTALRM' }, pendingCount: n })
  })

  it('reports history eviction during capture even when the retained output fits the model budget', async () => {
    const { execute, service, agent, subprocess } = setup({ scrollbackLines: 1 })
    const record = await service.ensure(agent)
    const pending = execute('shared_terminal_send', { text: 'run' })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalled())
    subprocess.handles[0]!.output.write(`lost\r\nkept\r\nlast${record.terminal.prompt.marker}${record.terminal.prompt.env.PS1}`)
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result.value).toMatchObject({ output: 'kept\nlastdsh$ ', truncated: true })
  })

  it('dispatches signal and reset with exact ownership and removes all registrations', async () => {
    const { ctx, tools, execute, agent, service, subprocess, remove } = setup()
    const record = await service.ensure(agent)
    const controller = new AbortController()
    const signalSpy = vi.spyOn(service, 'signal')
    const resetSpy = vi.spyOn(service, 'reset')
    const pending = execute('shared_terminal_signal', { signal: 'SIGINT' }, controller.signal)
    await vi.waitFor(() => expect(subprocess.handles[0]!.signalForeground).toHaveBeenCalled())
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    const signalled = await pending
    expect(signalled.isError).toBe(false)
    if (!signalled.isError) expect(signalled.value).toMatchObject({ processGroupId: 456, waitReason: 'prompt' })
    expect(signalSpy.mock.calls[0]).toEqual([agent, { signal: 'SIGINT' }, controller.signal])
    const reset = await execute('shared_terminal_reset', {}, controller.signal)
    expect(reset.isError).toBe(false)
    if (!reset.isError) expect(reset.value).toMatchObject({ holder: null, pendingCount: 0 })
    expect(resetSpy.mock.calls[0]).toEqual([agent, controller.signal])
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:shared-terminal')).toBe(true)
    remove()
    expect(tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:shared-terminal')).toBe(false)
  })

  it('cancels an initial read allocation through its execution signal', async () => {
    const { execute, subprocess } = setup()
    const started = deferred<void>()
    subprocess.spawnTerminal.mockImplementationOnce(async spec => {
      const handle = fakeTerminalHandle()
      subprocess.handles.push(handle)
      started.resolve()
      return fakeOwner({ handle, prompt: false }).subprocess.spawnTerminal(spec)
    })
    const controller = new AbortController()
    const pending = execute('shared_terminal_read', {}, controller.signal)
    await started.promise
    controller.abort(new Error('cancel read allocation'))
    const outcome = vi.fn()
    void pending.then(outcome)
    await vi.waitFor(() => expect(outcome).toHaveBeenCalled(), { timeout: 200 })
    expect(subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
  })

  it('forwards active cancellation and drains recovery before returning the public aborted result', async () => {
    const { execute, agent, service, subprocess } = setup()
    const record = await service.ensure(agent)
    const controller = new AbortController()
    const pending = execute('shared_terminal_send', { text: 'run' }, controller.signal)
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalled())
    controller.abort()
    await vi.waitFor(() => expect(subprocess.handles[0]!.signalForeground).toHaveBeenCalledWith('SIGINT'))
    subprocess.handles[0]!.output.write(record.terminal.prompt.marker)
    expect(await pending).toMatchObject({ isError: true, error: { info: { code: 'ABORTED' } } })
    expect(record.terminal.queue.status()).toBe('ready')
  })

  it('reads actual xterm rows and queue facts while a human holds input', async () => {
    const { execute, service, agent, subprocess } = setup({ rows: 2, cols: 30 })
    const attachment = await service.attach(agent)
    const human = await attachment.begin('human secret')
    const pending = execute('shared_terminal_send', { text: 'after' })
    subprocess.handles[0]!.output.write('first\r\nsecond\r\nold\r\x1b[2Knew\r\nvisible')
    await vi.waitFor(() => expect(attachment.read().snapshot.replay).toContain('visible'))
    const result = await execute('shared_terminal_read', { offset: 0, count: 1 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(JSON.stringify(result))
    expect(result.value).toMatchObject({ text: 'second', viewport: 'new\nvisible', holder: 'human', pendingCount: 1, totalLines: 2, lineBegin: 1, lineEnd: 2, cursor: { x: 7, y: 1 } })
    await service.disposeAgent(agent)
    await human.done
    await pending
  })
})
