import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { TerminalScreen, truncateUtf8Tail } from '../src/screen.ts'

describe('authoritative terminal screen', () => {
  it('reports history evicted by the configured line cap in snapshots', async () => {
    const screen = new TerminalScreen({ rows: 2, cols: 10, scrollbackLines: 1, scrollbackMaxBytes: 10000 })
    try {
      await screen.write('one\r\ntwo\r\nthree\r\nfour')
      expect(screen.snapshot().truncated).toBe(true)
    } finally { screen.dispose() }
  })
  it.each([
    'one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[2;3H',
    '\x1b[31m12345678901234567890123456789012345678901234567890\x1b[2;3H',
    'one\r\ntwo\r\nthree\r\nfour\r\nfive\x1b[?1049h\x1b[Halt\x1b[2;3H',
  ])('replays retained buffers and cursor before further output: %j', async output => {
    const screen = new TerminalScreen({ rows: 3, cols: 12, scrollbackLines: 20, scrollbackMaxBytes: 10000 })
    const client = new Terminal({ rows: 3, cols: 12, scrollback: 20, allowProposedApi: true })
    const compare = () => {
      const buffer = client.buffer.active
      expect(Array.from({ length: buffer.baseY }, (_, i) => buffer.getLine(i)!.translateToString(true))).toEqual(screen.text().history)
      expect(Array.from({ length: client.rows }, (_, i) => buffer.getLine(buffer.baseY + i)!.translateToString(true)).join('\n')).toEqual(screen.text().viewport)
      expect({ x: buffer.cursorX, y: buffer.cursorY }).toEqual(screen.text().cursor)
    }
    try {
      await screen.write(output)
      const snapshot = screen.snapshot()
      await new Promise<void>(resolve => client.write(snapshot.replay, resolve))
      compare()
      for (const chunk of ['next', '\x1b[?1049l', '\r\nlast']) {
        await screen.write(chunk)
        await new Promise<void>(resolve => client.write(chunk, resolve))
        compare()
      }
    } finally { client.dispose(); screen.dispose() }
  })
  it('projects real retained text rows, cursor movement, and alternate buffers', async () => {
    const screen = new TerminalScreen({ rows: 2, cols: 20, scrollbackLines: 4, scrollbackMaxBytes: 100 })
    await screen.write('first\r\nsecond\r\nold\r\x1b[2Knew\r\nvisible')
    expect(screen.text()).toEqual({ viewport: 'new\nvisible', history: ['first', 'second'], cursor: { x: 7, y: 1 }, truncated: false })
    await screen.write('\x1b[?1049h\x1b[Halt')
    expect(screen.text()).toMatchObject({ viewport: 'alt\n', history: [], cursor: { x: 3, y: 0 } })
    screen.dispose()
  })
  it('serializes a fixed-size viewport with a monotonic watermark', async () => {
    const screen = new TerminalScreen({ rows: 2, cols: 8, scrollbackLines: 4, scrollbackMaxBytes: 64 })
    await expect(screen.write('one\r\ntwo\r\nthree')).resolves.toBe(1)
    expect(screen.snapshot()).toMatchObject({ rows: 2, cols: 8, sequence: 1 })
    expect(screen.snapshot().replay).toContain('three')
  })

  it('truncates only at a UTF-8 boundary and reports truncation', () => {
    expect(truncateUtf8Tail('a界b', 4)).toEqual({ text: '界b', truncated: true })
  })

  it('retains the largest complete history replay below its byte limit independently of the viewport', async () => {
    const screen = new TerminalScreen({ rows: 2, cols: 80, scrollbackLines: 4, scrollbackMaxBytes: 20 })
    await screen.write('first-entry\r\nsecond-entry\r\ncurrent viewport is deliberately longer than the history budget\r\nlatest viewport row')
    const snapshot = screen.snapshot()
    expect(Buffer.byteLength(snapshot.replay)).toBeGreaterThan(20)
    expect(snapshot).toMatchObject({ truncated: true })
    expect(snapshot.historyBytes).toBeLessThanOrEqual(20)
    expect(snapshot.replay).toContain('second-entry')
    expect(snapshot.replay).not.toContain('first-entry')
  })
})
