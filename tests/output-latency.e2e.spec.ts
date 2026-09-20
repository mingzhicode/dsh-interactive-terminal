import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expect, it } from 'vitest'
import { startWeb } from './web-app.mjs'
import { launchBrowser, openWorkspace, prompt } from './web-browser.ts'

it('renders fragmented model output promptly and retains it across reconnect', async () => {
  const app = await startWeb({ replay: 'examples/web/output-replay.json' })
  const browser = await launchBrowser().catch(async error => { await app.dispose(); throw error })
  try {
    const page = await browser.newPage()
    const frames: Array<{ at: number; sequence: number; output: string }> = []
    let snapshots = 0
    page.on('websocket', socket => {
      if (!socket.url().endsWith('/dsh-interactive-terminal/ws')) return
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString())
        if (frame.type === 'terminal.output') frames.push({ at: performance.now(), sequence: frame.sequence, output: frame.output })
        if (frame.type === 'terminal.snapshot') snapshots++
      })
    })
    await openWorkspace(page, app.origin, app.workspace)
    await page.getByRole('button', { name: /^(Open terminal|Terminal)$/, exact: true }).click()
    const panel = page.getByRole('region', { name: 'Session terminal', exact: true })
    await expect.poll(() => panel.getByRole('status').innerText()).toContain('connected ready')
    const started = performance.now()
    await prompt(page, 'Run the fragmented terminal output acceptance operation.')
    await page.waitForFunction(() => document.querySelector('.dsh-terminal .xterm-rows')?.textContent?.includes('BURST_END'), undefined, { timeout: 5000 })
    const visibleMs = performance.now() - started
    expect(visibleMs).toBeLessThan(5000)
    await page.getByText('OUTPUT_REPLAY_DONE', { exact: true }).waitFor()
    const output = frames.map(frame => frame.output).join('')
    expect(output).toContain('\r\nBURST_START\r\n' + 'x'.repeat(1000) + '\r\nBURST_END\r\n')
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.sequence).toBe(frames[i - 1]!.sequence + 1)
    const rows = panel.locator('.xterm-rows')
    const rendered = await rows.textContent()
    const before = snapshots
    await panel.getByRole('button', { name: 'Terminal settings', exact: true }).click()
    await panel.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect.poll(() => snapshots).toBeGreaterThan(before)
    await expect.poll(() => rows.textContent()).toBe(rendered)
    await expect.poll(() => panel.getByRole('status').innerText()).toContain('connected ready')
    await panel.locator('.xterm-helper-textarea').focus()
    await page.keyboard.insertText("printf 'FOLLOWER_%s\\n' \"$BURST_STATE\"")
    await page.keyboard.press('Enter')
    await expect.poll(() => rows.textContent()).toContain('FOLLOWER_kept')

    await app.stop()
    const files = await readdir(join(app.home, 'sessions'), { recursive: true })
    const log = files.find(file => file.endsWith('.jsonl'))!
    const events = parseSessionLog(await readFile(join(app.home, 'sessions', log), 'utf8'))
    const result = events.find(event => event.type === 'tool/result')!
    if (result.type !== 'tool/result') throw new Error('Missing terminal tool result')
    const block = result.data.message.content[0]!
    expect(block.isError).toBe(false)
    const content = block.content[0]!
    if (content.type !== 'text') throw new Error('Expected terminal JSON result')
    const value = JSON.parse(content.text)
    expect(value.waitReason).toBe('prompt')
    expect(value.output.replaceAll('\n', '')).toContain('BURST_START' + 'x'.repeat(1000) + 'BURST_END')
    await mkdir('artifacts', { recursive: true })
    await writeFile('artifacts/terminal-host-output-benchmark.json', JSON.stringify({
      environment: 'isolated DSH Web profile, replay model, real native PTY, WebSocket and Chromium xterm',
      measurement: 'composer submission to DOM text detection, not physical display latency',
      characters: 1000, visibleMs: Math.round(visibleMs),
      modelOutputFrames: frames.filter(frame => frame.at <= started + visibleMs).length,
    }, null, 2) + '\n')
  } finally { await browser.close(); await app.dispose() }
}, 60000)
