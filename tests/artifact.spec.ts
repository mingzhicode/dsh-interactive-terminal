import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import * as cordis from '@deepseek-ai/cordis'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { serviceContext } from './fixtures/fake-agent.ts'
import type { ClientBundleRegistration, ClientModuleLoaderTarget, createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const id = 'dsh-interactive-terminal'

describe('published artifacts', () => {
  it('routes client exports to an official closure-factory bundle with tracked inline CSS', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.exports['./client']).toEqual({ types: './lib/client/index.d.ts', default: './dist/client.js' })
    expect(pkg.dsh).toEqual({ client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-conversation'] }, bundle: { patch: './cordis.patch.yml' } })
    const bundle = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
    const official = await readFile(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
    const dom = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only' })
    // Bundle materialization only probes canvas support; rendering is covered by browser tests.
    dom.window.HTMLCanvasElement.prototype.getContext = () => null
    const facade: ClientModuleLoaderTarget = {
      mode: 'queue', pendingQueue: [],
      load(registration: ClientBundleRegistration) { this.pendingQueue.push(registration) },
      create() { throw new Error('bootstrap created explicitly') },
    }
    Object.assign(dom.window, { __ModuleLoader__: facade })
    try {
      dom.window.eval(official)
      const bootstrap = facade.pendingQueue.shift()!
      const exports = bootstrap.factory(specifier => {
        if (specifier === '@deepseek-ai/cordis') return cordis
        throw new Error(`Unexpected bootstrap external ${specifier}`)
      }) as { createClientModuleSystem: typeof createClientModuleSystem }
      const loader = exports.createClientModuleSystem(facade, { id: bootstrap.id, exports }, {
        boot: { rev: 'test', entries: [{ id, rev: 'test', url: '/client.js', inject: [] }] },
        staticModules: { react: React, 'react/jsx-runtime': jsx },
        loadBundle: async () => { dom.window.eval(bundle) },
      })
      const client = await loader.import(`${id}/client`) as { apply: unknown; inject: string[] }
      expect(client.inject).toEqual(['slots', 'connection'])
      expect(client.apply).toBeTypeOf('function')
      const styles = [...dom.window.document.querySelectorAll(`style[data-plugin="${id}"]`)]
      expect(styles).toHaveLength(2)
      expect(styles.map(style => style.textContent).join('')).toContain('.xterm')
      expect([...loader.loadCache.get(id)!.edges].sort()).toEqual(['react', 'react/jsx-runtime'])
      expect([...loader.loadCache.get(id)!.styles].sort()).toEqual([`${id}/styles.css`, `${id}/xterm.css`])
      loader.invalidate(id)
      await loader.import(id)
      expect(dom.window.document.querySelectorAll(`style[data-plugin="${id}"]`)).toHaveLength(2)
    } finally { dom.window.close() }
  })

  it('loads the built Host through the public Loader and serves the discovered browser export', async () => {
    const { ctx } = serviceContext()
    ctx.baseUrl = new URL('../package.json', import.meta.url).href
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    const web = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const connection = await ctx.plugin({ inject: ['webServer'], apply: scope => { new HostConnectionService(scope, []) } })
    const loaderFiber = await ctx.plugin(Loader)
    const loader = ctx.loader
    let modules: Awaited<ReturnType<typeof ctx.plugin>> | undefined
    try {
      await loader.root.update([{ id, name: id, config: {} }])
      await loader.await()
      expect(ctx.interactiveTerminals).toBeDefined()
      modules = await loader.ctx.plugin(ClientModuleRegistry)
      const registry = ctx.clientModules
      expect(registry.clientPath(id)).toBe(fileURLToPath(new URL('../dist/client.js', import.meta.url)))
      const row = registry.graph().entries.find(row => row.id === id)!
      expect(row.inject).toEqual(['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-conversation'])
      const origin = `http://127.0.0.1:${ctx.webServer.port}`
      expect(await (await fetch(`${origin}/plugins/${id}/client.js`)).text()).toBe(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'))
      await loader.remove(id)
      expect(ctx.get('interactiveTerminals')).toBeUndefined()
      await Promise.resolve()
      expect(registry.clientPath(id)).toBeUndefined()
    } finally {
      await modules?.dispose()
      await loader.root.stop()
      await loaderFiber.dispose()
      await connection.dispose()
      await web.dispose()
    }
  })
})
