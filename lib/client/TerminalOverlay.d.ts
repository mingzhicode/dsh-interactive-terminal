import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { ClientTransport } from './protocol.ts';
/** The session-scoped slot supplies identity; the plugin injects transport and input policy. */
export interface TerminalOverlayProps {
    sessionId: SessionId;
    transport: ClientTransport;
    mobile: boolean;
}
/** Keep the terminal view keyed to the public session identity. */
export declare function TerminalOverlay({ sessionId, transport, mobile }: TerminalOverlayProps): import("react/jsx-runtime").JSX.Element;
