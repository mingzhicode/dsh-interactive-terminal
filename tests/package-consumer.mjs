// @ts-check
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import * as cordis from '@deepseek-ai/cordis'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as host from 'dsh-interactive-terminal'
import * as invariant from 'dsh-interactive-terminal/invariant'

const require = createRequire(import.meta.url)

/**
 * @param {unknown} value
 * @returns {value is typeof import('@deepseek-ai/dsh-client-modules/client').createClientModuleSystem}
 */
function isClientModuleFactory(value) {
  return typeof value === 'function'
}

const official = await readFile(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
const bundle = await readFile(require.resolve('dsh-interactive-terminal/client'), 'utf8')
const dom = new JSDOM('', { url: 'http://localhost', runScripts: 'outside-only' })
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
/** @type {import('@deepseek-ai/dsh-client-modules/client').ClientModuleLoaderTarget} */
const facade = {
  mode: 'queue',
  pendingQueue: [],
  load(registration) { this.pendingQueue.push(registration) },
  create() { throw new Error('bootstrap created explicitly') },
}
Object.assign(dom.window, { __ModuleLoader__: facade })
try {
  dom.window.eval(official)
  const bootstrap = facade.pendingQueue.shift()
  if (!bootstrap) throw new Error('official client loader did not register its factory')
  const exports = bootstrap.factory(specifier => {
    if (specifier === '@deepseek-ai/cordis') return cordis
    throw new Error(`Unexpected bootstrap external ${specifier}`)
  })
  const create = exports.createClientModuleSystem
  if (!isClientModuleFactory(create)) throw new Error('official client loader factory has no createClientModuleSystem export')
  const loader = create(facade, { id: bootstrap.id, exports }, {
    boot: { rev: 'test', entries: [{ id: 'dsh-interactive-terminal', rev: 'test', url: '/client.js', inject: [] }] },
    staticModules: { react: React, 'react/jsx-runtime': jsx },
    loadBundle: async () => { dom.window.eval(bundle) },
  })
  const client = await loader.import('dsh-interactive-terminal/client')
  if (!client || typeof client !== 'object') throw new Error('terminal client bundle returned no exports')
  console.log(JSON.stringify({
    host: host.name === 'dsh-interactive-terminal' && typeof host.apply === 'function',
    client: 'apply' in client && typeof client.apply === 'function' && 'inject' in client && Array.isArray(client.inject),
    invariant: invariant.name === 'dsh-interactive-terminal-invariant' && typeof invariant.apply === 'function',
  }))
} finally {
  dom.window.close()
}
