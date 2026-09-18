import "@deepseek-ai/dsh-client-connection";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { effectiveSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { createHash, randomBytes } from "node:crypto";
import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { SessionId } from "@deepseek-ai/dsh-session";
import { WebSocket, WebSocketServer } from "ws";
import { ToolArgsError, defineTool, validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from "@deepseek-ai/dsh-tools";
//#region src/config.ts
/**
* Validated deployment settings for the interactive terminal plugin.
*
* @module dsh-interactive-terminal/config
*/
/** Complete model JSON needs room for status, queue, cursor, and page metadata. */
const MIN_TOOL_OUTPUT_BYTES = 1024;
/** Complete default settings for an interactive terminal deployment. */
const DEFAULT_CONFIG = {
	shellPath: "/bin/bash",
	shellArgs: [
		"--noprofile",
		"--norc",
		"-i"
	],
	rows: 40,
	cols: 160,
	scrollbackLines: 1e4,
	scrollbackMaxBytes: 4194304,
	maxToolOutputBytes: 262144,
	maxInputBytes: 65536,
	maxQueuedOperations: 128,
	maxSessions: 32,
	pollIntervalMs: 50,
	operationTimeoutMs: 3e4,
	interruptTimeoutMs: 5e3,
	disconnectGraceMs: 15e3,
	disposeGraceMs: 3e3
};
/** Schemastery schema that resolves every terminal deployment setting. */
const ConfigSchema = z.object({
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
	disposeGraceMs: z.natural().min(1).default(DEFAULT_CONFIG.disposeGraceMs)
});
/**
* Reject unsupported operating systems and shells after validating the settings.
*
* @param config - resolved terminal deployment settings.
* @param platform - operating system to validate; defaults to the current host.
* @returns Nothing.
*/
function assertSupportedHost(config, platform = process.platform) {
	validateConfig(config);
	if (platform !== "darwin" && platform !== "linux") throw new Error("dsh-interactive-terminal supports only macOS and Linux");
	if (!/(^|\/)bash$/.test(config.shellPath)) throw new Error("dsh-interactive-terminal shellPath must name bash");
}
/**
* Validate cross-field and safe-integer requirements beyond schema parsing.
*
* @param config - resolved terminal deployment settings.
* @returns Nothing.
*/
function validateConfig(config) {
	if (config.maxToolOutputBytes < 1024) throw new Error(`dsh-interactive-terminal maxToolOutputBytes must be at least ${MIN_TOOL_OUTPUT_BYTES}`);
	if (config.shellPath.length === 0 || config.shellArgs.some((argument) => argument.length === 0)) throw new Error("dsh-interactive-terminal shell values must be non-empty");
	for (const [key, value] of Object.entries(config)) if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`dsh-interactive-terminal ${key} must be a positive safe integer`);
	if (config.maxToolOutputBytes > config.scrollbackMaxBytes) throw new Error("dsh-interactive-terminal maxToolOutputBytes must not exceed scrollbackMaxBytes");
}
//#endregion
//#region src/prompt.ts
/** Nonce-bearing Bash prompt emission and streaming recognition. */
/** OSC prefix reserved for the controlled Bash prompt marker. */
const PROMPT_MARKER_PREFIX = "\x1B]133;D;";
/**
* Recognizes one shell generation's prompt across arbitrary output chunks.
* The nonce prevents incidental matches; it is not authentication against shell code.
*/
var ControlledPrompt = class {
	/** Random identifier shared by this generation's emitter and parser. */
	nonce = randomBytes(24).toString("base64url");
	/** Exact marker emitted before each primary Bash prompt. */
	marker;
	/** Environment overrides for Bash launched with --noprofile --norc -i. */
	env;
	/** Exit status from the most recently completed primary prompt marker. */
	lastExitStatus;
	suffix = "";
	suffixObserver;
	prefix = `${PROMPT_MARKER_PREFIX}${this.nonce};`;
	/** Allocate a fresh marker for one shell generation. */
	constructor() {
		this.marker = `${this.prefix}0`;
		this.env = {
			PROMPT_COMMAND: `printf '\\033]133;D;${this.nonce};%s\\007' "$?"; PS1='dsh$ '`,
			PS1: "dsh$ ",
			PS2: "> "
		};
	}
	/**
	* Count markers and retain each partial marker's starting observation.
	* @param output - decoded output from this shell generation, in order.
	* @param onPrompt - observation bound to the operation owning this output chunk.
	* @returns Number of newly completed primary prompt markers.
	*/
	consume(output, onPrompt) {
		const previousLength = this.suffix.length;
		const previousObserver = this.suffixObserver;
		const text = this.suffix + output;
		let count = 0;
		let end = 0;
		const pattern = new RegExp(`${this.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([0-9]{1,3})`, "g");
		for (const match of text.matchAll(pattern)) {
			const status = Number(match[1]);
			if (status > 255) continue;
			count += 1;
			this.lastExitStatus = status;
			end = match.index + match[0].length;
			(match.index < previousLength ? previousObserver : onPrompt)?.();
		}
		const start = text.lastIndexOf("\x1B");
		const candidate = text.slice(start);
		const status = candidate.slice(this.prefix.length);
		const partial = start >= end && (this.prefix.startsWith(candidate) || candidate.startsWith(this.prefix) && /^[0-9]{0,3}$/.test(status) && Number(status) <= 255);
		this.suffix = partial ? candidate : "";
		this.suffixObserver = partial ? start < previousLength ? previousObserver : onPrompt : void 0;
		return count;
	}
};
/**
* Build explicit environment overrides without inheriting harness credentials.
* @param sessionId - owning session's diagnostic identifier.
* @returns Environment and the sole parser for its emitted markers.
*/
function createPromptEnvironment(sessionId) {
	const prompt = new ControlledPrompt();
	return {
		nonce: prompt.nonce,
		prompt,
		env: {
			...prompt.env,
			TERM: "dumb",
			PAGER: "cat",
			GIT_PAGER: "cat",
			DSH_SHELL: "1",
			DSH_SESSION_ID: sessionId
		}
	};
}
//#endregion
//#region src/protocol.ts
/**
* Prove a discriminated union has no unhandled members.
*
* @param value - impossible value from an exhaustive switch.
* @returns Never returns.
*/
function assertNever(value) {
	throw new Error(`Unexpected frame: ${JSON.stringify(value)}`);
}
//#endregion
//#region src/queue.ts
/** Failed foreground recovery, retaining the cancellation or deadline that triggered it. */
var RecoveryError = class extends Error {
	waitReason;
	/**
	* @param waitReason - reason the active operation entered recovery.
	* @param cause - transport failure, when SIGINT delivery itself failed.
	*/
	constructor(waitReason, cause) {
		super(`terminal recovery failed after ${waitReason}; queue is blocked until reset`, { cause });
		this.waitReason = waitReason;
		this.name = "RecoveryError";
	}
};
var ClosedAppendError = class extends Error {
	constructor() {
		super("human lease is closed");
	}
};
/**
* Owns a terminal's mutation slot until an authoritative observation or recovery.
* Reads bypass this queue. Human input has no ordinary deadline; disconnect grace
* belongs to the session layer, which cancels the active human after expiry.
*/
var OperationQueue = class {
	limits;
	interrupt;
	changed;
	pending = [];
	active;
	state = "ready";
	timer;
	/**
	* @param limits - validated capacity and timeout settings.
	* @param interrupt - send SIGINT to the active foreground process group.
	* @param changed - synchronous state notification; the owning dispatcher contains listener errors.
	*/
	constructor(limits, interrupt, changed = () => void 0) {
		this.limits = limits;
		this.interrupt = interrupt;
		this.changed = changed;
	}
	/** @returns Current queue availability, including failed-recovery blocking. */
	status() {
		return this.state;
	}
	/** @returns The current granted mutation identity, or null when no slot is owned. */
	holder() {
		return this.active ? { ...this.active.request } : null;
	}
	/** @returns The exact granted model send that may still transfer ownership. */
	takeoverId() {
		const entry = this.active;
		return entry?.request.kind === "model-send" && entry.granted && !entry.recovery && !entry.completion && !entry.resultSettled ? entry.request.id : null;
	}
	/**
	* Transfer a granted model send to human ownership without releasing its FIFO slot.
	* @param target - exact currently published model operation.
	* @param signal - cancellation owned by the new human lease.
	* @returns A granted human-compatible handle whose result is the slot completion.
	*/
	takeover(target, signal) {
		if (signal?.aborted) throw new Error("terminal takeover is not available");
		const entry = this.active;
		if (!entry || this.takeoverId() !== target) throw new Error("terminal takeover is not available");
		this.clearTimer();
		entry.removeAbort?.();
		delete entry.removeAbort;
		entry.request = {
			...entry.request,
			kind: "human"
		};
		entry.authority = {};
		entry.handedOff = true;
		this.settleResult(entry, { waitReason: "human_handoff" });
		if (signal) {
			const authority = entry.authority;
			const abort = () => this.cancelEntry(entry, authority);
			signal.addEventListener("abort", abort, { once: true });
			entry.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.changed();
		return this.handle(entry, entry.authority, entry.completionPromise);
	}
	/**
	* Bind an asynchronous foreground observation to the current input dispatch.
	* @returns Observer that ignores completion after another dispatch or slot begins.
	*/
	captureObservation() {
		const entry = this.active;
		const dispatch = entry?.dispatch;
		return (observation) => {
			if (entry && entry.dispatch === dispatch) this.complete(entry, { waitReason: observation });
		};
	}
	/**
	* Append a mutation in acceptance order, counting the active slot toward capacity.
	* @param request - unique accepted identifier and mutation kind.
	* @param grant - perform the mutation; reset replaces the shell generation here.
	* @param signal - optional caller cancellation; active cancellation requires recovery.
	* @returns Grant acknowledgment and final outcome, including admission failures.
	*/
	enqueue(request, grant, signal) {
		let resolveLease;
		let rejectLease;
		let resolveResult;
		let rejectResult;
		let resolveCompletion;
		let rejectCompletion;
		const lease = new Promise((resolve, reject) => {
			resolveLease = resolve;
			rejectLease = reject;
		});
		const result = new Promise((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const completion = new Promise((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		lease.catch(() => void 0);
		result.catch(() => void 0);
		completion.catch(() => void 0);
		const authority = {};
		const entry = {
			request: { ...request },
			grant,
			lease,
			completionPromise: completion,
			resolveLease,
			rejectLease,
			resolveResult,
			rejectResult,
			resolveCompletion,
			rejectCompletion,
			settled: false,
			resultSettled: false,
			leaseSettled: false,
			granted: false,
			writes: 0,
			writeTail: Promise.resolve(),
			dispatch: 0,
			authority,
			handedOff: false
		};
		const handle = this.handle(entry, authority, result);
		let error;
		if (this.state === "disposed" || this.state === "exited") error = /* @__PURE__ */ new Error(`terminal queue is ${this.state}`);
		else if (signal?.aborted) error = /* @__PURE__ */ new Error("terminal operation cancelled");
		else if (this.active?.request.id === request.id || this.pending.some((item) => item.request.id === request.id)) error = /* @__PURE__ */ new Error("duplicate terminal operation id");
		else if (this.pending.length + Number(this.active !== void 0) >= this.limits.maxQueuedOperations) error = /* @__PURE__ */ new Error("terminal queue is full");
		if (error) {
			this.settle(entry, { waitReason: "cancelled" }, error);
			return handle;
		}
		if (signal) {
			const abort = () => this.cancelEntry(entry, authority);
			signal.addEventListener("abort", abort, { once: true });
			entry.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.pending.push(entry);
		this.pump();
		this.changed();
		return handle;
	}
	/**
	* Deliver an ordered observation from the current shell generation.
	* @param observation - verified primary prompt, foreground stdin wait, or exit.
	*/
	observe(observation) {
		if (this.state === "disposed" || this.state === "exited") return;
		switch (observation) {
			case "session_exit":
				this.terminate("exited", { waitReason: "session_exit" });
				return;
			case "prompt":
			case "stdin_read":
				if (this.active) this.complete(this.active, { waitReason: observation });
				return;
			default: assertNever(observation);
		}
	}
	/**
	* Cancel a currently accepted identifier, preserving all other FIFO positions.
	* @param id - identifier of the active or queued operation.
	*/
	cancel(id) {
		const entry = this.active?.request.id === id ? this.active : this.pending.find((item) => item.request.id === id);
		if (entry) this.cancelEntry(entry);
	}
	/** Settle every operation and remove deadlines and cancellation listeners. */
	dispose() {
		if (this.state !== "disposed") this.terminate("disposed", { waitReason: "cancelled" });
	}
	pump() {
		if (this.active || this.state === "disposed" || this.state === "exited") return;
		let next;
		while (next = this.pending.shift()) {
			if (this.state === "blocked" && next.request.kind !== "reset") {
				this.settle(next, { waitReason: "cancelled" }, /* @__PURE__ */ new Error("terminal queue is blocked until reset"));
				continue;
			}
			this.active = next;
			this.state = "busy";
			this.changed();
			const entry = next;
			switch (entry.request.kind) {
				case "model-send":
				case "signal":
				case "reset":
					this.timer = setTimeout(() => this.recover(entry, "timeout"), this.limits.operationTimeoutMs);
					break;
				case "human":
				case "disconnect-recovery": break;
				default: assertNever(entry.request.kind);
			}
			try {
				const granted = entry.grant();
				Promise.resolve(granted).then(() => this.granted(entry), (error) => this.failed(entry, error));
			} catch (error) {
				this.failed(entry, error);
			}
			return;
		}
	}
	granted(entry) {
		if (entry.settled) return;
		entry.granted = true;
		this.settleLease(entry);
		if (entry.recovery) this.sendInterrupt(entry);
		else if (entry.request.kind === "disconnect-recovery") this.recover(entry, "cancelled");
		else if (entry.request.kind === "reset") entry.completion = { waitReason: "prompt" };
		this.progress(entry);
		this.changed();
	}
	complete(entry, result, authority) {
		if (authority && entry.authority !== authority) return;
		if (entry !== this.active || entry.settled) return;
		switch (result.waitReason) {
			case "session_exit":
				this.observe("session_exit");
				return;
			case "cancelled":
			case "timeout":
				this.recover(entry, result.waitReason);
				return;
			case "prompt":
				if (entry.recovery) {
					if (entry.recovery.started && entry.writes === 0) entry.recovery.prompt = true;
				} else if (entry.request.kind !== "reset") entry.completion ??= result;
				break;
			case "stdin_read":
				if (!entry.recovery && (entry.request.kind === "model-send" || entry.request.kind === "signal")) entry.completion ??= result;
				break;
			case "human_handoff": return;
			default: assertNever(result.waitReason);
		}
		this.progress(entry);
	}
	progress(entry) {
		if (entry !== this.active || !entry.granted || entry.writes > 0) return;
		const recovery = entry.recovery;
		if (recovery) {
			if (!recovery.interrupted || !recovery.prompt) return;
			this.settle(entry, { waitReason: recovery.reason });
		} else {
			if (!entry.completion) return;
			this.settle(entry, entry.completion);
		}
		this.state = "ready";
		this.pump();
		this.changed();
	}
	cancelEntry(entry, authority) {
		if (authority && entry.authority !== authority) return;
		if (entry.settled) return;
		if (entry === this.active) this.recover(entry, "cancelled");
		else {
			const index = this.pending.indexOf(entry);
			if (index < 0) return;
			this.pending.splice(index, 1);
			this.settle(entry, { waitReason: "cancelled" });
		}
	}
	recover(entry, reason) {
		if (entry !== this.active || entry.recovery || entry.settled) return;
		this.clearTimer();
		entry.recovery = {
			reason,
			started: false,
			interrupted: false,
			prompt: false
		};
		if (entry.granted && entry.writes === 0) this.sendInterrupt(entry);
	}
	sendInterrupt(entry) {
		const recovery = entry.recovery;
		if (!recovery || recovery.started) return;
		recovery.started = true;
		entry.dispatch += 1;
		try {
			this.interrupt().then(() => {
				if (entry.settled) return;
				recovery.interrupted = true;
				this.timer = setTimeout(() => this.block(entry), this.limits.interruptTimeoutMs);
				this.progress(entry);
			}, (error) => this.block(entry, error));
		} catch (error) {
			this.block(entry, error);
		}
	}
	block(entry, cause) {
		if (entry !== this.active || !entry.recovery) return;
		this.state = "blocked";
		this.settle(entry, { waitReason: entry.recovery.reason }, new RecoveryError(entry.recovery.reason, cause));
		this.pump();
	}
	async append(entry, authority, mutation) {
		if (entry.authority !== authority) throw new Error("human lease is closed");
		if (entry.settled || entry.recovery || entry.completion) throw new Error("human lease is closed");
		if (entry.request.kind !== "human") throw new Error("append requires a human lease");
		if (entry !== this.active || !entry.granted) throw new Error("human lease is not granted");
		entry.writes += 1;
		const write = entry.writeTail.then(() => {
			if (entry.settled || entry.recovery || entry.handedOff && entry.completion) throw new ClosedAppendError();
			entry.dispatch += 1;
			delete entry.completion;
			return mutation();
		}).then(() => {
			entry.writes -= 1;
			if (entry.settled) return;
			if (entry.recovery && entry.writes === 0) this.sendInterrupt(entry);
			this.progress(entry);
		}, (error) => {
			entry.writes -= 1;
			if (error instanceof ClosedAppendError) {
				if (!entry.settled) {
					if (entry.recovery && entry.writes === 0) this.sendInterrupt(entry);
					this.progress(entry);
				}
				throw error;
			}
			this.failed(entry, error);
			throw error;
		});
		entry.writeTail = write;
		return write;
	}
	failed(entry, error) {
		if (entry.settled) return;
		this.state = "blocked";
		this.settle(entry, { waitReason: "cancelled" }, error instanceof Error ? error : new Error(String(error)));
		this.pump();
	}
	terminate(state, result) {
		this.state = state;
		if (this.active) this.settle(this.active, result, void 0, `terminal queue is ${state}`);
		for (const entry of this.pending.splice(0)) this.settle(entry, result, void 0, `terminal queue is ${state}`);
	}
	settle(entry, result, error, leaseError) {
		if (entry.settled) return;
		entry.settled = true;
		if (entry === this.active) {
			this.clearTimer();
			this.active = void 0;
		}
		entry.removeAbort?.();
		this.settleLease(entry, error ?? new Error(leaseError ?? `terminal operation ${result.waitReason}`));
		this.settleResult(entry, result, error);
		if (error) entry.rejectCompletion(error);
		else entry.resolveCompletion(result);
		this.changed();
	}
	settleResult(entry, result, error) {
		if (entry.resultSettled) return;
		entry.resultSettled = true;
		if (error) entry.rejectResult(error);
		else entry.resolveResult(result);
	}
	handle(entry, authority, result) {
		return {
			lease: entry.lease,
			result,
			completion: entry.completionPromise,
			append: (mutation) => this.append(entry, authority, mutation),
			complete: (value) => this.complete(entry, value, authority),
			cancel: () => this.cancelEntry(entry, authority)
		};
	}
	settleLease(entry, error) {
		if (entry.leaseSettled) return;
		entry.leaseSettled = true;
		if (error) entry.rejectLease(error);
		else entry.resolveLease();
	}
	clearTimer() {
		clearTimeout(this.timer);
		this.timer = void 0;
	}
};
//#endregion
//#region src/screen.ts
/**
* Bounded, server-authoritative terminal screen state.
*
* @module dsh-interactive-terminal/screen
*/
/**
* Retains xterm state and serializes bounded snapshots for terminal clients.
*/
var TerminalScreen = class {
	options;
	terminal;
	serializeAddon = new SerializeAddon();
	sequence = 0;
	firstLine;
	/**
	* @param options - terminal viewport, retained-line, and history-byte limits.
	*/
	constructor(options) {
		this.options = options;
		this.terminal = new headless.Terminal({
			allowProposedApi: true,
			rows: options.rows,
			cols: options.cols,
			scrollback: options.scrollbackLines
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.firstLine = this.terminal.registerMarker(0);
	}
	/**
	* Ingest terminal output before advancing the snapshot watermark.
	*
	* @param output - decoded terminal output from the host process.
	* @returns The new sequence number after xterm has ingested the output.
	*/
	async write(output) {
		await new Promise((resolve) => this.terminal.write(output, resolve));
		return ++this.sequence;
	}
	/**
	* Replay both buffers and cursor with the largest whole-line history within its byte limit.
	*
	* @returns Bounded terminal contents and its monotonic sequence number.
	*/
	snapshot() {
		const baseY = this.terminal.buffer.normal.baseY;
		const availableLines = Math.min(this.options.scrollbackLines, baseY);
		let lower = 0;
		let upper = availableLines;
		while (lower < upper) {
			const candidate = Math.ceil((lower + upper) / 2);
			if (Buffer.byteLength(this.serializeHistory(candidate, baseY)) <= this.options.scrollbackMaxBytes) lower = candidate;
			else upper = candidate - 1;
		}
		return {
			sequence: this.sequence,
			rows: this.options.rows,
			cols: this.options.cols,
			replay: this.serializeAddon.serialize({ scrollback: lower }),
			historyBytes: Buffer.byteLength(this.serializeHistory(lower, baseY)),
			truncated: lower < availableLines || this.firstLine.isDisposed
		};
	}
	/** @returns Plain active-buffer rows; history keeps whole rows within its byte budget. */
	text() {
		const buffer = this.terminal.buffer.active;
		const history = [];
		let bytes = 0;
		let start = buffer.baseY;
		while (start > 0) {
			const line = buffer.getLine(start - 1).translateToString(true);
			const size = Buffer.byteLength(line) + Number(history.length > 0);
			if (bytes + size > this.options.scrollbackMaxBytes) break;
			history.push(line);
			bytes += size;
			start -= 1;
		}
		return {
			viewport: Array.from({ length: this.options.rows }, (_, index) => buffer.getLine(buffer.baseY + index).translateToString(true)).join("\n"),
			history: history.reverse(),
			cursor: {
				x: buffer.cursorX,
				y: buffer.cursorY
			},
			truncated: start > 0 || buffer.type === "normal" && this.firstLine.isDisposed
		};
	}
	/** Release the serialize add-on before disposing its terminal. */
	dispose() {
		this.serializeAddon.dispose();
		this.terminal.dispose();
	}
	serializeHistory(lines, baseY) {
		if (lines === 0) return "";
		return this.serializeAddon.serialize({
			range: {
				start: baseY - lines,
				end: baseY - 1
			},
			excludeAltBuffer: true,
			excludeModes: true
		});
	}
};
/**
* Keep the newest UTF-8 suffix without splitting an encoded character.
*
* @param text - plain text to bound.
* @param maxBytes - maximum UTF-8 byte length to retain.
* @returns The retained suffix and whether bytes were omitted.
*/
function truncateUtf8Tail(text, maxBytes) {
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= maxBytes) return {
		text,
		truncated: false
	};
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && (bytes[start] & 192) === 128) start += 1;
	return {
		text: bytes.subarray(start).toString("utf8"),
		truncated: true
	};
}
//#endregion
//#region src/terminal.ts
/** Owns independent queue, prompt recognition, screen, and process lifetime. */
var TerminalGeneration = class TerminalGeneration {
	generation;
	prompt;
	handle;
	screen;
	cleanup;
	config;
	/** Mutation ownership belongs to this generation; grants call write or signalForeground. */
	queue;
	/** Resolves after process exit and final screen ingestion; rejects on transport failure. */
	done;
	listeners = /* @__PURE__ */ new Set();
	ready = Promise.withResolvers();
	drained = Promise.withResolvers();
	decoder = new TextDecoder();
	writes = Promise.resolve();
	state = { kind: "running" };
	finalSnapshot;
	finalText;
	captures = /* @__PURE__ */ new Map();
	stopped = false;
	disposal;
	poll;
	promptTimer;
	pendingPrompt;
	constructor(generation, prompt, handle, screen, cleanup, config) {
		this.generation = generation;
		this.prompt = prompt;
		this.handle = handle;
		this.screen = screen;
		this.cleanup = cleanup;
		this.config = config;
		this.queue = new OperationQueue(config, () => this.signalForeground("SIGINT"), () => this.publish({ type: "state" }));
		this.done = Promise.all([handle.done, this.drained.promise]).then(([outcome]) => {
			this.state = {
				kind: "exited",
				...outcome
			};
			this.queue.observe("session_exit");
			this.finalSnapshot ??= this.screen.snapshot();
			clearTimeout(this.poll);
			this.ready.reject(/* @__PURE__ */ new Error("terminal exited during startup"));
			this.publish({
				type: "status",
				status: this.state
			});
			return outcome;
		}, (error) => {
			this.ready.reject(error);
			this.queue.observe("session_exit");
			this.publish({
				type: "error",
				error
			});
			throw error;
		});
		this.done.catch(() => this.dispose()).catch((error) => process.emitWarning(String(error)));
		this.ready.promise.catch(() => void 0);
		cleanup.push(() => this.stop());
		handle.output.on("data", this.onData);
		handle.output.once("end", this.onEnd);
		handle.output.on("error", this.onError);
		this.scheduleInspection();
	}
	/**
	* Allocate a confined terminal and publish it only after its controlled prompt.
	* @param owner - owning session and mounted public DSH services.
	* @param config - validated deployment settings.
	* @param generation - caller-owned generation counter.
	* @param signal - cancellation through allocation and controlled-prompt startup.
	* @returns A ready terminal with independent queue, parser, and screen.
	*/
	static async create(owner, config, generation, signal) {
		signal?.throwIfAborted();
		assertSupportedHost(config);
		const policy = owner.sandboxPolicy.resolve({ session: owner.session });
		let argv = [config.shellPath, ...config.shellArgs];
		if (policy.mode !== "danger-full-access") {
			if (!owner.sandbox) throw new Error(`sandbox unavailable for ${policy.mode}`);
			argv = owner.sandbox.confine(argv, {
				...policy,
				mode: policy.mode
			}).argv;
		}
		const environment = createPromptEnvironment(String(owner.session.id));
		const handle = await owner.subprocess.spawnTerminal({
			argv,
			cwd: policy.workspaceRoot,
			env: environment.env,
			rows: config.rows,
			cols: config.cols,
			graceMs: config.disposeGraceMs,
			signal
		});
		handle.done.catch(() => void 0);
		const cleanup = [() => handle.terminate()];
		let terminal;
		let timer;
		const cancelled = Promise.withResolvers();
		const abort = () => cancelled.reject(signal?.reason ?? /* @__PURE__ */ new Error("terminal startup cancelled"));
		try {
			signal?.throwIfAborted();
			const screen = new TerminalScreen(config);
			cleanup.push(() => screen.dispose());
			terminal = new TerminalGeneration(generation, environment.prompt, handle, screen, cleanup, config);
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => cancelled.reject(/* @__PURE__ */ new Error("terminal startup timed out before controlled prompt")), config.operationTimeoutMs);
			await Promise.race([terminal.ready.promise, cancelled.promise]);
			signal?.throwIfAborted();
			if (terminal.stopped || terminal.state.kind === "exited") throw new Error("terminal exited during startup");
			terminal.clearPendingPrompt();
			return terminal;
		} catch (error) {
			try {
				if (terminal) await terminal.dispose();
				else await rollback(cleanup);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "terminal startup and rollback failed");
			}
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
	/**
	* Write under a queue grant, without adding a newline.
	* @param input - exact terminal input text.
	* @returns Completion of transport delivery, not command completion.
	*/
	async write(input) {
		this.assertRunning();
		await this.handle.write(input);
	}
	/**
	* Inspect then signal the foreground group; refuse SIGKILL of an observed shell.
	* Compatible providers resolve again before delivery and refuse shell SIGKILL there.
	* @param signal - supported terminal signal.
	* @returns Foreground group actually signalled by the provider.
	*/
	async signalForeground(signal) {
		this.assertRunning();
		const foreground = await this.handle.inspectForeground();
		this.assertRunning();
		if (!foreground) throw new Error("terminal foreground group unavailable");
		if (signal === "SIGKILL" && foreground.processGroupId === this.handle.pid) throw new Error("refusing SIGKILL of top-level shell");
		return this.handle.signalForeground(signal);
	}
	/** @returns Current screen, or the retained final snapshot after teardown. */
	snapshot() {
		return this.finalSnapshot ?? this.screen.snapshot();
	}
	/** @returns Rendered active-buffer text retained after teardown. */
	text() {
		return this.finalText ?? this.screen.text();
	}
	/**
	* Capture rendered output for one granted operation, bounded during ingestion.
	* @param id - queue identity owning subsequently received output.
	* @returns An idempotent finalizer that closes admission, drains received output, and releases its screen.
	*/
	captureOutput(id) {
		const screen = new TerminalScreen({
			...this.config,
			rows: 1,
			scrollbackLines: Math.max(1, Math.min(this.config.scrollbackLines, Math.floor(this.config.maxToolOutputBytes / (4 * this.config.cols)))),
			scrollbackMaxBytes: this.config.maxToolOutputBytes
		});
		const capture = {
			screen,
			pending: Promise.resolve()
		};
		this.captures.set(id, capture);
		let result;
		return () => {
			if (result) return result;
			this.captures.delete(id);
			result = capture.pending.then(() => {
				const text = screen.text();
				const bounded = truncateUtf8Tail([...text.history, text.viewport].join("\n"), this.config.maxToolOutputBytes);
				return {
					output: bounded.text,
					truncated: bounded.truncated || text.truncated
				};
			}).finally(() => screen.dispose());
			return result;
		};
	}
	/** @returns Top-level process status, retained after disposal. */
	status() {
		return this.state;
	}
	/**
	* Subscribe to future events; consumers take a snapshot for initial state.
	* @param listener - observer whose exceptions cannot break terminal processing.
	* @returns Idempotent unsubscribe function.
	*/
	subscribe(listener) {
		if (!this.stopped) this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** Terminate exactly once, awaiting output ingestion and session quiescence. */
	dispose() {
		this.disposal ??= rollback(this.cleanup);
		return this.disposal;
	}
	onData = (chunk) => {
		const observe = this.queue.captureObservation();
		const operationId = this.queue.holder()?.id;
		const capture = operationId === void 0 ? void 0 : this.captures.get(operationId);
		this.handle.output.pause();
		this.writes = this.writes.then(async () => {
			await this.ingest(this.decoder.decode(chunk, { stream: true }), observe, capture);
		}).catch(this.onError).finally(() => {
			if (this.stopped) return;
			const output = this.handle.output;
			if (output.readableLength > 0) output.read(Math.min(output.readableLength, output.readableHighWaterMark));
			else output.resume();
		});
		if (capture) capture.pending = this.writes;
	};
	onEnd = () => {
		const observe = this.queue.captureObservation();
		const operationId = this.queue.holder()?.id;
		const capture = operationId === void 0 ? void 0 : this.captures.get(operationId);
		this.writes = this.writes.then(async () => {
			await this.ingest(this.decoder.decode(), observe, capture);
		}).then(() => this.drained.resolve(), this.onError);
		if (capture) capture.pending = this.writes;
	};
	onError = (error) => {
		this.ready.reject(error);
		this.drained.reject(error);
	};
	async ingest(output, observe, capture) {
		if (output.length === 0) return;
		clearTimeout(this.promptTimer);
		const sequence = await this.screen.write(output);
		if (capture) await capture.screen.write(output);
		if (this.stopped) return;
		this.publish({
			type: "output",
			output,
			sequence
		});
		if (this.prompt.consume(output, () => {
			this.pendingPrompt = () => observe("prompt");
		}) > 0) this.ready.resolve();
		if (this.pendingPrompt) this.schedulePrompt(this.pendingPrompt);
	}
	scheduleInspection() {
		this.poll = setTimeout(async () => {
			await this.inspectInput();
			if (!this.stopped && this.state.kind === "running") this.scheduleInspection();
		}, this.config.pollIntervalMs);
	}
	async inspectInput() {
		if (this.stopped || this.state.kind === "exited" || this.queue.status() !== "busy") return;
		const observe = this.queue.captureObservation();
		try {
			const foreground = await this.handle.inspectForeground();
			if (!this.stopped && this.state.kind === "running" && foreground?.inputWaiting && foreground.processGroupId !== this.handle.pid) observe("stdin_read");
		} catch (error) {
			if (!this.stopped) this.publish({
				type: "error",
				error
			});
		}
	}
	cursorFollowsPrompt() {
		const { viewport, cursor } = this.screen.text();
		return (viewport.split("\n")[cursor.y] ?? "").slice(0, cursor.x).endsWith(this.prompt.env.PS1);
	}
	schedulePrompt(candidate) {
		this.promptTimer = setTimeout(() => {
			if (this.stopped || this.state.kind === "exited" || this.pendingPrompt !== candidate || !this.cursorFollowsPrompt()) return;
			this.pendingPrompt = void 0;
			candidate();
		}, this.config.pollIntervalMs);
	}
	clearPendingPrompt() {
		clearTimeout(this.promptTimer);
		this.promptTimer = void 0;
		this.pendingPrompt = void 0;
	}
	async stop() {
		this.stopped = true;
		this.listeners.clear();
		clearTimeout(this.poll);
		this.clearPendingPrompt();
		this.queue.dispose();
		this.handle.output.off("data", this.onData);
		this.handle.output.off("end", this.onEnd);
		await this.writes;
		this.finalSnapshot ??= this.screen.snapshot();
		this.finalText ??= this.screen.text();
		this.drained.resolve();
		this.cleanup.unshift(() => {
			this.handle.output.off("error", this.onError);
		});
	}
	assertRunning() {
		if (this.stopped || this.state.kind === "exited") throw new Error(`terminal is ${this.stopped ? "disposed" : "exited"}`);
	}
	publish(event) {
		for (const listener of this.listeners) try {
			listener(event);
		} catch (error) {
			process.emitWarning(`terminal listener failed: ${String(error)}`);
		}
	}
};
async function rollback(cleanup) {
	const errors = [];
	let release;
	while (release = cleanup.pop()) try {
		await release();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length) throw new AggregateError(errors, "terminal rollback failed");
}
//#endregion
//#region src/service.ts
/** Exact-Agent terminal ownership, generation handoff, and Cordis lifetime fences. */
/** Registered terminal service; every input mutation is granted by a generation queue. */
var InteractiveTerminalService = class extends Service {
	config;
	static inject = [
		"agents",
		"subprocess",
		"sandboxPolicy"
	];
	static Config = ConfigSchema;
	records = /* @__PURE__ */ new WeakMap();
	creating = /* @__PURE__ */ new WeakMap();
	pendingOwners = /* @__PURE__ */ new Set();
	live = /* @__PURE__ */ new Set();
	bindings = /* @__PURE__ */ new Map();
	disposedOwners = /* @__PURE__ */ new WeakSet();
	settledOwners = /* @__PURE__ */ new WeakSet();
	disposal;
	closed = false;
	listeners = /* @__PURE__ */ new Set();
	/** @param ctx - mounted Cordis services. @param config - resolved deployment settings. */
	constructor(ctx, config) {
		super(ctx, "interactiveTerminals");
		this.config = config;
		validateConfig(config);
		ctx.on("agent/disposed", ({ agent }) => this.disposeAgent(agent));
		ctx.effect(() => () => this.dispose(), "interactive terminal teardown");
	}
	/** Pending and live owners, counted once across generation replacement. */
	get size() {
		return (/* @__PURE__ */ new Set([...this.pendingOwners, ...[...this.live].map((record) => record.owner)])).size;
	}
	/** @param listener - Lifecycle observer; owner disposal awaits disposed callbacks concurrently with process termination. @returns Idempotent unsubscribe. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** @returns Copied counts from the authoritative owner bindings and live generation registry. */
	ownership() {
		return [.../* @__PURE__ */ new Set([
			...this.bindings.keys(),
			...this.pendingOwners,
			...[...this.live].map((record) => record.owner)
		])].map((owner) => ({
			owner,
			generations: [...this.live].filter((record) => record.owner === owner).map((record) => record.generation),
			queued: this.bindings.get(owner)?.accepted ?? 0
		}));
	}
	/** @param owner - exact Agent. @returns Whether owner cleanup or its whole scope has settled. */
	isDisposed(owner) {
		return this.settledOwners.has(owner) || owner.ctx.fiber.uid === null && owner.ctx.fiber.inertia === void 0;
	}
	/**
	* Bind calls to an exact Agent obtained from tool execution or the live registry.
	* @param agent - current live Agent object; same-id substitutes are rejected.
	* @returns Owner-bound methods, without accepting another identity from callers.
	*/
	forAgent(agent) {
		this.binding(agent);
		return {
			ensure: (signal) => this.ensure(agent, signal),
			read: (request, signal) => this.read(agent, request, signal),
			send: (request, signal) => this.send(agent, request, signal),
			signal: (request, signal) => this.signal(agent, request, signal),
			reset: (signal) => this.reset(agent, signal),
			attach: () => this.attach(agent)
		};
	}
	/**
	* Share one unpublished allocation and preserve an exited record until explicit reset.
	* @param agent - exact live owner.
	* @param signal - allocation cancellation; the initiating caller owns a shared creation.
	* @returns Published generation, or the retained exited generation.
	*/
	async ensure(agent, signal) {
		signal?.throwIfAborted();
		const binding = this.binding(agent);
		if (binding.barrier) await waitFor(binding.barrier, signal);
		this.assertOwner(agent);
		return waitFor(this.ensureCurrent(agent, signal), signal);
	}
	/**
	* Read a retained-history page without waiting for mutation ownership.
	* @param agent - exact live owner.
	* @param request - explicit line offset and count; viewport stays complete.
	* @param signal - cancellation while awaiting lazy allocation.
	* @returns Screen, process, and queue facts.
	*/
	async read(agent, request, signal) {
		signal?.throwIfAborted();
		const record = this.records.get(agent);
		this.binding(agent);
		const state = this.state(record ?? await this.ensure(agent, signal));
		const lines = state.text.history;
		const end = Math.max(0, lines.length - request.offset);
		const start = Math.max(0, end - request.count);
		return {
			...state,
			page: {
				text: lines.slice(start, end).join("\n"),
				totalLines: lines.length,
				lineBegin: start,
				lineEnd: end
			}
		};
	}
	/**
	* Queue one model write and await readiness or cancellation recovery.
	* @param agent - exact live owner.
	* @param request - input with resolved newline policy.
	* @param signal - queued removal or active SIGINT recovery.
	* @returns Terminal facts and the operation's settlement reason.
	*/
	async send(agent, request, signal) {
		const text = request.text + (request.submit ? "\r" : "");
		this.checkInput(text);
		const { record, operation, details } = await this.accept(agent, "model-send", (record) => record.terminal.write(text), signal);
		return this.settled(record, operation, details);
	}
	/**
	* Queue a signal without bypassing earlier human or model input.
	* @param agent - exact live owner.
	* @param request - allowed foreground signal.
	* @param signal - operation cancellation.
	* @returns Settlement facts and the group actually signalled, when delivered.
	*/
	async signal(agent, request, signal) {
		let processGroupId;
		const { record, operation, details } = await this.accept(agent, "signal", async (record) => {
			processGroupId = await record.terminal.signalForeground(request.signal);
		}, signal);
		return {
			...await this.settled(record, operation, details),
			processGroupId
		};
	}
	/**
	* Admit a FIFO generation handoff; later mutations await its completion.
	* Cancellation before replacement retains the predecessor's outcome; a failed replacement blocks ordinary mutations until another reset.
	* @param agent - exact live owner.
	* @param signal - cancellation before grant or during replacement allocation.
	* @returns Fresh generation facts after the controlled startup prompt.
	*/
	async reset(agent, signal) {
		const acceptedAt = performance.now();
		const binding = this.binding(agent);
		const release = this.reserve(binding, agent);
		const previous = binding.barrier;
		const admission = binding.admission;
		let replacementStarted = false;
		const result = (record, queueTimeMs) => {
			const state = this.state(record);
			return {
				...state,
				pendingCount: Math.max(0, state.pendingCount - 1),
				queueTimeMs,
				waitReason: "prompt"
			};
		};
		const resetting = (async () => {
			if (previous) await waitFor(previous.catch(() => void 0), signal);
			if (admission) await waitFor(admission, signal);
			signal?.throwIfAborted();
			this.assertOwner(agent);
			if (!this.records.has(agent) && !this.creating.has(agent)) {
				replacementStarted = true;
				this.publish({
					agent,
					type: "reset"
				});
				const queueTimeMs = performance.now() - acceptedAt;
				return result(await this.ensureCurrent(agent, signal), queueTimeMs);
			}
			const record = await waitFor(this.ensureCurrent(agent), signal);
			let replacing;
			let queueTimeMs = 0;
			const replace = () => {
				replacementStarted = true;
				queueTimeMs = performance.now() - acceptedAt;
				return replacing = this.createRecord(agent, record.generation + 1, signal, record);
			};
			const status = record.terminal.queue.status();
			if (status === "exited" || status === "disposed") return result(await replace(), queueTimeMs);
			const operation = record.terminal.queue.enqueue({
				id: String(++binding.nextOperation),
				kind: "reset"
			}, async () => {
				await replace();
			}, signal);
			try {
				await operation.lease;
			} catch (error) {
				if (!replacing) {
					if (record.terminal.queue.status() !== "exited") throw error;
					signal?.throwIfAborted();
					await record.terminal.done;
					this.assertOwner(agent);
					await replace();
				}
			}
			return result(await replacing, queueTimeMs);
		})().finally(release);
		binding.barrier = Promise.allSettled([
			previous,
			admission,
			resetting
		]).then(() => resetting).then(() => void 0, (error) => {
			if (!replacementStarted && signal?.aborted) return previous;
			throw error;
		});
		binding.barrier.catch(() => void 0);
		return resetting;
	}
	/**
	* Attach reads and human leases to the current exact generation.
	* @param agent - live Agent resolved through the public registry by the Web consumer.
	* @returns Snapshot/subscription and queued human-input capabilities.
	*/
	async attach(agent) {
		const record = await this.ensure(agent);
		const lease = (operation, details, initialBytes) => {
			let bytes = initialBytes;
			const done = this.settled(record, operation, details);
			done.catch(() => void 0);
			return {
				done,
				input: async (text) => {
					const next = bytes + Buffer.byteLength(text);
					if (next > this.config.maxInputBytes) throw new Error("terminal input exceeds maxInputBytes");
					const appended = operation.append(() => record.terminal.write(text));
					bytes = next;
					await appended;
				},
				cancel: () => {
					operation.cancel();
					return done;
				}
			};
		};
		return {
			generation: record.generation,
			read: () => this.state(record),
			subscribe: (listener) => record.terminal.subscribe(listener),
			begin: async (input, signal, queued) => {
				const bytes = this.checkInput(input);
				const { operation, details } = await this.accept(agent, "human", (current) => current.terminal.write(input), signal, record, queued);
				await operation.lease;
				return lease(operation, details, bytes);
			},
			takeover: async (target, signal) => {
				signal?.throwIfAborted();
				this.assertOwner(agent);
				if (this.records.get(agent) !== record) throw new Error("terminal attachment generation is stale");
				const operation = record.terminal.queue.takeover(target, signal);
				await operation.lease;
				return lease(operation, Promise.resolve({
					queueTimeMs: 0,
					output: "",
					outputTruncated: false
				}), 0);
			}
		};
	}
	/**
	* Reject a mode change while this owner has pending or live process resources.
	* @param agent - exact owner whose session policy is being changed.
	*/
	assertSandboxChangeAllowed(agent) {
		const record = this.records.get(agent);
		if (this.pendingOwners.has(agent) || record && this.live.has(record)) throw new Error("cannot change sandbox mode while terminal is active");
	}
	/**
	* Fence further calls and await every resource owned by this exact Agent.
	* @param agent - owner being detached or explicitly closed.
	* @returns Completion after pending creation rollback and live process teardown.
	*/
	disposeAgent(agent) {
		const wasDisposed = this.disposedOwners.has(agent);
		this.disposedOwners.add(agent);
		const binding = this.bindings.get(agent);
		if (!binding) return Promise.resolve();
		binding.closed = true;
		this.creating.get(agent)?.controller.abort(/* @__PURE__ */ new Error("terminal Agent disposed"));
		binding.disposal ??= (async () => {
			const errors = [];
			const revoked = wasDisposed ? Promise.resolve() : Promise.all([...this.listeners].map(async (listener) => listener({
				agent,
				type: "disposed"
			}))).then(() => void 0);
			revoked.catch(() => void 0);
			const pending = this.creating.get(agent);
			if (pending) try {
				await pending.promise;
			} catch (error) {
				if (error instanceof AggregateError) errors.push(error);
			}
			const record = this.records.get(agent);
			if (record) try {
				await record.terminal.dispose();
				this.live.delete(record);
			} catch (error) {
				errors.push(error);
			}
			try {
				await revoked;
			} catch (error) {
				errors.push(error);
			}
			await Promise.allSettled([binding.admission, binding.barrier]);
			if (errors.length) throw new AggregateError(errors, "terminal owner cleanup failed");
			this.records.delete(agent);
			binding.removeFence();
			this.bindings.delete(agent);
			await binding.removeLifetime();
			this.settledOwners.add(agent);
			this.ctx.emit("interactive-terminal/ownership");
		})();
		return binding.disposal;
	}
	/** Stop intake and await reverse-creation-order cleanup, including pending allocations. */
	dispose() {
		this.closed = true;
		for (const agent of this.pendingOwners) this.creating.get(agent)?.controller.abort(/* @__PURE__ */ new Error("terminal service disposed"));
		this.disposal ??= (async () => {
			const errors = [];
			const owners = new Set([...this.pendingOwners].reverse().concat([...this.live].reverse().map((record) => record.owner), [...this.bindings.keys()].reverse()));
			for (const owner of owners) try {
				await this.disposeAgent(owner);
			} catch (error) {
				errors.push(error);
			}
			for (const binding of this.bindings.values()) try {
				await binding.removeLifetime();
			} catch (error) {
				errors.push(error);
			}
			this.bindings.clear();
			this.listeners.clear();
			if (errors.length) throw new AggregateError(errors, "terminal service cleanup failed");
		})();
		return this.disposal;
	}
	ensureCurrent(agent, signal) {
		this.assertOwner(agent);
		const pending = this.creating.get(agent);
		if (pending) return pending.promise;
		const record = this.records.get(agent);
		return record ? Promise.resolve(record) : this.createRecord(agent, 1, signal);
	}
	createRecord(agent, generation, signal, previous) {
		if (!(previous && this.live.has(previous)) && this.size >= this.config.maxSessions) return Promise.reject(/* @__PURE__ */ new Error("terminal capacity reached"));
		const controller = new AbortController();
		const allocationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		this.pendingOwners.add(agent);
		let cleanupFailed = false;
		const creation = {
			controller,
			promise: Promise.resolve().then(async () => {
				if (previous) {
					this.publish({
						agent,
						type: "reset"
					});
					await previous.terminal.dispose();
				}
				allocationSignal.throwIfAborted();
				this.assertOwner(agent);
				const sandbox = agent.ctx.get("sandbox");
				const subprocess = agent.ctx.get("subprocess");
				const sandboxPolicy = agent.ctx.get("sandboxPolicy");
				if (!subprocess || !sandboxPolicy) throw new Error("terminal Agent requires subprocess and sandbox policy providers");
				const terminal = await TerminalGeneration.create({
					session: agent.session,
					subprocess,
					sandboxPolicy,
					...sandbox ? { sandbox } : {}
				}, this.config, generation, allocationSignal);
				try {
					this.assertOwner(agent);
				} catch (error) {
					await terminal.dispose();
					throw error;
				}
				const record = {
					owner: agent,
					generation,
					terminal
				};
				this.records.set(agent, record);
				if (previous) this.live.delete(previous);
				this.live.add(record);
				this.ctx.emit("interactive-terminal/ownership");
				terminal.done.then(() => this.exited(record), () => this.exited(record)).catch((error) => this.ctx.logger("interactive-terminals").warn(error));
				return record;
			}).catch((error) => {
				cleanupFailed = error instanceof AggregateError;
				throw error;
			}).finally(() => {
				if (!cleanupFailed) {
					this.creating.delete(agent);
					this.pendingOwners.delete(agent);
				}
			})
		};
		this.creating.set(agent, creation);
		return creation.promise;
	}
	async exited(record) {
		await record.terminal.dispose();
		this.live.delete(record);
		this.ctx.emit("interactive-terminal/ownership");
	}
	async accept(agent, kind, grant, signal, expected, queued) {
		const acceptedAt = performance.now();
		const binding = this.binding(agent);
		const release = this.reserve(binding, agent, queued);
		const id = String(++binding.nextOperation);
		const barrier = binding.barrier;
		const previous = binding.admission;
		const admission = (async () => {
			try {
				if (barrier) await waitFor(barrier, signal);
				if (previous) await waitFor(previous, signal);
				signal?.throwIfAborted();
				const record = await waitFor(this.ensureCurrent(agent, signal), signal);
				this.assertOwner(agent);
				if (expected && record !== expected) throw new Error("terminal attachment generation is stale");
				let queueTimeMs;
				let finish;
				const operation = record.terminal.queue.enqueue({
					id,
					kind
				}, () => {
					queueTimeMs = performance.now() - acceptedAt;
					if (kind !== "human") finish = record.terminal.captureOutput(id);
					return grant(record);
				}, signal);
				const details = operation.result.then(async () => {
					const waited = queueTimeMs ?? performance.now() - acceptedAt;
					const captured = await finish?.();
					return {
						queueTimeMs: waited,
						output: captured?.output ?? "",
						outputTruncated: captured?.truncated ?? false
					};
				}, async (error) => {
					await finish?.();
					throw error;
				});
				details.catch(() => void 0);
				operation.completion.then(release, release);
				return {
					record,
					operation,
					details
				};
			} catch (error) {
				release();
				throw error;
			}
		})();
		binding.admission = Promise.allSettled([previous, admission]).then(() => void 0);
		return admission;
	}
	reserve(binding, agent, queued) {
		if (binding.accepted >= this.config.maxQueuedOperations) throw new Error("terminal queue is full");
		binding.accepted += 1;
		const reservation = { queued };
		binding.reservations.add(reservation);
		const notify = () => {
			this.publish({
				agent,
				type: "state"
			});
			let position = 0;
			for (const item of binding.reservations) {
				try {
					item.queued?.(position);
				} catch (error) {
					this.ctx.logger("interactive-terminals").warn(error);
				}
				position += 1;
			}
		};
		notify();
		return () => {
			binding.accepted -= 1;
			binding.reservations.delete(reservation);
			notify();
		};
	}
	publish(event) {
		for (const listener of this.listeners) try {
			Promise.resolve(listener(event)).catch((error) => this.ctx.logger("interactive-terminals").warn(error));
		} catch (error) {
			this.ctx.logger("interactive-terminals").warn(error);
		}
	}
	binding(agent) {
		this.assertOwner(agent);
		const existing = this.bindings.get(agent);
		if (existing) return existing;
		const binding = {
			closed: false,
			accepted: 0,
			reservations: /* @__PURE__ */ new Set(),
			nextOperation: 0,
			barrier: void 0,
			admission: void 0,
			disposal: void 0,
			removeFence: () => void 0,
			removeLifetime: () => void 0
		};
		this.bindings.set(agent, binding);
		binding.removeFence = agent.ctx.on("internal/dispatch", (_mode, eventName, args) => {
			if (eventName !== "session/event") return;
			const [session, event] = args;
			if (session !== agent.session || event.type !== "sandbox/mode") return;
			const policy = agent.ctx.get("sandboxPolicy");
			if (!policy) throw new Error("terminal Agent requires a sandbox policy provider");
			const current = effectiveSandboxMode(session.events) ?? policy.defaultMode;
			if (event.data.mode !== current) this.assertSandboxChangeAllowed(agent);
		}, { global: true });
		binding.removeLifetime = agent.ctx.effect(() => () => this.disposeAgent(agent), "interactive terminal Agent teardown");
		return binding;
	}
	assertOwner(agent) {
		if (this.closed || this.disposedOwners.has(agent) || this.bindings.get(agent)?.closed) throw new Error("terminal owner or service is disposed");
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error("terminal owner is not the exact registered Agent");
	}
	checkInput(text) {
		const bytes = Buffer.byteLength(text);
		if (bytes > this.config.maxInputBytes) throw new Error("terminal input exceeds maxInputBytes");
		return bytes;
	}
	state(record) {
		const holder = record.terminal.queue.holder()?.kind ?? null;
		const pendingCount = Math.max(0, (this.bindings.get(record.owner)?.accepted ?? 0) - Number(holder !== null));
		return {
			generation: record.generation,
			snapshot: record.terminal.snapshot(),
			status: record.terminal.status(),
			queueStatus: record.terminal.queue.status(),
			text: record.terminal.text(),
			holder,
			takeoverId: record.terminal.queue.takeoverId(),
			pendingCount
		};
	}
	async settled(record, operation, details) {
		const captured = await details;
		const result = await operation.result;
		if (result.waitReason === "session_exit") await record.terminal.done;
		return {
			...this.state(record),
			...result,
			...captured
		};
	}
};
/** Await shared work without transferring cancellation to its owner. */
async function waitFor(pending, signal) {
	signal?.throwIfAborted();
	if (!signal) return pending;
	let abort;
	const cancelled = new Promise((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([pending, cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
//#endregion
//#region src/transport.ts
/** Exact-Agent, single-use Web credentials and generation-bound controller sockets. */
/** Trusted RPC channel; its only endpoint is token. */
const RPC_CHANNEL = "/dsh-interactive-terminal";
/** Exact WebSocket route, without query parameters. */
const WS_PATH = "/dsh-interactive-terminal/ws";
/** Negotiated protocol; credentials travel in a second, unselected token.<raw> subprotocol. */
const WS_PROTOCOL = "dsh-interactive-terminal.v1";
const TOKEN_TTL_MS = 1e4;
const secret = () => randomBytes(32).toString("base64url");
const digest = (raw) => createHash("sha256").update(raw).digest("base64url");
/** Owns public registrations, attach credentials, sockets, and disconnect recovery. */
var TerminalTransport = class {
	ctx;
	config;
	static inject = [
		"connection",
		"webServer",
		"agents",
		"interactiveTerminals"
	];
	tokens = /* @__PURE__ */ new Map();
	epochs = /* @__PURE__ */ new WeakMap();
	controllers = /* @__PURE__ */ new Map();
	connections = /* @__PURE__ */ new Set();
	pending = /* @__PURE__ */ new Set();
	lifetime = new AbortController();
	disposers = [];
	server;
	timer;
	stopped = false;
	disposal;
	/** @param ctx - public host services. @param config - validated terminal settings. */
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.disposers.push(ctx.provide("interactiveTerminalTransport", this));
		this.server = new WebSocketServer({
			noServer: true,
			maxPayload: config.maxInputBytes * 6 + 256,
			perMessageDeflate: false,
			handleProtocols: () => WS_PROTOCOL
		});
		ctx.effect(() => () => this.dispose(), "interactive terminal Web transport");
		const own = (install) => {
			const remove = ctx.effect(install);
			this.disposers.push(remove);
		};
		own(() => ctx.interactiveTerminals.subscribe((event) => {
			if (event.type !== "state") return this.revoke(event.agent, event.type === "reset" ? 4001 : 4002);
			else for (const connection of this.connections) if (connection.token.agent === event.agent) this.status(connection);
		}));
		own(() => ctx.connection.rpc.handle(RPC_CHANNEL, this.rpc, { authority: "trusted-host" }));
		own(() => ctx.webServer.registerUpgrade({
			path: WS_PATH,
			handler: (request, socket, head) => this.upgrade(request, socket, head)
		}));
	}
	/** @returns Counts derived from retained sockets and controller operations, grouped by exact Agent. */
	ownership() {
		return [.../* @__PURE__ */ new Set([...this.controllers.keys(), ...[...this.connections].map((connection) => connection.token.agent)])].map((owner) => ({
			owner,
			sockets: [...this.connections].filter((connection) => connection.token.agent === owner).length,
			pending: Number(this.controllers.get(owner)?.operation !== void 0)
		}));
	}
	/** @param agent - exact live owner. @param options - browser read-only intent and private reconnect proof. @returns One-use credential, valid for ten seconds. */
	async issueToken(agent, options = {}) {
		if (this.stopped) throw new Error("terminal transport disposed");
		this.ctx.interactiveTerminals.forAgent(agent);
		this.prune();
		const raw = secret();
		const controller = this.controllers.get(agent);
		const resume = options.resume === void 0 ? void 0 : controller && digest(options.resume) === controller.proof && !controller.recovering ? {
			controller,
			proof: controller.proof
		} : "invalid";
		this.tokens.set(digest(raw), {
			agent,
			expiresAt: Date.now() + TOKEN_TTL_MS,
			epoch: this.epochs.get(agent) ?? 0,
			readonly: options.readonly ?? false,
			resume
		});
		this.schedulePrune();
		return raw;
	}
	/** @param raw - presented one-use secret. @param agent - exact expected owner. @returns Consumed owner-bound credential. */
	async consumeToken(raw, agent) {
		return this.takeToken(raw, agent);
	}
	/** @param request - same-origin upgrade request. @param socket - owned HTTP socket. @param head - unconsumed upgrade bytes. */
	upgrade(request, socket, head) {
		try {
			if (request.url !== "/dsh-interactive-terminal/ws" || !sameOrigin(request)) throw new Error("invalid request");
			const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim());
			if (protocols?.length !== 2 || protocols[0] !== "dsh-interactive-terminal.v1" || !/^token\.[A-Za-z0-9_-]{43}$/.test(protocols[1])) throw new Error("invalid protocol");
			const token = this.takeToken(protocols[1].slice(6));
			this.server.handleUpgrade(request, socket, head, (ws) => {
				let resolve;
				const connection = {
					socket: ws,
					token,
					bufferLimit: this.config.scrollbackMaxBytes,
					closed: new Promise((done) => {
						resolve = done;
					})
				};
				this.connections.add(connection);
				ws.on("error", () => this.close(connection, 1011, "terminal-transport-error"));
				ws.on("close", () => {
					clearTimeout(connection.closing);
					connection.unsubscribe?.();
					this.connections.delete(connection);
					this.disconnected(connection);
					resolve();
				});
				ws.on("message", (data, binary) => this.message(connection, data, binary));
				this.track(this.attach(connection));
			});
		} catch {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		}
	}
	/** Stop new work, revoke credentials, cancel existing human operations, and await cleanup. */
	dispose() {
		if (this.disposal) return this.disposal;
		this.stopped = true;
		this.lifetime.abort(/* @__PURE__ */ new Error("terminal transport disposed"));
		clearTimeout(this.timer);
		this.tokens.clear();
		const sockets = [...this.connections];
		const operations = [...this.controllers.values()].map((controller) => this.recover(controller));
		for (const connection of sockets) this.close(connection, 4002, "terminal-disposed");
		this.disposal = (async () => {
			const removals = await Promise.allSettled(this.disposers.reverse().map((remove) => Promise.resolve().then(remove)));
			const settled = await Promise.allSettled([
				...operations,
				...sockets.map((connection) => connection.closed),
				...this.pending
			]);
			await new Promise((resolve) => this.server.close(() => resolve()));
			const errors = [...removals, ...settled].filter((result) => result.status === "rejected").map((result) => result.reason);
			if (errors.length) throw new AggregateError(errors, "terminal transport cleanup failed");
		})();
		return this.disposal;
	}
	rpc = async (endpoint, payload, signal) => {
		if (endpoint !== "token" || !object(payload) || !only(payload, [
			"sessionId",
			"readonly",
			"resume"
		]) || typeof payload.sessionId !== "string" || !payload.sessionId || typeof payload.readonly !== "boolean" || payload.resume !== void 0 && (typeof payload.resume !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.resume))) return {
			ok: false,
			error: {
				code: "bad-request",
				message: "invalid terminal token request",
				details: { issues: [] }
			}
		};
		if (signal.aborted) return {
			ok: false,
			error: {
				code: "cancelled",
				message: "terminal request cancelled",
				details: {}
			}
		};
		const id = SessionId(payload.sessionId);
		const agent = this.ctx.agents.get(id);
		if (!agent) return {
			ok: false,
			error: {
				code: "session-not-found",
				message: "terminal session is not live",
				details: { sessionId: id }
			}
		};
		try {
			return {
				ok: true,
				value: {
					token: await this.issueToken(agent, {
						readonly: payload.readonly,
						...typeof payload.resume === "string" ? { resume: payload.resume } : {}
					}),
					version: 1,
					path: WS_PATH,
					protocol: WS_PROTOCOL,
					expiresInMs: TOKEN_TTL_MS
				}
			};
		} catch {
			return {
				ok: false,
				error: {
					code: "internal",
					message: "terminal transport unavailable",
					details: {}
				}
			};
		}
	};
	takeToken(raw, expected) {
		this.prune();
		const key = digest(raw);
		const token = this.tokens.get(key);
		if (this.stopped || !token || expected && token.agent !== expected || this.ctx.agents.get(token.agent.id) !== token.agent || token.epoch !== (this.epochs.get(token.agent) ?? 0)) throw new Error("invalid or expired terminal token");
		this.tokens.delete(key);
		this.schedulePrune();
		return token;
	}
	prune() {
		for (const [key, token] of this.tokens) if (token.expiresAt <= Date.now()) this.tokens.delete(key);
	}
	schedulePrune() {
		clearTimeout(this.timer);
		if (this.tokens.size) {
			const next = Math.min(...[...this.tokens.values()].map((token) => token.expiresAt));
			this.timer = setTimeout(() => {
				this.prune();
				this.schedulePrune();
			}, Math.max(0, next - Date.now()));
			this.timer.unref();
		}
	}
	async attach(connection) {
		try {
			const attachment = await this.ctx.interactiveTerminals.attach(connection.token.agent);
			if (this.stopped || connection.socket.readyState !== WebSocket.OPEN || connection.token.epoch !== (this.epochs.get(connection.token.agent) ?? 0)) return;
			connection.attachment = attachment;
			let ready = false;
			let watermark = -1;
			const buffered = [];
			const publish = (event) => {
				if (!ready) {
					buffered.push(event);
					return;
				}
				switch (event.type) {
					case "output":
						if (event.sequence > watermark) {
							watermark = event.sequence;
							this.send(connection, {
								type: "terminal.output",
								output: event.output,
								sequence: event.sequence
							});
						}
						break;
					case "state":
					case "status":
						this.status(connection);
						break;
					case "error":
						this.send(connection, {
							type: "terminal.error",
							code: "transport-failed",
							message: "Terminal transport failed."
						});
						break;
					default: assertNever(event);
				}
			};
			connection.unsubscribe = attachment.subscribe(publish);
			const state = attachment.read();
			watermark = state.snapshot.sequence;
			this.send(connection, {
				type: "terminal.snapshot",
				snapshot: state.snapshot,
				scrollbackLines: this.config.scrollbackLines
			});
			this.claim(connection);
			this.status(connection);
			ready = true;
			for (const event of buffered) publish(event);
		} catch {
			this.close(connection, 1011, "terminal-attach-failed");
		}
	}
	claim(connection) {
		const { agent, resume, readonly } = connection.token;
		const current = this.controllers.get(agent);
		let reason;
		if (readonly) reason = "readonly";
		else if (resume === "invalid" || resume && (resume.controller !== current || resume.proof !== current.proof || current.recovering)) reason = "invalid-resume";
		else if (current && (current.socket || current.recovering || resume?.controller !== current)) reason = "controller-busy";
		if (reason) {
			this.send(connection, {
				type: "terminal.attached",
				mode: "readonly",
				reason,
				maxInputBytes: this.config.maxInputBytes
			});
			return;
		}
		const raw = secret();
		const controller = current ?? {
			agent,
			proof: "",
			socket: void 0,
			timer: void 0,
			recovering: false,
			operation: void 0
		};
		clearTimeout(controller.timer);
		controller.timer = void 0;
		controller.proof = digest(raw);
		controller.socket = connection;
		connection.controller = controller;
		this.controllers.set(agent, controller);
		this.send(connection, {
			type: "terminal.attached",
			mode: "controller",
			resume: raw,
			maxInputBytes: this.config.maxInputBytes
		});
		if (controller.operation?.lease) this.send(connection, { type: "human.granted" });
		else if (controller.operation?.position !== void 0) this.send(connection, {
			type: "human.queued",
			position: controller.operation.position
		});
	}
	message(connection, data, binary) {
		if (this.stopped || connection.closing) return;
		try {
			if (binary || !connection.attachment) throw new Error("invalid frame");
			const frame = parseFrame(data.toString(), connection.attachment.generation, this.config.maxInputBytes);
			if (frame.type === "heartbeat") {
				this.send(connection, { type: "heartbeat" });
				return;
			}
			const controller = connection.controller;
			if (!controller || controller.socket !== connection || controller.recovering) throw new Error("not controller");
			switch (frame.type) {
				case "human.begin":
					if (controller.operation) throw new Error("already begun");
					{
						const state = connection.attachment.read();
						if (state.queueStatus !== "ready" || state.holder !== null || state.pendingCount !== 0) {
							this.error(connection);
							this.send(connection, { type: "human.revoked" });
							break;
						}
					}
					this.begin(connection, controller, frame.input);
					break;
				case "human.takeover":
					if (controller.operation) throw new Error("already begun");
					this.takeover(connection, controller, frame.target);
					break;
				case "human.input":
					if (!controller.operation?.lease) throw new Error("not granted");
					this.track(controller.operation.lease.input(frame.input).catch(() => {
						this.error(connection);
						this.cancel(controller);
					}));
					break;
				case "human.cancel":
					this.cancel(controller);
					break;
				case "terminal.reset":
					this.track(this.ctx.interactiveTerminals.reset(connection.token.agent, this.lifetime.signal).then(() => void 0, () => this.error(connection)));
					break;
				default: assertNever(frame);
			}
		} catch {
			this.close(connection, 1008, "terminal-protocol-error");
		}
	}
	begin(connection, controller, input) {
		this.operate(controller, (operation) => connection.attachment.begin(input, operation.abort.signal, (position) => {
			operation.position = position;
			if (!operation.lease && !operation.abort.signal.aborted && controller.socket) this.send(controller.socket, {
				type: "human.queued",
				position
			});
		}));
	}
	takeover(connection, controller, target) {
		this.operate(controller, (operation) => connection.attachment.takeover(target, operation.abort.signal));
	}
	operate(controller, acquire) {
		const operation = {
			abort: new AbortController(),
			done: Promise.resolve()
		};
		controller.operation = operation;
		operation.done = (async () => {
			try {
				const lease = await acquire(operation);
				operation.lease = lease;
				if (controller.socket) this.send(controller.socket, { type: "human.granted" });
				await lease.done;
			} catch {
				if (!operation.abort.signal.aborted && controller.socket) this.error(controller.socket);
			} finally {
				if (controller.operation === operation) controller.operation = void 0;
				if (controller.socket) {
					this.send(controller.socket, { type: "human.revoked" });
					this.status(controller.socket);
				}
			}
		})();
		this.track(operation.done);
	}
	cancel(controller) {
		controller.operation?.abort.abort(/* @__PURE__ */ new Error("terminal human cancelled"));
	}
	disconnected(connection) {
		const controller = connection.controller;
		if (!controller || controller.socket !== connection) return;
		controller.socket = void 0;
		if (controller.recovering || this.stopped) return;
		controller.timer = setTimeout(() => {
			this.track(this.recover(controller));
		}, this.config.disconnectGraceMs);
	}
	async recover(controller) {
		clearTimeout(controller.timer);
		controller.timer = void 0;
		controller.recovering = true;
		controller.proof = "";
		this.cancel(controller);
		await controller.operation?.done;
		if (this.controllers.get(controller.agent) === controller) this.controllers.delete(controller.agent);
	}
	async revoke(agent, code) {
		this.epochs.set(agent, (this.epochs.get(agent) ?? 0) + 1);
		for (const [key, token] of this.tokens) if (token.agent === agent) this.tokens.delete(key);
		this.schedulePrune();
		const controller = this.controllers.get(agent);
		const recovery = controller ? this.recover(controller) : Promise.resolve();
		this.track(recovery);
		const connections = [...this.connections].filter((connection) => connection.token.agent === agent);
		for (const connection of connections) this.close(connection, code, code === 4001 ? "terminal-reset" : "terminal-disposed");
		await Promise.all([recovery, ...connections.map((connection) => connection.closed)]);
		this.ctx.emit("interactive-terminal/ownership");
	}
	status(connection) {
		if (!connection.attachment) return;
		const { status, queueStatus, holder, takeoverId, pendingCount } = connection.attachment.read();
		this.send(connection, {
			type: "terminal.status",
			status,
			queueStatus,
			holder,
			takeoverId,
			pendingCount
		});
	}
	error(connection) {
		this.send(connection, {
			type: "terminal.error",
			code: "operation-failed",
			message: "Terminal operation failed; check terminal status before retrying."
		});
	}
	send(connection, frame) {
		if (connection.socket.readyState !== WebSocket.OPEN || !connection.attachment) return;
		const encoded = JSON.stringify({
			...frame,
			version: 1,
			generation: connection.attachment.generation
		});
		if (frame.type === "terminal.snapshot") connection.bufferLimit = Buffer.byteLength(encoded) + this.config.scrollbackMaxBytes;
		if (connection.socket.bufferedAmount + Buffer.byteLength(encoded) > connection.bufferLimit) {
			this.close(connection, 1013, "terminal-slow-consumer");
			return;
		}
		connection.socket.send(encoded);
	}
	close(connection, code, reason) {
		connection.unsubscribe?.();
		if (connection.socket.readyState === WebSocket.CLOSED || connection.closing) return;
		connection.socket.close(code, reason);
		connection.closing = setTimeout(() => connection.socket.terminate(), this.config.disposeGraceMs);
	}
	track(work) {
		this.pending.add(work);
		work.finally(() => this.pending.delete(work)).catch((error) => this.ctx.logger("interactive-terminals").warn(error));
	}
};
function sameOrigin(request) {
	if (!request.headers.origin || !request.headers.host) return false;
	try {
		const origin = new URL(request.headers.origin);
		return (origin.protocol === "http:" || origin.protocol === "https:") && origin.host === request.headers.host && origin.username === "" && origin.password === "" && origin.pathname === "/" && !origin.search && !origin.hash;
	} catch {
		return false;
	}
}
function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value, keys) {
	return Object.keys(value).every((key) => keys.includes(key));
}
function parseFrame(raw, generation, maxInputBytes) {
	const frame = JSON.parse(raw);
	if (!object(frame) || frame.version !== 1 || frame.generation !== generation) throw new Error("invalid frame");
	const keys = [
		"version",
		"generation",
		"type"
	];
	switch (frame.type) {
		case "human.begin":
		case "human.input":
			if (!only(frame, [...keys, "input"]) || typeof frame.input !== "string" || !frame.input.isWellFormed() || Buffer.byteLength(frame.input) > maxInputBytes) throw new Error("invalid input");
			return {
				version: 1,
				generation,
				type: frame.type,
				input: frame.input
			};
		case "human.takeover":
			if (!only(frame, [...keys, "target"]) || typeof frame.target !== "string" || !/^[1-9]\d*$/.test(frame.target)) throw new Error("invalid takeover target");
			return {
				version: 1,
				generation,
				type: frame.type,
				target: frame.target
			};
		case "terminal.reset":
			if (!only(frame, [...keys, "confirmed"]) || frame.confirmed !== true) throw new Error("unconfirmed reset");
			return {
				version: 1,
				generation,
				type: frame.type,
				confirmed: true
			};
		case "human.cancel":
		case "heartbeat":
			if (!only(frame, keys)) throw new Error("unknown fields");
			return {
				version: 1,
				generation,
				type: frame.type
			};
		default: throw new Error("unknown frame");
	}
}
//#endregion
//#region src/tools.ts
/** The complete shared terminal model surface. */
const TERMINAL_TOOL_NAMES = [
	"shared_terminal_send",
	"shared_terminal_read",
	"shared_terminal_signal",
	"shared_terminal_reset"
];
const commonProperties = {
	generation: {
		type: "integer",
		required: true
	},
	sequence: {
		type: "integer",
		required: true
	},
	rows: {
		type: "integer",
		required: true
	},
	cols: {
		type: "integer",
		required: true
	},
	viewport: {
		type: "string",
		required: true
	},
	cursor: {
		type: "object",
		additionalProperties: false,
		required: true,
		properties: {
			x: {
				type: "integer",
				required: true
			},
			y: {
				type: "integer",
				required: true
			}
		}
	},
	status: {
		oneOf: [{
			type: "object",
			additionalProperties: false,
			properties: { kind: {
				type: "string",
				required: true,
				const: "running"
			} }
		}, {
			type: "object",
			additionalProperties: false,
			properties: {
				kind: {
					type: "string",
					required: true,
					const: "exited"
				},
				exitCode: {
					required: true,
					oneOf: [{ type: "integer" }, { type: "null" }]
				},
				signal: {
					required: true,
					oneOf: [{ type: "string" }, { type: "null" }]
				}
			}
		}],
		required: true
	},
	queueStatus: {
		type: "string",
		enum: [
			"ready",
			"busy",
			"blocked",
			"exited",
			"disposed"
		],
		required: true
	},
	holder: {
		required: true,
		oneOf: [{
			type: "string",
			enum: [
				"model-send",
				"human",
				"signal",
				"reset",
				"disconnect-recovery"
			]
		}, { type: "null" }]
	},
	pendingCount: {
		type: "integer",
		required: true
	},
	truncated: {
		type: "boolean",
		required: true
	}
};
const mutationProperties = {
	queueTimeMs: {
		type: "number",
		required: true
	},
	waitReason: {
		type: "string",
		required: true,
		enum: [
			"prompt",
			"stdin_read",
			"session_exit",
			"timeout",
			"cancelled",
			"human_handoff"
		]
	}
};
const operationProperties = {
	...commonProperties,
	...mutationProperties,
	output: {
		type: "string",
		required: true
	}
};
const sendOutputSchema = valueSchemaSpecToJsonSchema({
	type: "object",
	additionalProperties: false,
	properties: operationProperties
});
/** @param text - terminal input. @param maxInputBytes - deployment byte cap. @returns Validated input. */
function checkedInput(text, maxInputBytes) {
	if (Buffer.byteLength(text) > maxInputBytes) throw new Error("terminal input exceeds maxInputBytes");
	return text;
}
/**
* Preserve metadata and valid JSON while bounding all projected text together.
* @param value - canonical terminal result before text truncation.
* @param maxBytes - complete serialized JSON UTF-8 cap, including escaping.
* @returns The result with UTF-8-safe text suffixes and truthful truncation.
*/
function boundTerminalResult(value, maxBytes) {
	if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
	const project = (budget) => {
		const result = {
			...value,
			truncated: true
		};
		for (const key of [
			"viewport",
			"text",
			"output"
		]) {
			const text = value[key];
			if (text !== void 0) result[key] = truncateUtf8Tail(text, budget).text;
		}
		return result;
	};
	let lower = 0;
	let upper = maxBytes;
	if (Buffer.byteLength(JSON.stringify(project(0))) > maxBytes) throw new Error("terminal metadata exceeds maxToolOutputBytes");
	while (lower < upper) {
		const candidate = Math.ceil((lower + upper) / 2);
		if (Buffer.byteLength(JSON.stringify(project(candidate))) <= maxBytes) lower = candidate;
		else upper = candidate - 1;
	}
	return project(lower);
}
function common(state) {
	return {
		generation: state.generation,
		sequence: state.snapshot.sequence,
		rows: state.snapshot.rows,
		cols: state.snapshot.cols,
		viewport: state.text.viewport,
		cursor: state.text.cursor,
		status: state.status,
		queueStatus: state.queueStatus,
		holder: state.holder,
		pendingCount: state.pendingCount,
		truncated: state.text.truncated
	};
}
/**
* Build registry-ready definitions using the public value validator.
* @param config - validated deployment policy; never model arguments.
* @param service - injected terminal provider; the executing Agent supplies ownership, not service access.
* @returns Exactly four tools, each addressing the executing Agent's terminal.
*/
function createTerminalToolDefinitions(config, service) {
	validateConfig(config);
	const maxBytes = config.maxToolOutputBytes;
	return [
		defineTool({
			name: TERMINAL_TOOL_NAMES[0],
			description: "Send input to your shared terminal and wait for a prompt, stdin read, human handoff, timeout, or session exit. Human input and model mutations share a FIFO queue.",
			parameters: {
				text: {
					type: "string",
					required: true
				},
				submit: {
					type: "boolean",
					default: true
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: operationProperties
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(boundTerminalResult(value, maxBytes))
				}]
			},
			async execute(args, exec) {
				if (!exec.agent) throw new Error("shared terminal tools require an initiating Agent");
				const request = {
					text: args.text,
					submit: args.submit ?? true
				};
				checkedInput(request.text + (request.submit ? "\r" : ""), config.maxInputBytes);
				const result = await service.send(exec.agent, request, exec.signal);
				return boundTerminalResult({
					...common(result),
					output: result.output,
					queueTimeMs: result.queueTimeMs,
					waitReason: result.waitReason,
					truncated: result.outputTruncated || result.text.truncated
				}, maxBytes);
			},
			presentCall: (args) => ({
				card: "terminal",
				title: args.text || "(send input)",
				description: "Shared terminal"
			}),
			presentResult: (_args, result) => {
				if (result.isError || result.content.length !== 1 || result.content[0]?.type !== "text") return void 0;
				let value;
				try {
					value = JSON.parse(result.content[0].text);
				} catch {
					return;
				}
				if (validateJsonSchemaValue(sendOutputSchema, value).length) return void 0;
				return {
					card: "terminal",
					output: value.output
				};
			}
		}),
		defineTool({
			name: TERMINAL_TOOL_NAMES[1],
			description: "Read your shared terminal viewport and a newest-relative page of retained history without waiting for input ownership.",
			parameters: {
				offset: {
					type: "integer",
					default: 0
				},
				count: {
					type: "integer",
					default: 500
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...commonProperties,
						text: {
							type: "string",
							required: true
						},
						totalLines: {
							type: "integer",
							required: true
						},
						lineBegin: {
							type: "integer",
							required: true
						},
						lineEnd: {
							type: "integer",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(boundTerminalResult(value, maxBytes))
				}]
			},
			async execute(args, exec) {
				if (!exec.agent) throw new Error("shared terminal tools require an initiating Agent");
				const request = {
					offset: args.offset ?? 0,
					count: args.count ?? 500
				};
				if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.count) || request.count < 1) throw new Error("offset must be a non-negative safe integer and count must be a positive safe integer");
				const result = await service.read(exec.agent, request, exec.signal);
				return boundTerminalResult({
					...common(result),
					...result.page
				}, maxBytes);
			},
			presentCall: () => ({
				card: "generic",
				title: "Read shared terminal",
				kind: "read"
			})
		}),
		defineTool({
			name: TERMINAL_TOOL_NAMES[2],
			description: "Queue a signal to your shared terminal foreground process group. SIGKILL of the top-level shell is refused.",
			parameters: { signal: {
				type: "string",
				required: true,
				enum: [
					"SIGINT",
					"SIGTERM",
					"SIGKILL",
					"SIGTSTP",
					"SIGHUP"
				]
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...operationProperties,
						processGroupId: {
							required: true,
							oneOf: [{ type: "integer" }, { type: "null" }]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(boundTerminalResult(value, maxBytes))
				}]
			},
			async execute(args, exec) {
				if (!exec.agent) throw new Error("shared terminal tools require an initiating Agent");
				const result = await service.signal(exec.agent, args, exec.signal);
				return boundTerminalResult({
					...common(result),
					output: result.output,
					queueTimeMs: result.queueTimeMs,
					waitReason: result.waitReason,
					processGroupId: result.processGroupId ?? null,
					truncated: result.outputTruncated || result.text.truncated
				}, maxBytes);
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Signal shared terminal ${args.signal}`,
				kind: "execute"
			})
		}),
		defineTool({
			name: TERMINAL_TOOL_NAMES[3],
			description: "Reset your shared terminal in FIFO order, terminating its current process and starting a fresh shell.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...commonProperties,
						...mutationProperties
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(boundTerminalResult(value, maxBytes))
				}]
			},
			async execute(_args, exec) {
				if (!exec.agent) throw new Error("shared terminal tools require an initiating Agent");
				const result = await service.reset(exec.agent, exec.signal);
				return boundTerminalResult({
					...common(result),
					queueTimeMs: result.queueTimeMs,
					waitReason: result.waitReason
				}, maxBytes);
			},
			presentCall: () => ({
				card: "generic",
				title: "Reset shared terminal",
				kind: "delete"
			})
		})
	].map(closeRoot);
}
function closeRoot(definition) {
	const keys = Object.keys(definition.parameters.properties ?? {});
	const extras = (args) => args !== null && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).filter((key) => !keys.includes(key)) : [];
	return {
		...definition,
		parameters: {
			...definition.parameters,
			additionalProperties: false
		},
		execute(args, exec) {
			const unknown = extras(args);
			if (unknown.length) throw new ToolArgsError(unknown.map((key) => `${key}: unexpected property`));
			return definition.execute(args, exec);
		},
		presentCall: (args) => extras(args).length ? void 0 : definition.presentCall?.(args),
		presentResult: (args, result) => extras(args).length ? void 0 : definition.presentResult?.(args, result)
	};
}
/**
* Own tool and prompt registrations under the calling Cordis lifetime.
* @param ctx - tool and system-prompt registries.
* @param config - resolved deployment policy.
* @returns Idempotent disposer for the complete consumer registration.
*/
function registerTerminalTools(ctx, config) {
	const definitions = createTerminalToolDefinitions(config, ctx.interactiveTerminals);
	return ctx.effect(() => {
		const disposers = [];
		const dispose = () => {
			for (const remove of disposers.splice(0).reverse()) remove();
		};
		try {
			for (const definition of definitions) disposers.push(ctx.tools.register(definition));
			disposers.push(ctx.systemPrompt.section({
				name: "tool:shared-terminal",
				order: 107,
				text: "shared_terminal_send, shared_terminal_read, shared_terminal_signal, and shared_terminal_reset address the current Agent’s single shared terminal. Prefer the existing Bash tool for one-shot commands. Human and model input share a FIFO queue; read bypasses input ownership. If send returns a human handoff, wait for the user to finish and do not send answers behind the human input lease. Reset destroys terminal state. A timeout does not prove the foreground command exited."
			}));
		} catch (error) {
			dispose();
			throw error;
		}
		return dispose;
	}, "shared terminal tools and prompt");
}
//#endregion
//#region src/index.ts
/** Loader plugin identity. */
const name = "dsh-interactive-terminal";
/** Host services used by the assembled plugin. */
const inject = [
	"agents",
	"subprocess",
	"sandboxPolicy",
	"tools",
	"systemPrompt",
	"connection",
	"webServer"
];
/** @param ctx - Host plugin fiber. @param config - schema-resolved deployment settings. */
function apply(ctx, config) {
	assertSupportedHost(config);
	const service = new InteractiveTerminalService(ctx, config);
	let transport;
	ctx.plugin({
		inject: [
			"interactiveTerminals",
			"agents",
			"tools",
			"systemPrompt",
			"connection",
			"webServer"
		],
		apply(consumer) {
			registerTerminalTools(consumer, config);
			transport = new TerminalTransport(consumer, config);
		}
	});
	ctx.effect(() => async () => {
		const errors = (await Promise.allSettled([service.dispose(), transport?.dispose()])).filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length) throw new AggregateError(errors, "interactive terminal plugin cleanup failed");
	}, "interactive terminal coordinated teardown");
}
//#endregion
export { ConfigSchema as Config, apply, inject, name };
