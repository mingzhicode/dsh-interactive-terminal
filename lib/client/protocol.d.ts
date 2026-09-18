/** Browser transport lifetime and the shared Host wire frames. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ClientFrame, ServerFrame } from '../protocol.ts';
export type { ClientFrame, ServerFrame } from '../protocol.ts';
/** Rendered authority and connection state for one selected session. */
export type TerminalViewMode = 'controller' | 'readonly';
export type TerminalConnectionStatus = 'collapsed' | 'connecting' | 'connected' | 'disconnected';
export interface ClientTerminalState {
    mode: TerminalViewMode;
    connection: TerminalConnectionStatus;
    sequence: number;
    pendingInput: string;
}
/** Per-attachment callbacks; disposal suppresses all subsequent callbacks. */
export interface FrameHandlers {
    frame(frame: ServerFrame): void;
    close(code: number): void;
}
export interface ClientAttachment {
    send(frame: ClientFrame): void;
    dispose(): void;
}
/** Prop-injected transport, shared by views and owned by the plugin effect. */
export interface ClientTransport {
    attach(sessionId: string, options: {
        readonly: boolean;
        resume?: string;
    }, handlers: FrameHandlers): ClientAttachment;
    track(dispose: () => void): () => void;
    dispose(): void;
}
/** Validate untrusted WebSocket fields before handing them to the terminal parser. */
export declare function parseServerFrame(value: unknown): ServerFrame;
/** Create lazy, abortable authenticated attachments and effect-owned view cleanup. */
export declare function createTerminalClientTransport(connection: Pick<ConnectionHandle, 'rpc'>): ClientTransport;
