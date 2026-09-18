//#region src/invariant.ts
/** Companion Loader identity. */
const name = "dsh-interactive-terminal-invariant";
/** Registry owning the companion's installer. */
const inject = ["invariants"];
/** @param ctx - current service and transport. @param fail - package-attributed failure reporter. */
function checkOwnership(ctx, fail) {
	const service = ctx.interactiveTerminals;
	for (const row of service.ownership()) {
		if (row.generations.length > 1) fail(`Agent ${row.owner.id} owns multiple live terminal generations`);
		if (service.isDisposed(row.owner) && (row.generations.length || row.queued)) fail(`disposed Agent ${row.owner.id} retains terminal queue or process resources`);
	}
	for (const row of ctx.interactiveTerminalTransport.ownership()) if (service.isDisposed(row.owner) && (row.sockets || row.pending)) fail(`disposed Agent ${row.owner.id} retains terminal sockets or queue work`);
}
const install = Object.assign((ctx, fail) => {
	checkOwnership(ctx, fail);
	ctx.on("internal/dispatch", (_mode, event) => {
		if (event === "interactive-terminal/ownership" || event === "internal/status") checkOwnership(ctx, fail);
	}, { global: true });
}, { inject: ["interactiveTerminals", "interactiveTerminalTransport"] });
/** @param ctx - invariant registry. @returns Registration disposer after installer setup. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register("dsh-interactive-terminal", install));
//#endregion
export { apply, checkOwnership, inject, name };
