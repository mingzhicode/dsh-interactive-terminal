import "@deepseek-ai/dsh-client-connection";
import z from "@deepseek-ai/schemastery";
import { Context, Service } from "@deepseek-ai/cordis";
import { SandboxPolicyRequest, SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { WebSocket } from "ws";
import { Agent } from "@deepseek-ai/dsh-agent";
import { SubprocessOutcome, SubprocessRuntime, SubprocessTerminalSignal } from "@deepseek-ai/dsh-subprocess";
import { SandboxProvider } from "@deepseek-ai/dsh-sandbox";
import { Branded } from "@deepseek-ai/dsh-brand";
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
//#region src/config.d.ts
/** Deployment-controlled settings for terminal sessions. */
interface Config {
  shellPath: string;
  shellArgs: string[];
  rows: number;
  cols: number;
  scrollbackLines: number;
  scrollbackMaxBytes: number;
  maxToolOutputBytes: number;
  maxInputBytes: number;
  maxQueuedOperations: number;
  maxSessions: number;
  pollIntervalMs: number;
  operationTimeoutMs: number;
  interruptTimeoutMs: number;
  disconnectGraceMs: number;
  disposeGraceMs: number;
}
/** Schemastery schema that resolves every terminal deployment setting. */
declare const ConfigSchema: z<Config>;
//#endregion
//#region src/prompt.d.ts
/**
 * Recognizes one shell generation's prompt across arbitrary output chunks.
 * The nonce prevents incidental matches; it is not authentication against shell code.
 */
declare class ControlledPrompt {
  /** Random identifier shared by this generation's emitter and parser. */
  readonly nonce: string;
  /** Exact marker emitted before each primary Bash prompt. */
  readonly marker: string;
  /** Environment overrides for Bash launched with --noprofile --norc -i. */
  readonly env: Readonly<Record<'PROMPT_COMMAND' | 'PS1' | 'PS2', string>>;
  /** Exit status from the most recently completed primary prompt marker. */
  lastExitStatus: number | undefined;
  private suffix;
  private suffixObserver;
  private readonly prefix;
  /** Allocate a fresh marker for one shell generation. */
  constructor();
  /**
   * Count markers and retain each partial marker's starting observation.
   * @param output - decoded output from this shell generation, in order.
   * @param onPrompt - observation bound to the operation owning this output chunk.
   * @returns Number of newly completed primary prompt markers.
   */
  consume(output: string, onPrompt?: () => void): number;
}
//#endregion
//#region src/protocol.d.ts
/** Mutations sharing one terminal's exclusive input slot. */
type OperationKind = 'model-send' | 'human' | 'signal' | 'reset' | 'disconnect-recovery';
/** Availability of a terminal mutation queue. */
type QueueStatus = 'ready' | 'busy' | 'blocked' | 'exited' | 'disposed';
/** A granted model send that may transfer its current FIFO slot to a human. */
type TakeoverId = Branded<'TerminalTakeoverId'>;
/** The captured terminal contents delivered by a server snapshot. */
interface ScreenSnapshot {
  sequence: number;
  rows: number;
  cols: number;
  replay: string;
  historyBytes: number;
  truncated: boolean;
}
/** The top-level process state of an agent-owned terminal. */
type TerminalStatus = {
  kind: 'running';
} | {
  kind: 'exited';
  exitCode: number | null;
  signal: string | null;
};
//#endregion
//#region src/queue.d.ts
/** Internal completion reasons, including cancellation before or after admission. */
type WaitReason = 'prompt' | 'stdin_read' | 'session_exit' | 'timeout' | 'cancelled' | 'human_handoff';
/** Authoritative shell observations; arbitrary output is not an observation. */
type TerminalObservation = 'prompt' | 'stdin_read' | 'session_exit';
/** A caller identifier, unique among accepted operations, and its mutation kind. */
interface OperationRequest {
  id: string;
  kind: OperationKind;
}
/** The observation or recovery trigger that ended an accepted operation. */
interface OperationResult {
  waitReason: WaitReason;
}
/** Capacity and deadlines owned by the input queue. */
type QueueLimits = Pick<Config, 'maxQueuedOperations' | 'operationTimeoutMs' | 'interruptTimeoutMs'>;
/** A grant acknowledgment and the independent final outcome of one operation. */
interface EnqueuedOperation {
  /** Resolves after the granted callback finishes; rejects if it cannot run or fails. */
  readonly lease: Promise<void>;
  /** Settles after completion, cancellation, recovery, exit, or disposal. */
  readonly result: Promise<OperationResult>;
  /** Settles only when the queue slot is released, including after handoff. */
  readonly completion: Promise<OperationResult>;
  /**
   * Serialize another write within this granted human slot.
   * @param mutation - input delivery owned by the current human lease.
   * @returns Completion of that delivery; rejects if completion or recovery wins before dispatch.
   */
  append(mutation: () => void | Promise<void>): Promise<void>;
  /**
   * Submit an authoritative completion observation for this operation alone.
   * @param result - observed completion or requested recovery reason.
   */
  complete(result: OperationResult): void;
  /** Cancel this operation; active ownership lasts through SIGINT recovery. */
  cancel(): void;
}
/**
 * Owns a terminal's mutation slot until an authoritative observation or recovery.
 * Reads bypass this queue. Human input has no ordinary deadline; disconnect grace
 * belongs to the session layer, which cancels the active human after expiry.
 */
declare class OperationQueue {
  private readonly limits;
  private readonly interrupt;
  private readonly changed;
  private readonly pending;
  private active;
  private state;
  private timer;
  /**
   * @param limits - validated capacity and timeout settings.
   * @param interrupt - send SIGINT to the active foreground process group.
   * @param changed - synchronous state notification; the owning dispatcher contains listener errors.
   */
  constructor(limits: QueueLimits, interrupt: () => Promise<number>, changed?: () => void);
  /** @returns Current queue availability, including failed-recovery blocking. */
  status(): QueueStatus;
  /** @returns The current granted mutation identity, or null when no slot is owned. */
  holder(): OperationRequest | null;
  /** @returns The exact granted model send that may still transfer ownership. */
  takeoverId(): TakeoverId | null;
  /**
   * Transfer a granted model send to human ownership without releasing its FIFO slot.
   * @param target - exact currently published model operation.
   * @param signal - cancellation owned by the new human lease.
   * @returns A granted human-compatible handle whose result is the slot completion.
   */
  takeover(target: TakeoverId, signal?: AbortSignal): EnqueuedOperation;
  /**
   * Bind an asynchronous foreground observation to the current input dispatch.
   * @returns Observer that ignores completion after another dispatch or slot begins.
   */
  captureObservation(): (observation: Exclude<TerminalObservation, 'session_exit'>) => void;
  /**
   * Append a mutation in acceptance order, counting the active slot toward capacity.
   * @param request - unique accepted identifier and mutation kind.
   * @param grant - perform the mutation; reset replaces the shell generation here.
   * @param signal - optional caller cancellation; active cancellation requires recovery.
   * @returns Grant acknowledgment and final outcome, including admission failures.
   */
  enqueue(request: OperationRequest, grant: () => void | Promise<void>, signal?: AbortSignal): EnqueuedOperation;
  /**
   * Deliver an ordered observation from the current shell generation.
   * @param observation - verified primary prompt, foreground stdin wait, or exit.
   */
  observe(observation: TerminalObservation): void;
  /**
   * Cancel a currently accepted identifier, preserving all other FIFO positions.
   * @param id - identifier of the active or queued operation.
   */
  cancel(id: string): void;
  /** Settle every operation and remove deadlines and cancellation listeners. */
  dispose(): void;
  private pump;
  private granted;
  private complete;
  private progress;
  private cancelEntry;
  private recover;
  private sendInterrupt;
  private block;
  private append;
  private failed;
  private terminate;
  private settle;
  private settleResult;
  private handle;
  private settleLease;
  private clearTimer;
}
//#endregion
//#region src/screen.d.ts
/** Rendered active-buffer rows, with a zero-based viewport cursor. */
interface TerminalText {
  viewport: string;
  history: string[];
  cursor: {
    x: number;
    y: number;
  };
  truncated: boolean;
}
//#endregion
//#region src/terminal.d.ts
/** Agent session and the public services used to allocate its terminal. */
interface TerminalOwner {
  session: NonNullable<SandboxPolicyRequest['session']>;
  subprocess: Pick<SubprocessRuntime, 'spawnTerminal'>;
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>;
  sandbox?: Pick<SandboxProvider, 'confine'>;
}
/** Ordered screen output and terminal lifecycle notifications. */
type TerminalEvent = {
  type: 'state';
} | {
  type: 'output';
  output: string;
  sequence: number;
} | {
  type: 'status';
  status: TerminalStatus;
} | {
  type: 'error';
  error: unknown;
};
/** Owns independent queue, prompt recognition, screen, and process lifetime. */
declare class TerminalGeneration {
  readonly generation: number;
  readonly prompt: ControlledPrompt;
  private readonly handle;
  private readonly screen;
  private readonly cleanup;
  private readonly config;
  /** Mutation ownership belongs to this generation; grants call write or signalForeground. */
  readonly queue: OperationQueue;
  /** Resolves after process exit and final screen ingestion; rejects on transport failure. */
  readonly done: Promise<SubprocessOutcome>;
  private readonly listeners;
  private readonly ready;
  private readonly drained;
  private readonly decoder;
  private writes;
  private state;
  private finalSnapshot;
  private finalText;
  private readonly captures;
  private stopped;
  private disposal;
  private poll;
  private promptTimer;
  private pendingPrompt;
  private constructor();
  /**
   * Allocate a confined terminal and publish it only after its controlled prompt.
   * @param owner - owning session and mounted public DSH services.
   * @param config - validated deployment settings.
   * @param generation - caller-owned generation counter.
   * @param signal - cancellation through allocation and controlled-prompt startup.
   * @returns A ready terminal with independent queue, parser, and screen.
   */
  static create(owner: TerminalOwner, config: Config, generation: number, signal?: AbortSignal): Promise<TerminalGeneration>;
  /**
   * Write under a queue grant, without adding a newline.
   * @param input - exact terminal input text.
   * @returns Completion of transport delivery, not command completion.
   */
  write(input: string): Promise<void>;
  /**
   * Inspect then signal the foreground group; refuse SIGKILL of an observed shell.
   * Compatible providers resolve again before delivery and refuse shell SIGKILL there.
   * @param signal - supported terminal signal.
   * @returns Foreground group actually signalled by the provider.
   */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number>;
  /** @returns Current screen, or the retained final snapshot after teardown. */
  snapshot(): ScreenSnapshot;
  /** @returns Rendered active-buffer text retained after teardown. */
  text(): TerminalText;
  /**
   * Capture rendered output for one granted operation, bounded during ingestion.
   * @param id - queue identity owning subsequently received output.
   * @returns An idempotent finalizer that closes admission, drains received output, and releases its screen.
   */
  captureOutput(id: string): () => Promise<{
    output: string;
    truncated: boolean;
  }>;
  /** @returns Top-level process status, retained after disposal. */
  status(): TerminalStatus;
  /**
   * Subscribe to future events; consumers take a snapshot for initial state.
   * @param listener - observer whose exceptions cannot break terminal processing.
   * @returns Idempotent unsubscribe function.
   */
  subscribe(listener: (event: TerminalEvent) => void): () => void;
  /** Terminate exactly once, awaiting output ingestion and session quiescence. */
  dispose(): Promise<void>;
  private readonly onData;
  private readonly onEnd;
  private readonly onError;
  private ingest;
  private scheduleInspection;
  private inspectInput;
  private cursorFollowsPrompt;
  private schedulePrompt;
  private clearPendingPrompt;
  private stop;
  private assertRunning;
  private publish;
}
//#endregion
//#region src/service.d.ts
/** One published generation retained for its exact owner, including after exit. */
interface TerminalRecord {
  readonly owner: Agent;
  readonly generation: number;
  readonly terminal: TerminalGeneration;
}
/** Server facts; tool consumers own cleaned text and model-output budgets. */
interface TerminalReadResult {
  generation: number;
  snapshot: ScreenSnapshot;
  status: TerminalStatus;
  queueStatus: QueueStatus;
  text: TerminalText;
  holder: OperationKind | null;
  takeoverId: TakeoverId | null;
  pendingCount: number;
}
/** A newest-relative page of the rendered retained history. */
interface TerminalPageResult extends TerminalReadResult {
  page: {
    text: string;
    totalLines: number;
    lineBegin: number;
    lineEnd: number;
  };
}
/** Explicit retained-history page measured backward from the newest line. */
interface TerminalReadRequest {
  offset: number;
  count: number;
}
/** Explicit model input; tool consumers resolve the submit default. */
interface TerminalSendRequest {
  text: string;
  submit: boolean;
}
/** A queued foreground signal. */
interface TerminalSignalRequest {
  signal: SubprocessTerminalSignal;
}
/** Terminal facts after a queued mutation settles and its received output drains. */
interface TerminalOperationResult extends TerminalReadResult {
  waitReason: WaitReason;
  queueTimeMs: number;
  output: string;
  outputTruncated: boolean;
}
/** Human input authority valid only while its exact queue entry remains active. */
interface HumanLease {
  readonly done: Promise<TerminalOperationResult>;
  /** @param text - exact additional input. @returns Completion of this accepted write. */
  input(text: string): Promise<void>;
  /** @returns Settlement after SIGINT recovery; closes admission immediately. */
  cancel(): Promise<TerminalOperationResult>;
}
/** Generation-bound server attachment; sockets and controller ownership are separate consumers. */
interface TerminalAttachment {
  readonly generation: number;
  /** @returns Current or retained final generation facts, without queue admission. */
  read(): TerminalReadResult;
  /** @param listener - future generation events. @returns Unsubscribe function. */
  subscribe(listener: (event: TerminalEvent) => void): () => void;
  /** @param input - first atomic human input. @param signal - cancellation. @param queued - number of earlier accepted mutations, including the active holder. @returns Granted human lease. */
  begin(input: string, signal?: AbortSignal, queued?: (position: number) => void): Promise<HumanLease>;
  /** @param target - exact published model operation. @param signal - cancellation for the transferred human lease. @returns Granted in-place human lease. */
  takeover(target: TakeoverId, signal?: AbortSignal): Promise<HumanLease>;
}
/** Owner lifecycle and quiet admission changes consumed by generation-bound transports. */
type TerminalLifecycleEvent = {
  agent: Agent;
  type: 'reset' | 'disposed' | 'state';
};
declare module '@deepseek-ai/cordis' {
  interface Context {
    interactiveTerminals: InteractiveTerminalService;
  }
  interface Events {
    /** Resource ownership changed after its mutation. @mode emit */
    'interactive-terminal/ownership'(): void;
  }
}
/** Registered terminal service; every input mutation is granted by a generation queue. */
declare class InteractiveTerminalService extends Service {
  private readonly config;
  static inject: string[];
  static Config: import("@deepseek-ai/schemastery").default<Config>;
  private readonly records;
  private readonly creating;
  private readonly pendingOwners;
  private readonly live;
  private readonly bindings;
  private readonly disposedOwners;
  private readonly settledOwners;
  private disposal;
  private closed;
  private readonly listeners;
  /** @param ctx - mounted Cordis services. @param config - resolved deployment settings. */
  constructor(ctx: Context, config: Config);
  /** Pending and live owners, counted once across generation replacement. */
  get size(): number;
  /** @param listener - Lifecycle observer; owner disposal awaits disposed callbacks concurrently with process termination. @returns Idempotent unsubscribe. */
  subscribe(listener: (event: TerminalLifecycleEvent) => void | Promise<void>): () => void;
  /** @returns Copied counts from the authoritative owner bindings and live generation registry. */
  ownership(): ReadonlyArray<{
    readonly owner: Agent;
    readonly generations: readonly number[];
    readonly queued: number;
  }>;
  /** @param owner - exact Agent. @returns Whether owner cleanup or its whole scope has settled. */
  isDisposed(owner: Agent): boolean;
  /**
   * Bind calls to an exact Agent obtained from tool execution or the live registry.
   * @param agent - current live Agent object; same-id substitutes are rejected.
   * @returns Owner-bound methods, without accepting another identity from callers.
   */
  forAgent(agent: Agent): {
    ensure: (signal?: AbortSignal) => Promise<TerminalRecord>;
    read: (request: TerminalReadRequest, signal?: AbortSignal) => Promise<TerminalPageResult>;
    send: (request: TerminalSendRequest, signal?: AbortSignal) => Promise<TerminalOperationResult>;
    signal: (request: TerminalSignalRequest, signal?: AbortSignal) => Promise<TerminalOperationResult & {
      processGroupId: number | undefined;
    }>;
    reset: (signal?: AbortSignal) => Promise<TerminalReadResult & {
      queueTimeMs: number;
      waitReason: "prompt";
    }>;
    attach: () => Promise<TerminalAttachment>;
  };
  /**
   * Share one unpublished allocation and preserve an exited record until explicit reset.
   * @param agent - exact live owner.
   * @param signal - allocation cancellation; the initiating caller owns a shared creation.
   * @returns Published generation, or the retained exited generation.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<TerminalRecord>;
  /**
   * Read a retained-history page without waiting for mutation ownership.
   * @param agent - exact live owner.
   * @param request - explicit line offset and count; viewport stays complete.
   * @param signal - cancellation while awaiting lazy allocation.
   * @returns Screen, process, and queue facts.
   */
  read(agent: Agent, request: TerminalReadRequest, signal?: AbortSignal): Promise<TerminalPageResult>;
  /**
   * Queue one model write and await readiness or cancellation recovery.
   * @param agent - exact live owner.
   * @param request - input with resolved newline policy.
   * @param signal - queued removal or active SIGINT recovery.
   * @returns Terminal facts and the operation's settlement reason.
   */
  send(agent: Agent, request: TerminalSendRequest, signal?: AbortSignal): Promise<TerminalOperationResult>;
  /**
   * Queue a signal without bypassing earlier human or model input.
   * @param agent - exact live owner.
   * @param request - allowed foreground signal.
   * @param signal - operation cancellation.
   * @returns Settlement facts and the group actually signalled, when delivered.
   */
  signal(agent: Agent, request: TerminalSignalRequest, signal?: AbortSignal): Promise<TerminalOperationResult & {
    processGroupId: number | undefined;
  }>;
  /**
   * Admit a FIFO generation handoff; later mutations await its completion.
   * Cancellation before replacement retains the predecessor's outcome; a failed replacement blocks ordinary mutations until another reset.
   * @param agent - exact live owner.
   * @param signal - cancellation before grant or during replacement allocation.
   * @returns Fresh generation facts after the controlled startup prompt.
   */
  reset(agent: Agent, signal?: AbortSignal): Promise<TerminalReadResult & {
    queueTimeMs: number;
    waitReason: 'prompt';
  }>;
  /**
   * Attach reads and human leases to the current exact generation.
   * @param agent - live Agent resolved through the public registry by the Web consumer.
   * @returns Snapshot/subscription and queued human-input capabilities.
   */
  attach(agent: Agent): Promise<TerminalAttachment>;
  /**
   * Reject a mode change while this owner has pending or live process resources.
   * @param agent - exact owner whose session policy is being changed.
   */
  assertSandboxChangeAllowed(agent: Agent): void;
  /**
   * Fence further calls and await every resource owned by this exact Agent.
   * @param agent - owner being detached or explicitly closed.
   * @returns Completion after pending creation rollback and live process teardown.
   */
  disposeAgent(agent: Agent): Promise<void>;
  /** Stop intake and await reverse-creation-order cleanup, including pending allocations. */
  dispose(): Promise<void>;
  private ensureCurrent;
  private createRecord;
  private exited;
  private accept;
  private reserve;
  private publish;
  private binding;
  private assertOwner;
  private checkInput;
  private state;
  private settled;
}
//#endregion
//#region src/transport.d.ts
interface AttachToken {
  agent: Agent;
  expiresAt: number;
  epoch: number;
  readonly: boolean;
  resume: {
    controller: Controller;
    proof: string;
  } | 'invalid' | undefined;
}
interface HumanOperation {
  abort: AbortController;
  lease?: HumanLease;
  position?: number;
  done: Promise<void>;
}
interface Controller {
  agent: Agent;
  proof: string;
  socket: Connection | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  recovering: boolean;
  operation: HumanOperation | undefined;
}
interface Connection {
  socket: WebSocket;
  token: AttachToken;
  attachment?: TerminalAttachment;
  controller?: Controller;
  unsubscribe?: () => void;
  closing?: ReturnType<typeof setTimeout>;
  closed: Promise<void>;
  bufferLimit: number;
}
/** Owns public registrations, attach credentials, sockets, and disconnect recovery. */
declare class TerminalTransport {
  private readonly ctx;
  private readonly config;
  static inject: string[];
  private readonly tokens;
  private readonly epochs;
  private readonly controllers;
  private readonly connections;
  private readonly pending;
  private readonly lifetime;
  private readonly disposers;
  private readonly server;
  private timer;
  private stopped;
  private disposal;
  /** @param ctx - public host services. @param config - validated terminal settings. */
  constructor(ctx: Context, config: Config);
  /** @returns Counts derived from retained sockets and controller operations, grouped by exact Agent. */
  ownership(): ReadonlyArray<{
    readonly owner: Agent;
    readonly sockets: number;
    readonly pending: number;
  }>;
  /** @param agent - exact live owner. @param options - browser read-only intent and private reconnect proof. @returns One-use credential, valid for ten seconds. */
  issueToken(agent: Agent, options?: {
    readonly?: boolean;
    resume?: string;
  }): Promise<string>;
  /** @param raw - presented one-use secret. @param agent - exact expected owner. @returns Consumed owner-bound credential. */
  consumeToken(raw: string, agent: Agent): Promise<AttachToken>;
  /** @param request - same-origin upgrade request. @param socket - owned HTTP socket. @param head - unconsumed upgrade bytes. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Stop new work, revoke credentials, cancel existing human operations, and await cleanup. */
  dispose(): Promise<void>;
  private readonly rpc;
  private takeToken;
  private prune;
  private schedulePrune;
  private attach;
  private claim;
  private message;
  private begin;
  private takeover;
  private operate;
  private cancel;
  private disconnected;
  private recover;
  private revoke;
  private status;
  private error;
  private send;
  private close;
  private track;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    interactiveTerminalTransport: TerminalTransport;
  }
}
//#endregion
//#region src/index.d.ts
/** Loader plugin identity. */
declare const name = "dsh-interactive-terminal";
/** Host services used by the assembled plugin. */
declare const inject: string[];
/** @param ctx - Host plugin fiber. @param config - schema-resolved deployment settings. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ConfigSchema as Config, type InteractiveTerminalService, type TerminalTransport, apply, inject, name };