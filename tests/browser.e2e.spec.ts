import { expect, it } from 'vitest'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { startWeb } from './web-app.mjs'
import { launchBrowser, openWorkspace, prompt } from './web-browser.ts'

it('requires explicit handoff during a model operation and preserves the PTY across collapse and reconnect', async () => {
  const app = await startWeb({ replay: true })
  const browser = await launchBrowser().catch(async error => { await app.dispose(); throw error })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const frames: Array<{ type: string; generation: number; output?: string; holder?: string | null; snapshot?: { replay: string; rows: number; cols: number } }> = []
    page.on('websocket', socket => {
      if (!socket.url().endsWith('/dsh-interactive-terminal/ws')) return
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString())
        // Retain observable state only; never retain attachment/reconnect credentials.
        frames.push({ type: frame.type, generation: frame.generation, ...(frame.output === undefined ? {} : { output: frame.output }), ...(frame.holder === undefined ? {} : { holder: frame.holder }), ...(frame.snapshot === undefined ? {} : { snapshot: frame.snapshot }) })
      })
    })
    await openWorkspace(page, app.origin, app.workspace)
    const blankDock = page.getByRole('region', { name: 'Session terminal', exact: true })
    const blankDockBox = await blankDock.boundingBox()
    const blankHeaderBox = await blankDock.locator('.dsh-terminal-header').boundingBox()
    const blankComposerBox = await page.locator('[data-composer-card]').boundingBox()
    expect(blankDockBox).not.toBeNull()
    expect(blankHeaderBox).not.toBeNull()
    expect(blankComposerBox).not.toBeNull()
    expect(blankDockBox!.height).toBeGreaterThanOrEqual(blankHeaderBox!.height)
    expect(Math.abs(blankDockBox!.x - blankComposerBox!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(blankDockBox!.width - blankComposerBox!.width)).toBeLessThanOrEqual(1)
    await prompt(page, 'Run the shared terminal acceptance operations.')
    const composerCard = page.locator('[data-composer-card]')
    const toggle = page.getByRole('button', { name: /^(Open terminal|Terminal)$/, exact: true })
    await toggle.click()
    const panel = page.getByRole('region', { name: 'Session terminal', exact: true })
    const dockBox = await panel.boundingBox()
    const composerBox = await composerCard.boundingBox()
    expect(dockBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(composerBox!.y)
    expect(Math.abs(dockBox!.x - composerBox!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(dockBox!.width - composerBox!.width)).toBeLessThanOrEqual(1)
    await expect.poll(() => frames.some(frame => frame.holder === 'model-send'), { timeout: 15000 }).toBe(true)
    const input = panel.locator('.xterm-helper-textarea')
    await input.focus()
    await page.keyboard.type('STALE_ANSWER')
    await page.keyboard.press('Enter')
    await page.getByText('TERMINAL_REPLAY_DONE', { exact: true }).waitFor({ timeout: 30000 })
    const output = frames.map(frame => frame.output ?? '').join('')
    expect(output.indexOf('MODEL_LAST')).toBeGreaterThanOrEqual(0)
    expect(output).not.toContain('STALE_ANSWER')
    expect(frames.some(frame => frame.type === 'human.queued')).toBe(false)
    await expect.poll(() => frames.filter(frame => frame.type === 'terminal.snapshot').at(-1)?.generation).toBe(2)
    await expect.poll(() => panel.getByRole('status').innerText()).toContain('connected ready')
    await input.focus()
    await page.keyboard.type("export PERSISTED=kept; printf 'PERSIST_%s\\n' READY")
    await page.keyboard.press('Enter')
    await expect.poll(() => frames.map(frame => frame.output ?? '').join(''), { timeout: 10000 }).toContain('PERSIST_READY')
    await toggle.click()
    expect(await panel.locator('.dsh-terminal-panel').isVisible()).toBe(false)
    await page.screenshot({ path: 'artifacts/terminal-handoff-dock-collapsed.png' })
    await toggle.click()
    await input.focus()
    await page.keyboard.insertText("printf 'STATE_%s\\n' \"$PERSISTED\"")
    await page.keyboard.press('Enter')
    await expect.poll(() => frames.map(frame => frame.output ?? '').join('')).toContain('STATE_kept')
    await page.screenshot({ path: 'artifacts/terminal-handoff-dock-expanded.png' })
    const beforeReconnect = frames.filter(frame => frame.type === 'terminal.snapshot').length
    await panel.getByRole('button', { name: 'Terminal settings', exact: true }).click()
    await panel.getByRole('button', { name: 'Larger terminal text', exact: true }).click()
    const terminalRows = panel.locator('.xterm-rows')
    await expect.poll(() => terminalRows.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
    await page.screenshot({ path: 'artifacts/terminal-handoff-dock-settings.png' })
    await panel.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await expect.poll(() => frames.filter(frame => frame.type === 'terminal.snapshot').length).toBeGreaterThan(beforeReconnect)
    const replacement = frames.filter(frame => frame.type === 'terminal.snapshot').at(-1)!
    expect(replacement.generation).toBe(2)
    expect(replacement.snapshot).toMatchObject({ rows: 40, cols: 160 })
    expect(replacement.snapshot?.replay).toContain('STATE_kept')
    await expect.poll(() => terminalRows.innerText()).toContain('STATE_kept')
    expect(await terminalRows.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
    await page.setViewportSize({ width: 520, height: 900 })
    const narrowDockBox = await panel.boundingBox()
    expect(narrowDockBox).not.toBeNull()
    expect(narrowDockBox!.x).toBeGreaterThanOrEqual(0)
    expect(narrowDockBox!.x + narrowDockBox!.width).toBeLessThanOrEqual(520)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(520)
    await page.screenshot({ path: 'artifacts/terminal-handoff-dock-narrow.png' })
    await page.setViewportSize({ width: 390, height: 900 })
    await input.focus()
    await page.keyboard.insertText('x'.repeat(65537))
    const notice = panel.getByRole('alert')
    await notice.waitFor()
    expect(await notice.innerText()).toContain('Input limit reached')
    const terminalPanel = panel.locator('.dsh-terminal-panel')
    await terminalPanel.evaluate(element => { element.style.height = '12rem' })
    expect((await terminalPanel.boundingBox())!.height).toBeCloseTo(192, 0)
    await panel.getByRole('button', { name: 'Reset Terminal', exact: true }).click()
    const confirmReset = panel.getByRole('button', { name: 'Confirm reset', exact: true })
    const cancelReset = panel.getByRole('button', { name: 'Cancel', exact: true })
    await terminalPanel.evaluate(element => { element.scrollTop = 0 })
    const clippedPanelBox = (await terminalPanel.boundingBox())!
    const clippedConfirmBox = (await confirmReset.boundingBox())!
    expect(clippedConfirmBox.y + clippedConfirmBox.height).toBeGreaterThan(clippedPanelBox.y + clippedPanelBox.height)
    expect(await terminalPanel.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto')
    for (const target of [confirmReset, cancelReset, notice]) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const panelBox = (await terminalPanel.boundingBox())!
        const targetBox = (await target.boundingBox())!
        if (targetBox.y >= panelBox.y && targetBox.y + targetBox.height <= panelBox.y + panelBox.height) break
        await terminalPanel.hover()
        await page.mouse.wheel(0, targetBox.y < panelBox.y ? -48 : 48)
      }
      const panelBox = (await terminalPanel.boundingBox())!
      const targetBox = (await target.boundingBox())!
      expect(targetBox.y).toBeGreaterThanOrEqual(panelBox.y)
      expect(targetBox.y + targetBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height)
    }
    expect(frames.filter(frame => frame.type === 'terminal.snapshot').at(-1)?.snapshot).toMatchObject({ rows: 40, cols: 160 })
    await page.screenshot({ path: 'artifacts/terminal-handoff-dock-min-height.png' })
    await panel.getByRole('button', { name: 'Confirm reset', exact: true }).click()
    await expect.poll(() => frames.filter(frame => frame.type === 'terminal.snapshot').at(-1)?.generation, { timeout: 10000 }).toBe(3)
    expect(frames.filter(frame => frame.type === 'terminal.snapshot').at(-1)?.snapshot?.replay).not.toContain('STATE_kept')
    await page.reload()
    const reopen = page.getByRole('button', { name: 'Open terminal', exact: true })
    await reopen.waitFor()
    expect(await reopen.getAttribute('aria-expanded')).toBe('false')
    expect(await panel.locator('.xterm').count()).toBe(0)
    await reopen.click()
    await expect.poll(() => panel.getByRole('status').innerText()).toContain('connected')
  } finally { await browser.close(); await app.dispose() }
}, 60000)

it('hands a model-started interactive program to the browser without interrupting or replacing its PTY', async () => {
  const app = await startWeb({ replay: 'examples/web/handoff-replay.json' })
  const browser = await launchBrowser().catch(async error => { await app.dispose(); throw error })
  try {
    await writeFile(join(app.workspace, 'handoff-child.sh'), [
      'trap "touch .handoff-interrupted; exit 130" INT',
      'printf "Authenticate test program? (Y/n) "',
      'while [ ! -f .handoff-ready ]; do sleep 0.05; done',
      'IFS= read -r answer',
      'printf "ANSWER_%s\\n" "$answer"',
      '',
    ].join('\n'))
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const frames: Array<{ type: string; generation: number; output: string | undefined; holder: string | undefined; pendingCount: number | undefined }> = []
    page.on('websocket', socket => {
      if (!socket.url().endsWith('/dsh-interactive-terminal/ws')) return
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString())
        frames.push({ type: frame.type, generation: frame.generation, output: frame.output, holder: frame.holder, pendingCount: frame.pendingCount })
      })
    })
    await openWorkspace(page, app.origin, app.workspace)
    await page.getByRole('button', { name: /^(Open terminal|Terminal)$/, exact: true }).click()
    const panel = page.getByRole('region', { name: 'Session terminal', exact: true })
    await expect.poll(() => panel.getByRole('status').innerText()).toContain('connected ready')
    await prompt(page, 'Start the local interactive handoff acceptance program.')
    const output = () => frames.map(frame => frame.output ?? '').join('')
    await expect.poll(output, { timeout: 15000 }).toContain('\r\nAuthenticate test program? (Y/n)')
    const takeover = panel.getByRole('button', { name: 'Take over input', exact: true })
    await takeover.click({ timeout: 5000 })
    await expect.poll(() => frames.some(frame => frame.type === 'human.granted')).toBe(true)
    await expect.poll(() => frames.filter(frame => frame.type === 'terminal.status').map(frame => ({ holder: frame.holder, pendingCount: frame.pendingCount })), { timeout: 15000 }).toContainEqual({ holder: 'human', pendingCount: 1 })
    expect(output()).not.toContain('FOLLOWER_DONE')
    await page.screenshot({ path: 'artifacts/terminal-handoff-granted.png' })
    await writeFile(join(app.workspace, '.handoff-ready'), '')
    const input = panel.locator('.xterm-helper-textarea')
    expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.type('Y')
    await page.keyboard.press('Enter')
    await page.getByText('HANDOFF_REPLAY_DONE', { exact: true }).waitFor({ timeout: 15000 })
    expect(output()).toContain('ANSWER_Y')
    expect(output().indexOf('FOLLOWER_DONE')).toBeGreaterThan(output().indexOf('ANSWER_Y'))
    expect(output()).not.toContain('command not found')
    await expect(access(join(app.workspace, '.handoff-interrupted'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(new Set(frames.map(frame => frame.generation))).toEqual(new Set([1]))
    await page.screenshot({ path: 'artifacts/terminal-handoff-complete.png' })
    await app.stop()
    const files = await readdir(join(app.home, 'sessions'), { recursive: true })
    const path = files.find(file => file.endsWith('.jsonl'))!
    const events = parseSessionLog(await readFile(join(app.home, 'sessions', path), 'utf8'))
    const outcomes = events.filter(event => event.type === 'tool/result').map(event => {
      const block = event.data.message.content[0]!
      expect(block.isError).toBe(false)
      const content = block.content[0]!
      if (content.type !== 'text') throw new Error('Expected JSON terminal result')
      const result = JSON.parse(content.text)
      return { toolCallId: block.toolCallId, waitReason: result.waitReason, generation: result.generation, output: result.output }
    })
    expect(outcomes.map(({ output: _output, ...outcome }) => outcome)).toEqual([
      { toolCallId: 'handoff-start', waitReason: 'human_handoff', generation: 1 },
      { toolCallId: 'handoff-follower', waitReason: 'prompt', generation: 1 },
    ])
    expect(outcomes[0]!.output).not.toContain('ANSWER_Y')
    expect(outcomes[1]!.output).toContain('FOLLOWER_DONE')
    expect(outcomes[1]!.output).not.toContain('ANSWER_Y')
    expect(events.some(event => String(event.type) === 'interactive-terminal/output')).toBe(false)
  } finally { await browser.close(); await app.dispose() }
}, 60000)
