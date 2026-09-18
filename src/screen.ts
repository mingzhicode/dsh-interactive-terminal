/**
 * Bounded, server-authoritative terminal screen state.
 *
 * @module dsh-interactive-terminal/screen
 */

import { SerializeAddon } from '@xterm/addon-serialize'
import headless, { type Terminal, type IMarker } from '@xterm/headless'
import type { Config } from './config.ts'
import type { ScreenSnapshot } from './protocol.ts'

/** Settings needed for a fixed terminal viewport and bounded history replay. */
export type TerminalScreenOptions = Pick<Config, 'rows' | 'cols' | 'scrollbackLines' | 'scrollbackMaxBytes'>

/** Rendered active-buffer rows, with a zero-based viewport cursor. */
export interface TerminalText {
  viewport: string
  history: string[]
  cursor: { x: number; y: number }
  truncated: boolean
}

/**
 * Retains xterm state and serializes bounded snapshots for terminal clients.
 */
export class TerminalScreen {
  private readonly terminal: Terminal
  private readonly serializeAddon = new SerializeAddon()
  private sequence = 0
  private readonly firstLine: IMarker

  /**
   * @param options - terminal viewport, retained-line, and history-byte limits.
   */
  constructor(private readonly options: TerminalScreenOptions) {
    this.terminal = new headless.Terminal({
      allowProposedApi: true,
      rows: options.rows,
      cols: options.cols,
      scrollback: options.scrollbackLines,
    })
    this.terminal.loadAddon(this.serializeAddon)
    this.firstLine = this.terminal.registerMarker(0)!
  }

  /**
   * Ingest terminal output before advancing the snapshot watermark.
   *
   * @param output - decoded terminal output from the host process.
   * @returns The new sequence number after xterm has ingested the output.
   */
  async write(output: string): Promise<number> {
    await new Promise<void>(resolve => this.terminal.write(output, resolve))
    return ++this.sequence
  }

  /**
   * Replay both buffers and cursor with the largest whole-line history within its byte limit.
   *
   * @returns Bounded terminal contents and its monotonic sequence number.
   */
  snapshot(): ScreenSnapshot {
    const baseY = this.terminal.buffer.normal.baseY
    const availableLines = Math.min(this.options.scrollbackLines, baseY)
    let lower = 0
    let upper = availableLines

    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2)
      if (Buffer.byteLength(this.serializeHistory(candidate, baseY)) <= this.options.scrollbackMaxBytes) {
        lower = candidate
      } else {
        upper = candidate - 1
      }
    }

    return {
      sequence: this.sequence,
      rows: this.options.rows,
      cols: this.options.cols,
      replay: this.serializeAddon.serialize({ scrollback: lower }),
      historyBytes: Buffer.byteLength(this.serializeHistory(lower, baseY)),
      truncated: lower < availableLines || this.firstLine.isDisposed,
    }
  }

  /** @returns Plain active-buffer rows; history keeps whole rows within its byte budget. */
  text(): TerminalText {
    const buffer = this.terminal.buffer.active
    const history: string[] = []
    let bytes = 0
    let start = buffer.baseY
    while (start > 0) {
      const line = buffer.getLine(start - 1)!.translateToString(true)
      const size = Buffer.byteLength(line) + Number(history.length > 0)
      if (bytes + size > this.options.scrollbackMaxBytes) break
      history.push(line)
      bytes += size
      start -= 1
    }
    const viewport = Array.from({ length: this.options.rows }, (_, index) => buffer.getLine(buffer.baseY + index)!.translateToString(true)).join('\n')
    return { viewport, history: history.reverse(), cursor: { x: buffer.cursorX, y: buffer.cursorY }, truncated: start > 0 || (buffer.type === 'normal' && this.firstLine.isDisposed) }
  }

  /** Release the serialize add-on before disposing its terminal. */
  dispose(): void {
    this.serializeAddon.dispose()
    this.terminal.dispose()
  }

  private serializeHistory(lines: number, baseY: number): string {
    if (lines === 0) return ''
    return this.serializeAddon.serialize({
      range: { start: baseY - lines, end: baseY - 1 },
      excludeAltBuffer: true,
      excludeModes: true,
    })
  }
}

/**
 * Keep the newest UTF-8 suffix without splitting an encoded character.
 *
 * @param text - plain text to bound.
 * @param maxBytes - maximum UTF-8 byte length to retain.
 * @returns The retained suffix and whether bytes were omitted.
 */
export function truncateUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= maxBytes) return { text, truncated: false }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}
