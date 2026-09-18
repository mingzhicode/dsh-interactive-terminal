# Terminal Dock Implementation Plan

> **For agentic workers:** Use subagent-driven-development for implementation and review; the parent owns actual browser inspection. No commits.

**Goal:** Render the existing single PTY as a light, collapsible inline card above the composer.

**Architecture:** Replace the root overlay registration with the published session-scoped input dock. Keep the transport and ownership protocol; change the component, CSS and xterm theme only. Existing settings actions move into a keyboard-accessible inline disclosure.

**Tech Stack:** React 18, xterm 6, public DSH rc.8 slots, TypeScript, Vitest, existing Playwright acceptance.

## Global Constraints

- Each conversation retains one PTY; no tabs, tab counts, add/close-tab buttons or pin behavior.
- No Harness edits, private imports, DOM relocation, PTY seam changes, FitAddon, backend resize or stty.
- Collapse hides the existing terminal without ending the shell or input ownership.
- End Input, reset confirmation, readonly/mobile restrictions and transport behavior remain unchanged.
- Known multiline/reset queue defects remain unresolved and must not be hidden by changing tests or claims.
- No git initialization, commits, publication or replacement of the existing checkpoint tarball.

### Task 1: Public input dock, light terminal and settings

**Files:** Modify `src/client/index.ts`, `src/client/TerminalOverlay.tsx`, `src/client/styles.css`, `src/client/use-terminal.ts` (theme only), `package.json`, `pnpm-lock.yaml`, `tests/client/fixtures.ts`, the two `tests/client/*.spec.tsx` files, `tests/browser.e2e.spec.ts`, affected package metadata assertions, `README.md`, and `README.zh.md`. Build outputs may be regenerated. Use the approved spec at `docs/superpowers/specs/2026-09-17-terminal-dock-design.md`.

**Interfaces:** Consume the public session-scoped slot's `sessionId` instead of the root `useSessions` selection hook. `ClientTransport` and `useTerminal(sessionId, transport, mobile, active)` remain unchanged. Preserve the existing component export to limit unrelated churn; key its inner session view by the injected session identity.

- [x] Read the installed public `dsh-client-ui-conversation` slot declaration and matching shipped dock contribution before editing.
- [x] Record focused baseline: `node node_modules/vitest/vitest.mjs run tests/client`. Existing four holder-label failures are separately recorded final-review regressions; preserve them and distinguish them from this UI change.
- [x] Add failing assertions for the new slot name, lazy session attachment, settings disclosure, and white xterm background. Keep existing collapse, geometry, input and reset tests, updating interactions to open settings where necessary.

```ts
expect(entry.name).toBe('conversation.input.dock')
expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
fireEvent.click(screen.getByRole('button', { name: 'Terminal settings' }))
expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
expect(terminal.options.theme?.background).toBe('#ffffff')
```

- [x] Run the changed tests and retain their expected RED output before implementing.
- [x] Register through `ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-interactive-terminal', order: 100, inject: () => ({ transport, mobile }) }, TerminalOverlay))`, preserving effect-owned disposal. Derive/consume public props without inventing a private hook.
- [x] Add the public conversation UI package as peer/dev and client injection metadata; remove obsolete layout dependency only if no remaining consumer needs it. Refresh the lock with pinned pnpm 10.18.3, offline/auto-peers disabled if required by this machine's resolver limitation.
- [x] Implement a single header with chevron, Terminal title and settings gear; no fake shell title. Use native buttons, `aria-expanded`, associated controls, focus styles, and an inline settings disclosure. Retain the visible status/queue line and End Input button; settings contain reconnect, clear, smaller/larger and reset. Reset retains its confirmation and disabled guards.
- [x] Replace fixed positioning with `width: 100%; min-width: 0; box-sizing: border-box`, thin light borders, rounded corners, white background and muted chrome. Constrain the scrollable terminal height relative to viewport, retain vertical viewport resizing, and make narrow widths scroll locally rather than widen the page. Ensure `[hidden]` wins over display rules.
- [x] Set xterm's public theme to white background/dark foreground with a visible cursor and selection. Retain actual ANSI output and fixed rows/cols. No other edits to the hook's input or status logic.
- [x] Update browser acceptance to open settings before reconnect/reset and assert the terminal appears above the composer in normal layout at desktop and narrow viewport sizes. Test collapsed and expanded bounds, and retain actual input/history checks.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/client`, `npm run typecheck`, `npm run build`, `npm run typecheck:artifacts`, and the focused browser acceptance using the installed Chromium path supplied externally. Record pre-existing failures separately. Update both READMEs to describe the dock/settings and fixed geometry without claiming the old GIF represents this UI.
- [x] Self-review, record exact commands/results and changed-file list in `.superpowers/sdd/reports/terminal-dock-implementation.md`. Leave all changes uncommitted.

### Task 2: Actual page validation and review

**Files:** Parent writes screenshots and `.superpowers/sdd/reports/terminal-dock-browser.md`; reviewers write their reports under `.superpowers/sdd/reports/`. No unrelated source edits.

- [x] Start the existing isolated official Web fixture with built plugin; create a new browser session and workspace via normal UI.
- [x] Inspect real xterm expanded/collapsed, settings, human input and narrow viewport. Save screenshots to new paths in `artifacts/`, not over prior checkpoint evidence. Do not read credential contents or reuse existing user sessions.
- [x] Generate a scoped diff against the pre-change authored snapshot, dispatch independent spec/quality review, resolve concrete findings and rerun covering checks.
- [x] Review the whole UI change including actual-browser evidence and outstanding findings; record completion in the progress ledger. Stop the test server and close only task-created tabs.
- [x] Handoff links to screenshots, verification results, and the unchanged release-blocking queue caveat. No commit, package publication or claim of whole-plugin release acceptance.
