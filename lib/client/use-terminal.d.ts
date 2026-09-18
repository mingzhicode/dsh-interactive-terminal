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
/** Own one mounted view; collapse hides it without disconnecting its PTY. */
export declare function useTerminal(sessionId: string, transport: ClientTransport, mobile: boolean, active: boolean): {
    state: ViewState;
    container: import("react").RefObject<HTMLDivElement>;
    act: (action: Command) => void;
};
export {};
