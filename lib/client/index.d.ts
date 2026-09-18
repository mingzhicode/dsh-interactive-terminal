/// <reference path="../../src/client/css.d.ts" preserve="true" />
/** Additive browser terminal contribution; all resources follow the client fiber. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import './platform.ts';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
/** Services required by the browser plugin. */
export declare const inject: string[];
/** Register the session-scoped dock and effect-owned renderer/socket lifetime. */
export declare function apply(ctx: ClientContext): void;
