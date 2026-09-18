import { once } from 'node:events'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { TERMINAL_TOOL_NAMES } from '../src/tools.ts'
import { RPC_CHANNEL, WS_PATH, WS_PROTOCOL } from '../src/transport.ts'
import { disposeFakeAgent, fakeAgent, serviceContext } from './fixtures/fake-agent.ts'
import { deferred } from './fixtures/fake-clock.ts'

describe('plugin assembly', () => {
  it('publishes Loader-safe named exports and the resolved schema', () => {
    expect(plugin.name).toBe('dsh-interactive-terminal')
    expect(plugin.inject).toEqual(['agents', 'subprocess', 'sandboxPolicy', 'tools', 'systemPrompt', 'connection', 'webServer'])
    expect(plugin.Config({})).toEqual(DEFAULT_CONFIG)
    expect(plugin).not.toHaveProperty('default')
    expect(invariant.name).toBe('dsh-interactive-terminal-invariant')
    expect(invariant.inject).toContain('invariants')
  })

  it.each(['plugin', 'Agent'])('disposes the real %s fiber while a human provider write awaits process termination', async scope => {
    const { ctx, subprocess } = serviceContext()
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new InvariantRegistry(ctx)
    const register = vi.spyOn(ctx.tools, 'register')
    const section = vi.spyOn(ctx.systemPrompt, 'section')
    const web = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const connection = await ctx.plugin({ inject: ['webServer'], apply: scope => { new HostConnectionService(scope, []) } })
    const fiber = await ctx.plugin(plugin, { disposeGraceMs: 25 })
    const companion = await ctx.plugin(invariant)
    const service = ctx.interactiveTerminals
    const agent = fakeAgent('assembled', ctx)
    const origin = `http://127.0.0.1:${ctx.webServer.port}`
    let socket: WebSocket | undefined
    const blocked = deferred<void>()
    const stopped = deferred<void>()
    try {
      expect(register.mock.calls.map(([tool]) => tool.name)).toEqual(TERMINAL_TOOL_NAMES)
      expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'tool:shared-terminal' }))
      const response = await fetch(`${origin}${RPC_CHANNEL}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ type: 'client-request', rpcId: 'assembly', method: 'token', payload: { sessionId: agent.id, readonly: false } }) })
      const { result } = await response.json() as { result: { value: { token: string } } }
      socket = new WebSocket(`${origin.replace('http:', 'ws:')}${WS_PATH}`, [WS_PROTOCOL, `token.${result.value.token}`], { origin })
      const frames: Array<{ type: string }> = []
      socket.on('message', data => frames.push(JSON.parse(data.toString()) as { type: string }))
      await once(socket, 'open')
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'terminal.attached')).toBe(true))
      const handle = subprocess.handles[0]!
      handle.write.mockImplementationOnce(() => blocked.promise)
      const terminate = handle.terminate.getMockImplementation()!
      handle.terminate.mockImplementationOnce(async () => { await stopped.promise; blocked.resolve(); await terminate() })
      socket.send(JSON.stringify({ version: 1, generation: 1, type: 'human.begin', input: 'read value\r' }))
      await vi.waitFor(() => expect(handle.write).toHaveBeenCalled())
      const closed = once(socket, 'close')
      const disposing = scope === 'plugin' ? fiber.dispose() : disposeFakeAgent(agent)
      await vi.waitFor(() => expect(handle.terminate).toHaveBeenCalled())
      expect(service.isDisposed(agent)).toBe(false)
      if (scope === 'Agent') expect(() => invariant.checkOwnership(ctx, message => { throw new Error(message) })).not.toThrow()
      stopped.resolve()
      await disposing
      await closed
      expect(handle.terminate).toHaveBeenCalledOnce()
      expect(service.size).toBe(0)
      if (scope === 'Agent') {
        expect(ctx.interactiveTerminalTransport.ownership()).toEqual([])
        expect(service.isDisposed(agent)).toBe(true)
        await fiber.dispose()
      }
      expect(ctx.get('interactiveTerminals')).toBeUndefined()
      expect((await fetch(`${origin}${RPC_CHANNEL}/token`, { method: 'POST' })).status).toBe(404)
      const replacement = await ctx.plugin(plugin, {})
      expect(ctx.interactiveTerminals).not.toBe(service)
      await replacement.dispose()
    } finally {
      blocked.resolve()
      stopped.resolve()
      socket?.terminate()
      await fiber.dispose()
      await companion.dispose()
      await connection.dispose()
      await web.dispose()
    }
  })

  it('registers an active invariant and rejects broken owned relationships at runtime', async () => {
    const { ctx } = serviceContext()
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new InvariantRegistry(ctx)
    const registered = vi.spyOn(ctx.invariants, 'register')
    const web = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const connection = await ctx.plugin({ inject: ['webServer'], apply: scope => { new HostConnectionService(scope, []) } })
    const fiber = await ctx.plugin(plugin, {})
    const companion = await ctx.plugin(invariant)
    const service = ctx.interactiveTerminals
    const transport = ctx.interactiveTerminalTransport
    const agent = fakeAgent('checked', ctx)
    try {
      expect(registered).toHaveBeenCalledWith('dsh-interactive-terminal', expect.objectContaining({ inject: ['interactiveTerminals', 'interactiveTerminalTransport'] }))
      await service.ensure(agent)
      expect(() => ctx.emit('interactive-terminal/ownership')).not.toThrow()
      const records = vi.spyOn(service, 'ownership')
      records.mockReturnValue([{ owner: agent, generations: [1, 2], queued: 0 }])
      expect(() => ctx.emit('interactive-terminal/ownership')).toThrow('multiple live terminal generations')
      records.mockRestore()
      await service.disposeAgent(agent)
      const queued = vi.spyOn(service, 'ownership').mockReturnValue([{ owner: agent, generations: [], queued: 1 }])
      expect(() => invariant.checkOwnership(ctx, message => { throw new Error(message) })).toThrow('queue or process resources')
      queued.mockRestore()
      const sockets = vi.spyOn(transport, 'ownership')
      sockets.mockReturnValue([{ owner: agent, sockets: 1, pending: 0 }])
      expect(() => ctx.emit('interactive-terminal/ownership')).toThrow('sockets or queue work')
      sockets.mockReturnValue([{ owner: agent, sockets: 0, pending: 1 }])
      expect(() => ctx.emit('interactive-terminal/ownership')).toThrow('sockets or queue work')
      sockets.mockRestore()
      await companion.dispose()
      const removed = vi.spyOn(transport, 'ownership').mockReturnValue([{ owner: agent, sockets: 1, pending: 1 }])
      expect(() => ctx.emit('interactive-terminal/ownership')).not.toThrow()
      removed.mockRestore()
    } finally {
      vi.restoreAllMocks()
      await companion.dispose()
      await fiber.dispose()
      await connection.dispose()
      await web.dispose()
    }
  })
})
