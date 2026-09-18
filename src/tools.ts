/** Four current-Agent terminal tools with canonical, byte-bounded model results. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError, validateJsonSchemaValue, valueSchemaSpecToJsonSchema, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { validateConfig, type Config } from './config.ts'
import { truncateUtf8Tail } from './screen.ts'
import type { InteractiveTerminalService, TerminalReadResult } from './service.ts'

/** The complete shared terminal model surface. */
export const TERMINAL_TOOL_NAMES = ['shared_terminal_send', 'shared_terminal_read', 'shared_terminal_signal', 'shared_terminal_reset'] as const
/** Registered model tool names. */
export type TerminalToolName = typeof TERMINAL_TOOL_NAMES[number]
/** Signals accepted by the foreground-process provider. */
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
/** Resolved model write arguments. */
export interface SharedTerminalSendArgs { text: string; submit: boolean }
/** Resolved newest-relative history page. */
export interface SharedTerminalReadArgs { offset: number; count: number }
/** Foreground signal arguments. */
export interface SharedTerminalSignalArgs { signal: TerminalSignal }
/** Reset has no model-controlled policy or identity selectors. */
export type SharedTerminalResetArgs = Record<string, never>

const statusSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'running' } } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, const: 'exited' },
      exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
      signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    } },
  ],
} as const
const commonProperties = {
  generation: { type: 'integer', required: true },
  sequence: { type: 'integer', required: true },
  rows: { type: 'integer', required: true },
  cols: { type: 'integer', required: true },
  viewport: { type: 'string', required: true },
  cursor: { type: 'object', additionalProperties: false, required: true, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
  status: { ...statusSchema, required: true },
  queueStatus: { type: 'string', enum: ['ready', 'busy', 'blocked', 'exited', 'disposed'], required: true },
  holder: { required: true, oneOf: [{ type: 'string', enum: ['model-send', 'human', 'signal', 'reset', 'disconnect-recovery'] }, { type: 'null' }] },
  pendingCount: { type: 'integer', required: true },
  truncated: { type: 'boolean', required: true },
} as const
const mutationProperties = {
  queueTimeMs: { type: 'number', required: true },
  waitReason: { type: 'string', required: true, enum: ['prompt', 'stdin_read', 'session_exit', 'timeout', 'cancelled', 'human_handoff'] },
} as const
const operationProperties = { ...commonProperties, ...mutationProperties, output: { type: 'string', required: true } } as const
const sendOutputSchema = valueSchemaSpecToJsonSchema({ type: 'object', additionalProperties: false, properties: operationProperties })

/** @param text - terminal input. @param maxInputBytes - deployment byte cap. @returns Validated input. */
export function checkedInput(text: string, maxInputBytes: number): string {
  if (Buffer.byteLength(text) > maxInputBytes) throw new Error('terminal input exceeds maxInputBytes')
  return text
}

/**
 * Preserve metadata and valid JSON while bounding all projected text together.
 * @param value - canonical terminal result before text truncation.
 * @param maxBytes - complete serialized JSON UTF-8 cap, including escaping.
 * @returns The result with UTF-8-safe text suffixes and truthful truncation.
 */
export function boundTerminalResult<T extends { viewport: string; truncated: boolean; text?: string; output?: string }>(value: T, maxBytes: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value
  const project = (budget: number): T => {
    const result = { ...value, truncated: true }
    for (const key of ['viewport', 'text', 'output'] as const) {
      const text = value[key]
      if (text !== undefined) result[key] = truncateUtf8Tail(text, budget).text
    }
    return result
  }
  let lower = 0
  let upper = maxBytes
  if (Buffer.byteLength(JSON.stringify(project(0))) > maxBytes) throw new Error('terminal metadata exceeds maxToolOutputBytes')
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2)
    if (Buffer.byteLength(JSON.stringify(project(candidate))) <= maxBytes) lower = candidate
    else upper = candidate - 1
  }
  return project(lower)
}

function common(state: TerminalReadResult) {
  return {
    generation: state.generation, sequence: state.snapshot.sequence, rows: state.snapshot.rows, cols: state.snapshot.cols,
    viewport: state.text.viewport, cursor: state.text.cursor, status: state.status,
    queueStatus: state.queueStatus, holder: state.holder, pendingCount: state.pendingCount, truncated: state.text.truncated,
  }
}

/**
 * Build registry-ready definitions using the public value validator.
 * @param config - validated deployment policy; never model arguments.
 * @param service - injected terminal provider; the executing Agent supplies ownership, not service access.
 * @returns Exactly four tools, each addressing the executing Agent's terminal.
 */
export function createTerminalToolDefinitions(config: Config, service: InteractiveTerminalService): ToolDefinition[] {
  validateConfig(config)
  const maxBytes = config.maxToolOutputBytes
  const definitions = [
    defineTool({
      name: TERMINAL_TOOL_NAMES[0], description: 'Send input to your shared terminal and wait for a prompt, stdin read, human handoff, timeout, or session exit. Human input and model mutations share a FIFO queue.',
      parameters: { text: { type: 'string', required: true }, submit: { type: 'boolean', default: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: operationProperties }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(boundTerminalResult(value, maxBytes)) }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('shared terminal tools require an initiating Agent')
        const request: SharedTerminalSendArgs = { text: args.text, submit: args.submit ?? true }
        checkedInput(request.text + (request.submit ? '\r' : ''), config.maxInputBytes)
        const result = await service.send(exec.agent, request, exec.signal)
        return boundTerminalResult({ ...common(result), output: result.output, queueTimeMs: result.queueTimeMs, waitReason: result.waitReason, truncated: result.outputTruncated || result.text.truncated }, maxBytes)
      },
      presentCall: args => ({ card: 'terminal', title: args.text || '(send input)', description: 'Shared terminal' }),
      presentResult: (_args, result) => {
        if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text') return undefined
        let value: unknown
        try { value = JSON.parse(result.content[0].text) } catch { return undefined }
        if (validateJsonSchemaValue(sendOutputSchema, value).length) return undefined
        return { card: 'terminal', output: (value as { output: string }).output }
      },
    }),
    defineTool({
      name: TERMINAL_TOOL_NAMES[1], description: 'Read your shared terminal viewport and a newest-relative page of retained history without waiting for input ownership.',
      parameters: { offset: { type: 'integer', default: 0 }, count: { type: 'integer', default: 500 } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        ...commonProperties, text: { type: 'string', required: true }, totalLines: { type: 'integer', required: true }, lineBegin: { type: 'integer', required: true }, lineEnd: { type: 'integer', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(boundTerminalResult(value, maxBytes)) }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('shared terminal tools require an initiating Agent')
        const request: SharedTerminalReadArgs = { offset: args.offset ?? 0, count: args.count ?? 500 }
        if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.count) || request.count < 1) throw new Error('offset must be a non-negative safe integer and count must be a positive safe integer')
        const result = await service.read(exec.agent, request, exec.signal)
        return boundTerminalResult({ ...common(result), ...result.page }, maxBytes)
      },
      presentCall: () => ({ card: 'generic', title: 'Read shared terminal', kind: 'read' }),
    }),
    defineTool({
      name: TERMINAL_TOOL_NAMES[2], description: 'Queue a signal to your shared terminal foreground process group. SIGKILL of the top-level shell is refused.',
      parameters: { signal: { type: 'string', required: true, enum: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        ...operationProperties, processGroupId: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(boundTerminalResult(value, maxBytes)) }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('shared terminal tools require an initiating Agent')
        const result = await service.signal(exec.agent, args, exec.signal)
        return boundTerminalResult({ ...common(result), output: result.output, queueTimeMs: result.queueTimeMs, waitReason: result.waitReason, processGroupId: result.processGroupId ?? null, truncated: result.outputTruncated || result.text.truncated }, maxBytes)
      },
      presentCall: args => ({ card: 'generic', title: `Signal shared terminal ${args.signal}`, kind: 'execute' }),
    }),
    defineTool({
      name: TERMINAL_TOOL_NAMES[3], description: 'Reset your shared terminal in FIFO order, terminating its current process and starting a fresh shell.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ...commonProperties, ...mutationProperties } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(boundTerminalResult(value, maxBytes)) }] },
      async execute(_args, exec) {
        if (!exec.agent) throw new Error('shared terminal tools require an initiating Agent')
        const result = await service.reset(exec.agent, exec.signal)
        return boundTerminalResult({ ...common(result), queueTimeMs: result.queueTimeMs, waitReason: result.waitReason }, maxBytes)
      },
      presentCall: () => ({ card: 'generic', title: 'Reset shared terminal', kind: 'delete' }),
    }),
  ]
  return definitions.map(closeRoot)
}

function closeRoot(definition: ToolDefinition): ToolDefinition {
  const keys = Object.keys(definition.parameters.properties ?? {})
  const extras = (args: unknown): string[] => args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).filter(key => !keys.includes(key)) : []
  return {
    ...definition,
    parameters: { ...definition.parameters, additionalProperties: false },
    execute(args, exec) {
      const unknown = extras(args)
      if (unknown.length) throw new ToolArgsError(unknown.map(key => `${key}: unexpected property`))
      return definition.execute(args, exec)
    },
    presentCall: args => extras(args).length ? undefined : definition.presentCall?.(args),
    presentResult: (args, result) => extras(args).length ? undefined : definition.presentResult?.(args, result),
  }
}

/**
 * Own tool and prompt registrations under the calling Cordis lifetime.
 * @param ctx - tool and system-prompt registries.
 * @param config - resolved deployment policy.
 * @returns Idempotent disposer for the complete consumer registration.
 */
export function registerTerminalTools(ctx: Context, config: Config): () => void {
  const definitions = createTerminalToolDefinitions(config, ctx.interactiveTerminals)
  return ctx.effect(() => {
    const disposers: Array<() => void> = []
    const dispose = () => { for (const remove of disposers.splice(0).reverse()) remove() }
    try {
      for (const definition of definitions) disposers.push(ctx.tools.register(definition))
      disposers.push(ctx.systemPrompt.section({ name: 'tool:shared-terminal', order: 107, text: 'shared_terminal_send, shared_terminal_read, shared_terminal_signal, and shared_terminal_reset address the current Agent’s single shared terminal. Prefer the existing Bash tool for one-shot commands. Human and model input share a FIFO queue; read bypasses input ownership. If send returns a human handoff, wait for the user to finish and do not send answers behind the human input lease. Reset destroys terminal state. A timeout does not prove the foreground command exited.' }))
    } catch (error) { dispose(); throw error }
    return dispose
  }, 'shared terminal tools and prompt')
}
