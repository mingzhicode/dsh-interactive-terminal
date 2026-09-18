/**
 * Validated deployment settings for the interactive terminal plugin.
 *
 * @module dsh-interactive-terminal/config
 */

import z from '@deepseek-ai/schemastery'

/** Complete model JSON needs room for status, queue, cursor, and page metadata. */
export const MIN_TOOL_OUTPUT_BYTES = 1024

/** Deployment-controlled settings for terminal sessions. */
export interface Config {
  shellPath: string
  shellArgs: string[]
  rows: number
  cols: number
  scrollbackLines: number
  scrollbackMaxBytes: number
  maxToolOutputBytes: number
  maxInputBytes: number
  maxQueuedOperations: number
  maxSessions: number
  pollIntervalMs: number
  operationTimeoutMs: number
  interruptTimeoutMs: number
  disconnectGraceMs: number
  disposeGraceMs: number
}

/** Complete default settings for an interactive terminal deployment. */
export const DEFAULT_CONFIG: Config = {
  shellPath: '/bin/bash',
  shellArgs: ['--noprofile', '--norc', '-i'],
  rows: 40,
  cols: 160,
  scrollbackLines: 10000,
  scrollbackMaxBytes: 4194304,
  maxToolOutputBytes: 262144,
  maxInputBytes: 65536,
  maxQueuedOperations: 128,
  maxSessions: 32,
  pollIntervalMs: 50,
  operationTimeoutMs: 30000,
  interruptTimeoutMs: 5000,
  disconnectGraceMs: 15000,
  disposeGraceMs: 3000,
}

/** Schemastery schema that resolves every terminal deployment setting. */
export const ConfigSchema: z<Config> = z.object({
  shellPath: z.string().default(DEFAULT_CONFIG.shellPath),
  shellArgs: z.array(String).default(DEFAULT_CONFIG.shellArgs),
  rows: z.natural().min(1).default(DEFAULT_CONFIG.rows),
  cols: z.natural().min(1).default(DEFAULT_CONFIG.cols),
  scrollbackLines: z.natural().min(1).default(DEFAULT_CONFIG.scrollbackLines),
  scrollbackMaxBytes: z.natural().min(1).default(DEFAULT_CONFIG.scrollbackMaxBytes),
  maxToolOutputBytes: z.natural().min(MIN_TOOL_OUTPUT_BYTES).default(DEFAULT_CONFIG.maxToolOutputBytes),
  maxInputBytes: z.natural().min(1).default(DEFAULT_CONFIG.maxInputBytes),
  maxQueuedOperations: z.natural().min(1).default(DEFAULT_CONFIG.maxQueuedOperations),
  maxSessions: z.natural().min(1).default(DEFAULT_CONFIG.maxSessions),
  pollIntervalMs: z.natural().min(1).default(DEFAULT_CONFIG.pollIntervalMs),
  operationTimeoutMs: z.natural().min(1).default(DEFAULT_CONFIG.operationTimeoutMs),
  interruptTimeoutMs: z.natural().min(1).default(DEFAULT_CONFIG.interruptTimeoutMs),
  disconnectGraceMs: z.natural().default(DEFAULT_CONFIG.disconnectGraceMs),
  disposeGraceMs: z.natural().min(1).default(DEFAULT_CONFIG.disposeGraceMs),
})

/**
 * Reject unsupported operating systems and shells after validating the settings.
 *
 * @param config - resolved terminal deployment settings.
 * @param platform - operating system to validate; defaults to the current host.
 * @returns Nothing.
 */
export function assertSupportedHost(config: Config, platform: NodeJS.Platform = process.platform): void {
  validateConfig(config)
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('dsh-interactive-terminal supports only macOS and Linux')
  }
  if (!/(^|\/)bash$/.test(config.shellPath)) {
    throw new Error('dsh-interactive-terminal shellPath must name bash')
  }
}

/**
 * Validate cross-field and safe-integer requirements beyond schema parsing.
 *
 * @param config - resolved terminal deployment settings.
 * @returns Nothing.
 */
export function validateConfig(config: Config): void {
  if (config.maxToolOutputBytes < MIN_TOOL_OUTPUT_BYTES) {
    throw new Error(`dsh-interactive-terminal maxToolOutputBytes must be at least ${MIN_TOOL_OUTPUT_BYTES}`)
  }
  if (config.shellPath.length === 0 || config.shellArgs.some(argument => argument.length === 0)) {
    throw new Error('dsh-interactive-terminal shell values must be non-empty')
  }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`dsh-interactive-terminal ${key} must be a positive safe integer`)
    }
  }
  if (config.maxToolOutputBytes > config.scrollbackMaxBytes) {
    throw new Error('dsh-interactive-terminal maxToolOutputBytes must not exceed scrollbackMaxBytes')
  }
}
