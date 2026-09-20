import type { ClientTerminalState, ClientTransport, ServerFrame } from './protocol.ts';
interface ViewState extends ClientTerminalState {
    lease: 'none' | 'queued' | 'taking-over' | 'granted';
    queuePosition: number | null;
    queueDepth: number;
    status: string;
    notice: string;
    canInput: boolean;
    canTakeover: boolean;
    canReset: boolean;
    takeoverId: Extract<ServerFrame, {
        type: 'terminal.status';
    }>['takeoverId'];
}
type Command = 'takeover' | 'end' | 'reset' | 'retry' | 'clear' | 'larger' | 'smaller';
/** Own one mounted view; manual collapse preserves its PTY, disposal releases the view and notifies the stable callback. */
export declare function useTerminal(sessionId: string, transport: ClientTransport, mobile: boolean, active: boolean, onDisposed: () => void): {
    state: ViewState;
    container: import("react").RefObject<HTMLDivElement>;
    act: (action: Command) => void;
};
export {};
