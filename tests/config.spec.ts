import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG, assertSupportedHost, validateConfig } from '../src/config.ts'

describe('interactive terminal config', () => {
  it('resolves every deployment tunable explicitly', () => {
    // Deployment parsing accepts omitted fields and supplies their schema defaults.
    expect(ConfigSchema({} as typeof DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
  })

  it('rejects unsupported hosts and non-Bash shells', () => {
    expect(() => assertSupportedHost({ ...DEFAULT_CONFIG, shellPath: '/bin/zsh' }, 'darwin'))
      .toThrow('shellPath must name bash')
    expect(() => assertSupportedHost(DEFAULT_CONFIG, 'win32'))
      .toThrow('supports only macOS and Linux')
  })

  it('rejects unsafe integers and inconsistent byte limits', () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, maxToolOutputBytes: 1023 })).toThrow('1024')
    expect(() => validateConfig(ConfigSchema({ ...DEFAULT_CONFIG, rows: Number.MAX_SAFE_INTEGER + 1 }))).toThrow()
    expect(() => validateConfig(ConfigSchema({ ...DEFAULT_CONFIG, maxToolOutputBytes: DEFAULT_CONFIG.scrollbackMaxBytes + 1 }))).toThrow()
  })
})
