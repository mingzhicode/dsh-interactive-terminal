# Terminal Human Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. User forbids commits; preserve uncommitted files and use filesystem diffs.

**Goal:** Let a controller explicitly continue a model-started interactive program in its existing PTY without SIGINT or queued stale answers.

**Architecture:** Transfer the active model operation to a human lease in place. Separate the model caller's handoff result from the eventual queue-slot completion, publish an exact operation target to the browser, and reuse existing controller/input/disconnect machinery.

**Tech Stack:** TypeScript, Cordis public rc.8 services, React/xterm.js, Vitest, existing Playwright acceptance runner.

## Global Constraints

- Every conversation owns one PTY; only one input writer; independent operations remain FIFO.
- Official PTY seam remains unchanged. No private process APIs, extra dependencies, fifth tool, commit, git initialization, npm publication or replacement of existing checkpoint tarball/GIF.
- Spec: `docs/superpowers/specs/2026-09-18-terminal-human-handoff-design.md`, approved by user.
- Do not modify or stop the user server at `http://127.0.0.1:65114` or its session; all acceptance uses isolated instances with no credentials.
- Existing multiline completion, natural-exit queued-reset and fixture-failure cleanup defects remain separately reported. Baseline targeted Host run: 108 passed, 1 existing queued-reset failure. Four existing holder-display failures are directly covered by this UI change.
- No Git repository exists here. Baseline snapshot: `/tmp/dsh-handoff-baseline.t8QUIc`. Preserve all existing work.

### Task 1: Atomic Host handoff and usable browser controls

**Files:** Modify `src/queue.ts`, `src/service.ts`, `src/protocol.ts`, `src/tools.ts`, `src/transport.ts`, `src/client/protocol.ts`, `src/client/use-terminal.ts`, `src/client/TerminalOverlay.tsx`; extend existing queue/service/transport/tools/client/native tests. `src/terminal.ts` only if output-capture ordering requires it. Do not edit browser acceptance fixtures or READMEs in this task; parent handles those.

**Interfaces:** Queue exposes `takeover(target, signal?)` returning a human-compatible operation handle. A published nullable branded operation ID identifies only a granted, nonrecovering model-send. `TerminalAttachment.takeover(target, signal?)` returns `HumanLease`. Wire adds a no-input `human.takeover` frame carrying that ID and a nullable `takeoverId` status field. Model tool adds `waitReason: human_handoff`; other four-tool arguments stay unchanged.

- [x] Add RED queue tests for in-place takeover, preserved follower order, clearing timeout, detached original cancellation, retained capacity, stale/completed/recovering/ungranted target rejection and human lease close after prompt. Representative assertions:

```ts
const model = queue.enqueue({ id: 'model', kind: 'model-send' }, () => undefined, abort.signal)
await model.lease
const follower = queue.enqueue({ id: 'next', kind: 'model-send' }, nextWrite)
const human = queue.takeover(queue.takeoverId()!)
expect(await model.result).toEqual({ waitReason: 'human_handoff' })
abort.abort()
await vi.advanceTimersByTimeAsync(100)
expect(interrupt).not.toHaveBeenCalled()
expect(nextWrite).not.toHaveBeenCalled()
await human.append(() => writes.push('Y\r'))
queue.observe('prompt')
await human.result
await follower.lease
```

- [x] Run `node node_modules/vitest/vitest.mjs run tests/queue.spec.ts` and retain expected RED evidence.
- [x] Separate original model result from slot lifetime. Use an additional completion promise on the operation for reservation release; the model result may resolve at takeover while completion stays pending. Preserve one active entry, clear timer, detach original abort, switch holder to human, attach human cancellation, and reject old model-handle mutations after handoff. Fail closed if target changed or recovery started. Publish availability after initial write acknowledgement, not only at enqueue.
- [x] Add service RED tests exercising `attachment.takeover(target)`, independent result settlement/capacity, generation fencing, output capture ending at handoff, subsequent human answers and old model abort. Implement on the same record/entry with the existing HumanLease input byte limit and disposal rules. Never release the reservation on `human_handoff`.
- [x] Add wire RED tests for controller-only handoff, target validation, stale requests, reconnect and disconnect recovery. Implement request parsing, status publication, and explicit failure notice without buffering or writing an answer. Keep status and operation changes ordered for attached clients.
- [x] Add client RED tests: authoritative holder rendering, button availability, no ordinary human.begin or cached answer while model holds, handoff request without input, focus/input only after grant, stale rejection without later flush, readonly/mobile restrictions. Implement Take over input and rename End Input to Interrupt input; preserve other UI layout and settings.
- [x] Update tool result schema and instructions for `human_handoff`, logging through normal results; advise waiting for user rather than sending answers behind a human lease. Add schema/result tests.
- [x] Add real PTY RED/GREEN test using a local child that prints Y/n then reads a response. Model starts it, human takes over, response arrives in the child, queued follower runs after completion, same PTY remains and no SIGINT is observed. Use a child that delays reading until after handoff so native Linux stdin detection cannot win the setup race; do not use credentials or external auth.
- [x] Run focused tests, source typecheck and native handoff tests. Preserve known unrelated failures with explicit counts. Write `.superpowers/sdd/reports/handoff-implementation.md` with RED/GREEN commands, changed files and concerns. No commit.

### Task 2: Assembled acceptance and user documentation

**Files:** `tests/browser.e2e.spec.ts`, `tests/web-app.mjs` only for replay fixture selection, `examples/web/handoff-replay.json` if a separate replay is needed, `README.md`, `README.zh.md`; retain handoff screenshots under `artifacts/` without overwriting prior acceptance artifacts.

- [x] Add an isolated assembled keyless browser test before building the feature: replay calls shared_terminal_send with a local interactive child, browser sees prompt, takes over and enters Y. Observe actual child output and subsequent model operation output, compare PTY generation and assert no Shell command-not-found result.
- [x] Update the existing browser FIFO scenario for approved semantics: typing during model ownership no longer queues a hidden human answer. Wait for readiness to issue a new Shell command; preserve collapse/reconnect/fixed-size/reset acceptance.
- [x] Update README usage with Take over input, Interrupt input, 30-second pre-handoff deadline and macOS explicit takeover; distinguish Linux automatic stdin detection and continued model-driven REPL limitation on macOS.
- [x] Run `npm run typecheck && npm run build && npm run typecheck:artifacts`, then artifact and browser tests with installed Chromium. Inspect saved screenshot for the actual interactive prompt and takeover state.
- [x] Produce filesystem diff from baseline and independent spec/quality review, resolve findings with covering tests. Record release blockers separately, preserve the user instance, and report actual test evidence without claiming whole-plugin release readiness.

## Progress

- [x] Spec approved, source inspected, baseline preserved and targeted Host baseline run.
- [x] Task 1 implementation and independent review (including persistent dispatch-time stale-answer guard).
- [x] Task 2 acceptance, docs and final review. Fresh build/type checks, five assembled/artifact cases and two native handoff cases passed; reports are in `.superpowers/sdd/reports/handoff-*.md`. Known baseline defects remain separate release blockers.
