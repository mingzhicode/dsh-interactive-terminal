/**
 * Wire types shared by the interactive terminal host and its clients.
 *
 * @module dsh-interactive-terminal/protocol
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/** Mutations sharing one terminal's exclusive input slot. */
export type OperationKind = 'model-send' | 'human' | 'signal' | 'reset' | 'disconnect-recovery';
/** Availability of a terminal mutation queue. */
export type QueueStatus = 'ready' | 'busy' | 'blocked' | 'exited' | 'disposed';
/** An opaque key for one agent-owned terminal. */
export type AgentTerminalKey = Branded<'AgentTerminalKey'>;
/** A granted model send that may transfer its current FIFO slot to a human. */
export type TakeoverId = Branded<'TerminalTakeoverId'>;
/** The captured terminal contents delivered by a server snapshot. */
export interface ScreenSnapshot {
    sequence: number;
    rows: number;
    cols: number;
    replay: string;
    historyBytes: number;
    truncated: boolean;
}
/** The top-level process state of an agent-owned terminal. */
export type TerminalStatus = {
    kind: 'running';
} | {
    kind: 'exited';
    exitCode: number | null;
    signal: string | null;
};
/** Why an interactive terminal operation returned control to its caller. */
export type WaitReason = 'prompt' | 'stdin_read' | 'timeout' | 'session_exit' | 'human_handoff';
/** A frame sent by the authoritative terminal host. */
export type ServerFrame = {
    version: 1;
    generation: number;
} & ({
    type: 'terminal.snapshot';
    snapshot: ScreenSnapshot;
    scrollbackLines: number;
} | {
    type: 'terminal.attached';
    mode: 'controller';
    resume: string;
    maxInputBytes: number;
} | {
    type: 'terminal.attached';
    mode: 'readonly';
    reason: 'readonly' | 'controller-busy' | 'invalid-resume';
    maxInputBytes: number;
} | {
    type: 'terminal.output';
    output: string;
    sequence: number;
} | {
    type: 'terminal.status';
    status: TerminalStatus;
    queueStatus: QueueStatus;
    holder: OperationKind | null;
    takeoverId: TakeoverId | null;
    pendingCount: number;
} | {
    type: 'human.granted';
} | {
    type: 'human.queued';
    position: number;
} | {
    type: 'human.revoked';
} | {
    type: 'terminal.error';
    code: 'operation-failed' | 'transport-failed';
    message: string;
} | {
    type: 'heartbeat';
});
/** A frame accepted by the authoritative terminal host. */
export type ClientFrame = {
    version: 1;
    generation: number;
} & ({
    type: 'human.begin';
    input: string;
} | {
    type: 'human.takeover';
    target: TakeoverId;
} | {
    type: 'human.input';
    input: string;
} | {
    type: 'human.cancel';
} | {
    type: 'terminal.reset';
    confirmed: true;
} | {
    type: 'heartbeat';
});
/**
 * Prove a discriminated union has no unhandled members.
 *
 * @param value - impossible value from an exhaustive switch.
 * @returns Never returns.
 */
export declare function assertNever(value: never): never;
