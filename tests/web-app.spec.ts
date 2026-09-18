import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { startWeb } from './web-app.mjs'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: vi.fn(fs.mkdir), mkdtemp: vi.fn(fs.mkdtemp), rm: vi.fn(fs.rm) }
})

afterEach(async () => {
  for (const result of vi.mocked(mkdtemp).mock.results) {
    if (result.type === 'return') await rm(await result.value, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

it.each(['setup', 'startup'] as const)('removes its allocated scratch directory after %s failure', async stage => {
  if (stage === 'setup') vi.mocked(mkdir).mockRejectedValueOnce(new Error('fixture setup failed'))
  await expect(startWeb({ patch: 'examples/web/does-not-exist.yml' })).rejects.toThrow(stage === 'setup' ? 'fixture setup failed' : /Web exited/)
  expect(rm).toHaveBeenCalledOnce()
  const [scratch, options] = vi.mocked(rm).mock.calls[0]!
  expect(options).toEqual({ recursive: true, force: true })
  await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
}, 10000)
