import { describe, expect, it, vi } from 'vitest'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { makeService, fakeAgent, serviceContext, disposeFakeAgent } from './fixtures/fake-agent.ts'
import { InteractiveTerminalService } from '../src/service.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { deferred } from './fixtures/fake-clock.ts'
import { fakeTerminalHandle } from './fixtures/fake-subprocess.ts'

describe('interactive terminal lifecycle fences', () => {
  it('rejects a sandbox mode change before its event commits during creation and live use', async () => {
    const { ctx } = serviceContext()
    const service = makeService({}, ctx)
    const agent = fakeAgent('owner', ctx)
    try {
      const creating = service.ensure(agent)
      expect(() => setSandboxMode(agent.session, 'read-only')).toThrow('terminal is active')
      await creating
      expect(() => setSandboxMode(agent.session, 'read-only')).toThrow('terminal is active')
      expect(agent.session.events.some(event => event.type === 'sandbox/mode')).toBe(false)
    } finally { await service.dispose() }
  })

  it('allows unchanged modes and unrelated sessions, and removes its fence after teardown', async () => {
    const { ctx } = serviceContext()
    const service = makeService({}, ctx)
    const parent = fakeAgent('parent', ctx)
    const child = fakeAgent('child', ctx, parent)
    await service.ensure(parent)
    expect(() => setSandboxMode(parent.session, 'danger-full-access')).not.toThrow()
    expect(() => setSandboxMode(child.session, 'read-only')).not.toThrow()
    await service.dispose()
    expect(() => setSandboxMode(parent.session, 'read-only')).not.toThrow()
  })

  it('awaits exact-Agent scope cleanup without disposing a sibling terminal', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({}, ctx)
    const left = fakeAgent('left', ctx)
    const right = fakeAgent('right', ctx)
    await service.ensure(left)
    await service.ensure(right)
    const active = service.send(left, { text: 'left', submit: true })
    await vi.waitFor(() => expect(subprocess.handles[0]!.write).toHaveBeenCalled())
    await disposeFakeAgent(left)
    await expect(active).resolves.toMatchObject({ waitReason: 'cancelled' })
    expect(subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
    expect(subprocess.handles[1]!.terminate).not.toHaveBeenCalled()
    expect(service.size).toBe(1)
    await expect(service.ensure(left)).rejects.toThrow('disposed')
    await service.dispose()
  })

  it('aborts pending creation on Agent disposal and never publishes its late handle', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({}, ctx)
    const owner = fakeAgent('owner', ctx)
    const allocated = deferred<ReturnType<typeof fakeTerminalHandle>>()
    subprocess.spawnTerminal.mockImplementationOnce(() => allocated.promise)
    const creating = service.ensure(owner)
    const rejected = expect(creating).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(subprocess.spawnTerminal).toHaveBeenCalled())
    const disposing = service.disposeAgent(owner)
    const handle = fakeTerminalHandle()
    allocated.resolve(handle)
    await disposing
    await rejected
    expect(handle.terminate).toHaveBeenCalledOnce()
    expect(service.size).toBe(0)
    await service.dispose()
  })

  it('disposes a mounted service in reverse creation order and removes the Cordis registration', async () => {
    const { ctx, subprocess } = serviceContext()
    const fiber = await ctx.plugin(InteractiveTerminalService, DEFAULT_CONFIG)
    const service = ctx.interactiveTerminals
    const first = fakeAgent('first', ctx)
    const second = fakeAgent('second', ctx)
    await service.ensure(first)
    await service.ensure(second)
    const order: number[] = []
    subprocess.handles.forEach((handle, index) => {
      const terminate = handle.terminate.getMockImplementation()!
      handle.terminate.mockImplementation(async () => { order.push(index); await terminate() })
    })
    await fiber.dispose()
    expect(order).toEqual([1, 0])
    expect(ctx.get('interactiveTerminals')).toBeUndefined()
    expect(service.size).toBe(0)
    await expect(service.ensure(first)).rejects.toThrow('disposed')
    const replacement = await ctx.plugin(InteractiveTerminalService, DEFAULT_CONFIG)
    await expect(ctx.interactiveTerminals.ensure(first)).resolves.toMatchObject({ generation: 1 })
    await replacement.dispose()
  })

  it('retains capacity and the policy fence until termination reaches quiescence', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({ maxSessions: 1 }, ctx)
    const owner = fakeAgent('owner', ctx)
    const other = fakeAgent('other', ctx)
    await service.ensure(owner)
    const stopped = deferred<void>()
    const terminate = subprocess.handles[0]!.terminate.getMockImplementation()!
    subprocess.handles[0]!.terminate.mockImplementationOnce(async () => { await stopped.promise; await terminate() })
    const disposing = service.disposeAgent(owner)
    expect(service.size).toBe(1)
    expect(() => setSandboxMode(owner.session, 'read-only')).toThrow('terminal is active')
    await expect(service.ensure(other)).rejects.toThrow('capacity')
    stopped.resolve()
    await disposing
    expect(service.size).toBe(0)
    expect(() => setSandboxMode(owner.session, 'read-only')).not.toThrow()
    await service.ensure(other)
    await service.dispose()
  })

  it('continues reverse cleanup after a failure and does not release a failed resource reservation', async () => {
    const { ctx, subprocess } = serviceContext()
    const service = makeService({}, ctx)
    await service.ensure(fakeAgent('first', ctx))
    await service.ensure(fakeAgent('second', ctx))
    subprocess.handles[1]!.terminate.mockRejectedValueOnce(new Error('termination failed'))
    await expect(service.dispose()).rejects.toThrow('cleanup failed')
    expect(subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
    expect(subprocess.handles[1]!.terminate).toHaveBeenCalledOnce()
    expect(service.size).toBe(1)
  })
})
