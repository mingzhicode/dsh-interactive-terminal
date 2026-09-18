# Native terminal output queue implementation plan

**Goal:** Remove per-frame callback waits from browser terminal output without changing PTY ownership or input FIFO ordering.

**Architecture:** Let xterm enqueue snapshot and incremental writes in receipt order. Replace the browser renderer for each accepted attachment snapshot, preserving font size. Keep attempt, generation, and sequence validation. Do not publish React state for output-only frames. Use xterm's native write-buffer limit and report write failures without automatic reconnect; this is not end-to-end flow control.

**Tech stack:** Existing React hook, xterm 6, Vitest, and the runnable Web acceptance example.

## Constraints

No official PTY seam changes, new dependencies, commits, publishing, or restart of the user's DSH instance. Existing backend parsing and input queue remain unchanged. Native buffer accounting replaces the extra serial promise queue; bounded native-buffer failure is explicit, not a silent truncation policy.

## Task 1: Native queue and reconnect isolation

- [x] Add tests in `tests/client/output.client.spec.tsx` for a burst submitted before callbacks, ANSI split across frames, duplicate/gap/generation validation, renderer replacement with old pending writes, preserved font size, no output-only React commits, and write failure requiring explicit reconnect.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/client/output.client.spec.tsx` and record expected failures before implementation.
- [x] In `src/client/use-terminal.ts`, replace `rendering.then(...write(callback))` with direct `terminal.write(output)`. Create a new xterm instance on every snapshot, remove old input listeners and renderer, retain font size, and return before `publish()` on output frames. Keep the existing connection attempt guards and sequence checks. Catch native write failures and disable input with a visible notice and explicit retry.
- [x] Run the new tests plus `tests/client/overlay.client.spec.tsx` and `tests/client/reconnect.client.spec.tsx` if present; resolve all affected failures.

## Task 2: Product verification and documentation

- [x] Update the runnable browser acceptance test to assert rendered terminal output and font preservation after reconnect; retain real human handoff coverage.
- [x] Update bilingual README reconnect/rendering behavior, including native buffer limit versus full transport backpressure.
- [x] Run `npm run typecheck`, `npm run build`, `npm run typecheck:artifacts`, client tests, and the focused browser/artifact tests with the installed Chromium executable.
- [x] Measure burst completion through the actual client hook in a real browser; report parser completion separately from paint and from PTY-to-screen latency.
- [x] Review the scoped source changes and report only checks actually executed. Leave the user's process and Git state untouched.

## Verification

Initial new-test run: 6 failures and 2 passes; demonstrated one admitted output chunk instead of 100, 10 React commits for 10 output frames, blocked renderer replacement, and unhandled native write refusal. Independent review found lost focus on automatic resnapshot; a focused/unfocused regression test demonstrated the failure, and conditional focus restoration fixed it without stealing other controls' focus.

Final client run: 45 tests passed across output, overlay, and reconnect suites. `npm run typecheck && npm run build && npm run typecheck:artifacts` exited 0. With `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set to the installed Chromium 1228 executable, `vitest run tests/browser.e2e.spec.ts tests/artifact.spec.ts tests/example.spec.ts tests/output-browser.spec.ts` passed all 6 tests in 31.89 seconds. Independent read-only re-review found no remaining scoped issues.

`artifacts/terminal-output-benchmark.json` records three production-hook Chromium runs of 1,000 chunks / 10KB: parsing 4/3/1 ms and DOM checks after two animation frames 14/16/14 ms. These measurements exclude PTY and WebSocket latency and do not measure physical display presentation.

Final client SHA256: `cad28205d8b07d527600b4b697b35aae9ba11f4bcf969370bd4b32f45a412a08`. Host SHA256 remains `eb08bcb7930522e334fcd7a0574656c8bb87eab5e26317169957fa9c4c5d7b90`. No release tarball was rebuilt or published. The user's port 65114 was not listening at the read-only deployment check; no live deployment claim is made. No server stop/start or commit was performed.
