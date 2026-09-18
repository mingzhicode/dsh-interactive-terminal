import { Context } from "@deepseek-ai/cordis";
import { InvariantFailure } from "@deepseek-ai/dsh-invariants";
//#region src/invariant.d.ts
/** Companion Loader identity. */
declare const name = "dsh-interactive-terminal-invariant";
/** Registry owning the companion's installer. */
declare const inject: string[];
/** @param ctx - current service and transport. @param fail - package-attributed failure reporter. */
declare function checkOwnership(ctx: Context, fail: InvariantFailure): void;
/** @param ctx - invariant registry. @returns Registration disposer after installer setup. */
declare const apply: (ctx: Context) => Promise<() => void>;
//#endregion
export { apply, checkOwnership, inject, name };