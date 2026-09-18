/** Nonce-bearing Bash prompt emission and streaming recognition. */
import { randomBytes } from 'node:crypto'

/** OSC prefix reserved for the controlled Bash prompt marker. */
export const PROMPT_MARKER_PREFIX = '\x1b]133;D;'

/** OSC terminator used by the controlled Bash prompt marker. */
export const PROMPT_MARKER_SUFFIX = '\x07'

/**
 * Recognizes one shell generation's prompt across arbitrary output chunks.
 * The nonce prevents incidental matches; it is not authentication against shell code.
 */
export class ControlledPrompt {
  /** Random identifier shared by this generation's emitter and parser. */
  readonly nonce = randomBytes(24).toString('base64url')
  /** Exact marker emitted before each primary Bash prompt. */
  readonly marker: string
  /** Environment overrides for Bash launched with --noprofile --norc -i. */
  readonly env: Readonly<Record<'PROMPT_COMMAND' | 'PS1' | 'PS2', string>>
  /** Exit status from the most recently completed primary prompt marker. */
  lastExitStatus: number | undefined
  private suffix = ''
  private suffixObserver: (() => void) | undefined
  private readonly prefix = `${PROMPT_MARKER_PREFIX}${this.nonce};`

  /** Allocate a fresh marker for one shell generation. */
  constructor() {
    this.marker = `${this.prefix}0${PROMPT_MARKER_SUFFIX}`
    this.env = {
      PROMPT_COMMAND: `printf '\\033]133;D;${this.nonce};%s\\007' "$?"; PS1='dsh$ '`,
      PS1: 'dsh$ ',
      PS2: '> ',
    }
  }

  /**
   * Count markers and retain each partial marker's starting observation.
   * @param output - decoded output from this shell generation, in order.
   * @param onPrompt - observation bound to the operation owning this output chunk.
   * @returns Number of newly completed primary prompt markers.
   */
  consume(output: string, onPrompt?: () => void): number {
    const previousLength = this.suffix.length
    const previousObserver = this.suffixObserver
    const text = this.suffix + output
    let count = 0
    let end = 0
    const pattern = new RegExp(`${this.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9]{1,3})${PROMPT_MARKER_SUFFIX}`, 'g')
    for (const match of text.matchAll(pattern)) {
      const status = Number(match[1])
      if (status > 255) continue
      count += 1
      this.lastExitStatus = status
      end = match.index + match[0].length
      const observer = match.index < previousLength ? previousObserver : onPrompt
      observer?.()
    }
    const start = text.lastIndexOf('\x1b')
    const candidate = text.slice(start)
    const status = candidate.slice(this.prefix.length)
    const partial = start >= end && (this.prefix.startsWith(candidate)
      || (candidate.startsWith(this.prefix) && /^[0-9]{0,3}$/.test(status) && Number(status) <= 255))
    this.suffix = partial ? candidate : ''
    this.suffixObserver = partial ? (start < previousLength ? previousObserver : onPrompt) : undefined
    return count
  }
}

/** Environment and parser sharing one generation's controlled prompt nonce. */
export interface PromptEnvironment {
  nonce: string
  prompt: ControlledPrompt
  env: Record<string, string>
}

/**
 * Build explicit environment overrides without inheriting harness credentials.
 * @param sessionId - owning session's diagnostic identifier.
 * @returns Environment and the sole parser for its emitted markers.
 */
export function createPromptEnvironment(sessionId: string): PromptEnvironment {
  const prompt = new ControlledPrompt()
  return {
    nonce: prompt.nonce,
    prompt,
    env: { ...prompt.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', DSH_SHELL: '1', DSH_SESSION_ID: sessionId },
  }
}
