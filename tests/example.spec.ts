import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { describe, expect, it } from 'vitest'
import { startWeb } from './web-app.mjs'
import { launchBrowser, openWorkspace, prompt } from './web-browser.ts'

export const EXPECTED_TRANSCRIPT_TOOLS = ['shared_terminal_send', 'shared_terminal_read', 'shared_terminal_signal', 'shared_terminal_reset'] as const
export const FORBIDDEN_SESSION_EVENT_TYPES = ['interactive-terminal/output'] as const

export interface ReplayTranscript {
  toolNames: string[]
  sessionEventTypes: string[]
  rows: object[]
}

/** Drive the public Web profile and read its durable, standard agent-loop events. */
export async function replayExample(path: string): Promise<ReplayTranscript> {
  const app = await startWeb({ replay: true, patch: path })
  const browser = await launchBrowser().catch(async error => { await app.dispose(); throw error })
  try {
    const page = await browser.newPage()
    await openWorkspace(page, app.origin, app.workspace)
    await prompt(page, 'Run the four shared-terminal acceptance operations.')
    await page.getByText('TERMINAL_REPLAY_DONE', { exact: true }).waitFor({ timeout: 30000 })
    await app.stop()
    const files = await readdir(join(app.home, 'sessions'), { recursive: true })
    const logPath = files.find(file => file.endsWith('.jsonl'))
    if (!logPath) throw new Error('Web did not persist the assembled session')
    const events = parseSessionLog(await readFile(join(app.home, 'sessions', logPath), 'utf8'))
    const toolNames: string[] = []
    const rows: object[] = []
    const names = new Map<string, string>()
    for (const event of events) {
      if (event.type === 'tool/call') {
        toolNames.push(event.data.name)
        names.set(event.data.callId, event.data.name)
        rows.push({ type: event.type, name: event.data.name, arguments: JSON.parse(event.data.arguments) })
      }
      if (event.type === 'tool/result') {
        const message = event.data.message.content[0]!
        expect(message.isError, JSON.stringify(message.content)).toBe(false)
        expect(message.content).toHaveLength(1)
        const content = message.content[0]!
        if (content.type !== 'text') throw new Error('terminal result must contain JSON text')
        expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(262144)
        const value = JSON.parse(content.text)
        expect(value).toMatchObject({ rows: 40, cols: 160, status: { kind: 'running' }, queueStatus: 'ready', holder: null, pendingCount: 0, truncated: false })
        expect(value.viewport).toBeTypeOf('string')
        expect(value.cursor).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
        expect(value.sequence).toBeGreaterThanOrEqual(0)
        const name = names.get(message.toolCallId)
        if (name === 'shared_terminal_read') {
          expect(value.text).toBeTypeOf('string')
          expect(value.lineBegin).toBeGreaterThanOrEqual(0)
          expect(value.lineEnd - value.lineBegin).toBeLessThanOrEqual(10)
          expect(value.totalLines).toBeGreaterThanOrEqual(value.lineEnd)
        } else {
          expect(value.queueTimeMs).toBeGreaterThanOrEqual(0)
          expect(value.waitReason).toBe('prompt')
          if (name !== 'shared_terminal_reset') expect(value.output).toBeTypeOf('string')
        }
        // Timing, packet sequence, prompt cursor, and process ids vary by native host.
        // Retain the stable model-facing operation fields in the portable transcript.
        rows.push({ type: event.type, name: names.get(message.toolCallId), generation: value.generation, rows: value.rows, cols: value.cols, status: value.status, queueStatus: value.queueStatus,
          ...(value.waitReason === undefined ? {} : { waitReason: value.waitReason }),
          ...(names.get(message.toolCallId) === 'shared_terminal_send' ? { output: value.output } : {}),
        })
      }
      if (event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text')) rows.push({ type: event.type, content: event.data.message.content })
    }
    expect(events.filter(event => event.type === 'request/header').length).toBeGreaterThan(0)
    expect(events.some(event => event.type === 'turn/end')).toBe(true)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(5)
    return { toolNames, sessionEventTypes: events.map(event => event.type), rows }
  } finally { await browser.close(); await app.dispose() }
}

/** Compare the stable projection after validating each complete tool result. */
export async function matchExpected(transcript: ReplayTranscript, path: string): Promise<void> {
  if (process.env.DSH_RECORD_EXPECTED === '1') await writeFile(path, transcript.rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const expected = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(transcript.rows).toEqual(expected)
}

describe('published Web example', () => {
  it('replays the assembled model-visible transcript without PTY byte events', async () => {
    const transcript = await replayExample('examples/web/cordis.yml')
    expect(transcript.toolNames).toEqual([...EXPECTED_TRANSCRIPT_TOOLS])
    for (const type of FORBIDDEN_SESSION_EVENT_TYPES) expect(transcript.sessionEventTypes).not.toContain(type)
    await matchExpected(transcript, 'examples/web/expected.jsonl')
  }, 60000)
})
