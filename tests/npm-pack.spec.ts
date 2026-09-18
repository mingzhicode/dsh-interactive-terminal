import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshCli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')

// These exact public runtime peers prove the tarball does not borrow workspace packages.
// The DSH CLI peer is supplied separately by the official scratch-profile activation.
const CLEAN_CONSUMER_DEPENDENCIES = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
  '@deepseek-ai/cordis-plugin-loader': '1.0.3',
  '@deepseek-ai/dsh-agent': '0.1.0-rc.8',
  '@deepseek-ai/dsh-agent-presets': '0.1.0-rc.8',
  '@deepseek-ai/dsh-api-gateway': '0.1.0-rc.8',
  '@deepseek-ai/dsh-atomic-write': '0.1.0-rc.8',
  '@deepseek-ai/dsh-attachment': '0.1.0-rc.8',
  '@deepseek-ai/dsh-brand': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-connection': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-locale': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-modules': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-ui-layout': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-ui-settings': '0.1.0-rc.8',
  '@deepseek-ai/dsh-client-ui-theme': '0.1.0-rc.8',
  '@deepseek-ai/dsh-code-runtime': '0.1.0-rc.8',
  '@deepseek-ai/dsh-commands': '0.1.0-rc.8',
  '@deepseek-ai/dsh-compaction': '0.1.0-rc.8',
  '@deepseek-ai/dsh-cordis-host-runner': '0.1.0-rc.8',
  '@deepseek-ai/dsh-file-reference': '0.1.0-rc.8',
  '@deepseek-ai/dsh-home-paths': '0.1.0-rc.8',
  '@deepseek-ai/dsh-host-apiproxy': '0.1.0-rc.8',
  '@deepseek-ai/dsh-host-plugin-inventory': '0.1.0-rc.8',
  '@deepseek-ai/dsh-host-webserver': '0.1.0-rc.8',
  '@deepseek-ai/dsh-invariants': '0.1.0-rc.8',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.8',
  '@deepseek-ai/dsh-llm-retry': '0.1.0-rc.8',
  '@deepseek-ai/dsh-message-feedback': '0.1.0-rc.8',
  '@deepseek-ai/dsh-output-retention': '0.1.0-rc.8',
  '@deepseek-ai/dsh-sandbox': '0.1.0-rc.8',
  '@deepseek-ai/dsh-sandbox-policy': '0.1.0-rc.8',
  '@deepseek-ai/dsh-scope': '0.1.0-rc.8',
  '@deepseek-ai/dsh-session': '0.1.0-rc.8',
  '@deepseek-ai/dsh-session-reference': '0.1.0-rc.8',
  '@deepseek-ai/dsh-storage': '0.1.0-rc.8',
  '@deepseek-ai/dsh-storage-domain': '0.1.0-rc.8',
  '@deepseek-ai/dsh-subprocess': '0.1.0-rc.8',
  '@deepseek-ai/dsh-system-prompt': '0.1.0-rc.8',
  '@deepseek-ai/dsh-timeout': '0.1.0-rc.8',
  '@deepseek-ai/dsh-tools': '0.1.0-rc.8',
  '@deepseek-ai/dsh-typert-protocol': '0.1.0-rc.8',
  '@deepseek-ai/dsh-typert-registry': '0.1.0-rc.8',
  '@deepseek-ai/dsh-user-approval': '0.1.0-rc.8',
  jsdom: '30.0.1',
  react: '18.3.1',
} as const

const ALLOWED_PACKAGE_ARTIFACTS = [
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/README.md',
  'package/README.zh.md',
  'package/cordis.patch.yml',
  'package/dist/client.js',
  'package/lib/client/TerminalOverlay.d.ts',
  'package/lib/client/css.d.ts',
  'package/lib/client/index.d.ts',
  'package/lib/client/platform.d.ts',
  'package/lib/client/protocol.d.ts',
  'package/lib/client/use-terminal.d.ts',
  'package/lib/index.d.ts',
  'package/lib/index.js',
  'package/lib/invariant.d.ts',
  'package/lib/invariant.js',
  'package/lib/protocol.d.ts',
  'package/package.json',
] as const

export const REQUIRED_PACKAGE_ARTIFACTS = [
  'package/lib/index.js',
  'package/lib/invariant.js',
  'package/lib/index.d.ts',
  'package/dist/client.js',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/README.zh.md',
  'package/LICENSE',
] as const

interface PackedFixture {
  root: string
  tarball: string
  files: string[]
  manifest: PackageManifest
  dispose(): Promise<void>
}

interface PackageManifest {
  files?: string[]
  scripts?: Record<string, string>
}

interface PackResult {
  filename: string
  files: Array<{ path: string }>
}

interface SmokeResult {
  host: boolean
  client: boolean
  invariant: boolean
}

function parsePackResults(text: string): PackResult[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || value.length !== 1) throw new Error('npm pack returned an unexpected result')
  const row: unknown = value[0]
  if (!row || typeof row !== 'object' || !('filename' in row) || typeof row.filename !== 'string' || !('files' in row) || !Array.isArray(row.files)) {
    throw new Error('npm pack result omitted filename or files')
  }
  const files = row.files.map(file => {
    if (!file || typeof file !== 'object' || !('path' in file) || typeof file.path !== 'string') throw new Error('npm pack returned an invalid file row')
    return { path: file.path }
  })
  return [{ filename: row.filename, files }]
}

function parsePackageManifest(text: string): PackageManifest {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('packed package.json is not an object')
  const files = 'files' in value ? value.files : undefined
  const scripts = 'scripts' in value ? value.scripts : undefined
  if (files !== undefined && (!Array.isArray(files) || files.some(file => typeof file !== 'string'))) throw new Error('packed package.json has invalid files')
  if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts) || Object.values(scripts).some(script => typeof script !== 'string'))) {
    throw new Error('packed package.json has invalid scripts')
  }
  return {
    ...(files === undefined ? {} : { files: files as string[] }),
    ...(scripts === undefined ? {} : { scripts: scripts as Record<string, string> }),
  }
}

function parseSmokeResult(text: string): SmokeResult {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object'
    || !('host' in value) || typeof value.host !== 'boolean'
    || !('client' in value) || typeof value.client !== 'boolean'
    || !('invariant' in value) || typeof value.invariant !== 'boolean') {
    throw new Error('clean consumer returned an invalid smoke result')
  }
  return { host: value.host, client: value.client, invariant: value.invariant }
}

async function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<string> {
  try {
    const result = await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 180_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    if (!error || typeof error !== 'object') throw error
    const code = 'code' in error ? String(error.code) : 'unknown'
    const signal = 'signal' in error ? String(error.signal) : 'none'
    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.slice(-4000) : ''
    const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.slice(-4000) : ''
    throw new Error(`${command} ${args.join(' ')} failed (code ${code}, signal ${signal})\n${stdout}${stderr}`)
  }
}

interface PnpmRuntime {
  command: string
  prefix: string[]
  node: string
  wrapper: string
}

async function createPnpmRuntime(root: string): Promise<PnpmRuntime> {
  const node = process.env.DSH_PACKAGE_SMOKE_NODE ?? process.execPath
  const pnpmCli = process.env.DSH_PACKAGE_SMOKE_PNPM_CLI
  if ((process.env.DSH_PACKAGE_SMOKE_NODE === undefined) !== (pnpmCli === undefined)) {
    throw new Error('DSH_PACKAGE_SMOKE_NODE and DSH_PACKAGE_SMOKE_PNPM_CLI must be set together')
  }
  const bin = join(root, 'bin')
  await mkdir(bin)
  const wrapper = join(bin, 'pnpm')
  const command = pnpmCli ? node : 'npx'
  const prefix = pnpmCli ? [pnpmCli] : ['--yes', 'pnpm@10.18.3']
  const invocation = pnpmCli
    ? `exec ${JSON.stringify(node)} ${JSON.stringify(pnpmCli)} "$@"`
    : 'exec npx --yes pnpm@10.18.3 "$@"'
  await writeFile(wrapper, `#!/bin/sh\n${invocation}\n`)
  await chmod(wrapper, 0o755)
  const version = (await run(command, [...prefix, '--version'], { cwd: root })).trim()
  if (version !== '10.18.3') throw new Error(`package smoke requires pnpm 10.18.3, received ${version}`)
  return { command, prefix, node, wrapper }
}

export async function packToTemporaryDirectory(): Promise<PackedFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-terminal-pack-'))
  try {
    const output = await run('npm', ['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', root], { cwd: packageRoot })
    const packed = parsePackResults(output)
    const result = packed[0]
    if (!result) throw new Error('npm pack returned no result')
    const tarball = join(root, result.filename)
    await run('tar', ['-xzf', tarball, '-C', root], { cwd: root })
    const manifest = parsePackageManifest(await readFile(join(root, 'package/package.json'), 'utf8'))
    return {
      root,
      tarball,
      files: result.files.map(file => `package/${file.path}`).sort(),
      manifest,
      dispose: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function activateInstalledProfile(tarball: string, runtime: PnpmRuntime): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-terminal-activate-'))
  const workspace = join(scratch, 'workspace')
  await mkdir(workspace)
  const env = {
    ...process.env,
    PATH: `${dirname(runtime.wrapper)}${delimiter}${process.env.PATH ?? ''}`,
    CI: 'true',
    DSH_HOME: join(scratch, 'home'),
    DSH_AGENTS_HOME: join(scratch, 'agents'),
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_DISABLED: '1',
  }
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    await run(runtime.node, [dshCli, 'plugin', '--profile', 'web', 'add', tarball], { cwd: packageRoot, env })
    const profileText = await readFile(join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8')
    const profile: unknown = JSON.parse(profileText)
    const bundles = profile && typeof profile === 'object' && 'dsh' in profile && profile.dsh && typeof profile.dsh === 'object'
      && 'profile' in profile.dsh && profile.dsh.profile && typeof profile.dsh.profile === 'object' && 'bundles' in profile.dsh.profile
      ? profile.dsh.profile.bundles : undefined
    if (!Array.isArray(bundles) || !bundles.includes('dsh-interactive-terminal')) {
      throw new Error('official plugin add did not activate dsh-interactive-terminal in the web profile')
    }

    const running = spawn(runtime.node, [dshCli, '--profile', 'web', '--port', '0', '--no-open'], {
      cwd: workspace,
      env,
    })
    child = running
    running.stdin.end()
    let output = ''
    running.stdout.on('data', chunk => { output += chunk })
    running.stderr.on('data', chunk => { output += chunk })
    const origin = await new Promise<string>((resolveOrigin, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll)
        reject(new Error(`installed Web profile startup timed out:\n${output}`))
      }, 30_000)
      const poll = setInterval(() => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolveOrigin(match[0])
        } else if (running.exitCode !== null) {
          clearInterval(poll)
          clearTimeout(deadline)
          reject(new Error(`installed Web profile exited ${running.exitCode}:\n${output}`))
        }
      }, 50)
    })
    const response = await fetch(`${origin}/plugins/dsh-interactive-terminal/client.js`)
    if (!response.ok || !(await response.text()).includes('__ModuleLoader__')) {
      throw new Error(`installed Web profile did not serve the terminal client (${response.status})`)
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolveExit => child?.once('exit', resolveExit))
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function smokeInstallAndImport(tarball: string): Promise<SmokeResult> {
  const consumer = await mkdtemp(join(tmpdir(), 'dsh-terminal-consumer-'))
  try {
    const runtime = await createPnpmRuntime(consumer)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.18.3',
      dependencies: {
        ...CLEAN_CONSUMER_DEPENDENCIES,
        'dsh-interactive-terminal': `file:${tarball}`,
      },
    }))
    await writeFile(join(consumer, 'smoke.mjs'), await readFile(new URL('./package-consumer.mjs', import.meta.url), 'utf8'))
    await run(runtime.command, [...runtime.prefix, 'install', '--ignore-scripts', '--offline', '--config.auto-install-peers=false'], { cwd: consumer, env: { ...process.env, CI: 'true' } })
    const output = await run(runtime.node, ['smoke.mjs'], { cwd: consumer })
    await activateInstalledProfile(tarball, runtime)
    return parseSmokeResult(output.trim())
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

describe('npm package', () => {
  it('contains every runtime artifact and no source-only dependency', async () => {
    const packed = await packToTemporaryDirectory()
    try {
      expect(packed.files).toEqual(expect.arrayContaining([...REQUIRED_PACKAGE_ARTIFACTS]))
      expect(packed.files).toEqual([...ALLOWED_PACKAGE_ARTIFACTS].sort())
      expect(packed.manifest.files).toEqual([
        'dist/client.js', 'lib/**/*.js', 'lib/**/*.d.ts', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'cordis.patch.yml', 'LICENSE',
      ])
      expect(packed.manifest.scripts?.postinstall).toBeUndefined()
      await expect(smokeInstallAndImport(packed.tarball)).resolves.toEqual({ host: true, client: true, invariant: true })
    } finally {
      await packed.dispose()
    }
  }, 300_000)
})
