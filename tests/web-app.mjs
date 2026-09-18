/** Isolated public CLI/Web composition shared by acceptance and local recording. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Start rc.8's actual Web profile with fresh writable state and the built plugin.
 * @param {{ replay?: boolean | string, credentialsPath?: string, patch?: string }} [options]
 */
export async function startWeb({ replay = false, credentialsPath, patch = 'examples/web/cordis.yml' } = {}) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-terminal-web-')))
  const home = join(scratch, 'home')
  const profile = join(home, 'profiles/web')
  const workspace = join(scratch, 'workspace')
  const cleanup = () => rm(scratch, { recursive: true, force: true })
  try {
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await mkdir(workspace)
    await symlink(packageRoot, join(profile, 'node_modules/dsh-interactive-terminal'), 'dir')
    if (replay) {
      await mkdir(join(profile, 'node_modules/@deepseek-ai'))
      await symlink(await realpath(join(packageRoot, 'node_modules/@deepseek-ai/dsh-llm-replay')), join(profile, 'node_modules/@deepseek-ai/dsh-llm-replay'), 'dir')
    }
    const overrides = [
      { id: 'directory-picker', disabled: true },
      { insert: [
        { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
        { id: 'directory-picker-browse-ui', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
      ] },
      { id: 'session-title-llm', disabled: true },
      ...(credentialsPath ? [{ id: 'credentials', config: { path: credentialsPath, watch: false } }] : []),
      ...(replay ? [
        { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
        { id: 'llm-deepseek', disabled: true },
        { id: 'llm-pi-ai', disabled: true },
        { id: 'agent-default-model', config: { provider: 'terminal-replay', model: 'terminal-replay' } },
        { insert: [{ id: 'terminal-replay', name: '@deepseek-ai/dsh-llm-replay', config: {
          file: join(packageRoot, 'examples/web/session.jsonl'),
          overrideFile: resolve(packageRoot, typeof replay === 'string' ? replay : 'examples/web/replay.json'),
          providers: [{ id: 'terminal-replay', models: [{ id: 'terminal-replay', contextWindow: 65536 }] }],
        } }] },
      ] : []),
    ]
    await writeFile(join(scratch, 'acceptance.patch.json'), JSON.stringify(overrides))
  } catch (error) {
    await cleanup()
    throw error
  }
  const cli = join(await realpath(join(packageRoot, 'node_modules/@deepseek-ai/dsh')), 'lib/bin.js')
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', resolve(packageRoot, patch), '--patch', join(scratch, 'acceptance.patch.json'), '--port', '0', '--no-open'], {
    cwd: workspace, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(scratch, 'agents'), DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
  try {
    const origin = await new Promise(/** @param {(value: string) => void} resolve */ (resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(`Web startup timed out:\n${output}`)) }, 30000)
      const poll = setInterval(() => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) { clearInterval(poll); clearTimeout(deadline); resolve(match[0]); return }
        if (child.exitCode !== null) { clearInterval(poll); clearTimeout(deadline); reject(new Error(`Web exited ${child.exitCode}:\n${output}`)) }
      }, 50)
    })
    return { origin, scratch, home, workspace, child, output: () => output, stop, dispose: async () => { await stop(); await cleanup() } }
  } catch (error) { await stop(); await cleanup(); throw error }
}
