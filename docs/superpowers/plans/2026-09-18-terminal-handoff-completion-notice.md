# Terminal Handoff Completion Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically resume the owning Agent exactly once after an explicit browser takeover settles, while keeping terminal output model-visible only through `shared_terminal_read`.

**Architecture:** `TerminalTransport` already owns the exact Agent, controller, and `HumanLease.done` wait. Extend only the explicit takeover path so settlement creates a plugin `notice`: steer it into a running Agent or follow it up to an idle Agent. Waking steering survives active cancellation convergence and cannot remain parked after a running-to-idle race. The notice carries lifecycle metadata and a read-first instruction, while the existing read tool remains the sole path for PTY contents.

**Tech Stack:** TypeScript 6, Cordis services, DeepSeek Harness Agent/LLM public APIs, `ws`, Vitest, Playwright, replay LLM fixtures, tsdown.

## Global Constraints

- Execute this plan in an isolated worktree created with `using-git-worktrees`; the current checkout contains unrelated user changes that must remain untouched.
- Notify only a successfully acquired explicit `human.takeover` lease; ordinary `human.begin`, stale takeover attempts, and read-only connections never notify.
- One `HumanLease` spans every Enter and all prompts until controlled Shell prompt recovery, Shell exit, cancellation recovery, or failure; reconnect resumes that lease and must not create another notification.
- A notice contains generation, output sequence, settlement reason when available, and terminal status; it contains no raw PTY output, viewport, history, artificial tool result, or human answer.
- Use `source: { kind: 'plugin', plugin: 'dsh-interactive-terminal', form: 'notice', ... }`; use the exact Agent object, never a session-id lookup that could reach a replacement.
- Call `steer()` when the owner is `running` and `followup()` when it is `idle`; suppress delivery after terminal/Agent disposal.
- The notice instructs the Agent to call cumulative `shared_terminal_read` before any new terminal send or signal. Do not add operation/sequence filtering, a fifth tool, a config field, a WebSocket frame, a UI control, or a dependency.
- Keep raw PTY bytes and human keys out of the session log. Do not change tool schemas, queue ordering, fixed PTY geometry, or the `human_handoff` result.
- Update English and Chinese documentation together. Build and test only; do not publish the npm package.

---

### Task 1: Deliver one read-first notice from the takeover lease

**Files:**
- Modify: `src/transport.ts:1-421`
- Test: `tests/transport.spec.ts:1-455`

**Interfaces:**
- Consumes: `HumanLease.done: Promise<TerminalOperationResult>`, `TerminalAttachment.read(): TerminalReadResult`, `Agent.status`, `Agent.steer(message)`, and `Agent.followup(message)`.
- Produces: a private `HandoffSettlement` union and `TerminalTransport.notifyHandoff(...)`; no public export or protocol change.

- [ ] **Step 1: Add failing transport tests for multi-prompt completion and idle delivery**

Add one test beside the existing exact-operation takeover test. It must reconnect during the same lease, submit two answers, prove no notice before the controlled prompt, and inspect the one plugin notice without accepting terminal output inside it:

```ts
it('wakes an idle owner once after a reconnected multi-prompt takeover settles', async () => {
  const f = await makeTransport({ disconnectGraceMs: 400 })
  const followup = vi.spyOn(f.agent, 'followup')
  const steer = vi.spyOn(f.agent, 'steer')
  const a = await attachController(f)
  const model = f.service.send(f.agent, { text: 'npm update', submit: true })
  await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('npm update\r'))
  const status = await vi.waitFor(() => {
    const current = a.frames.findLast(frame => frame.type === 'terminal.status' && typeof frame.takeoverId === 'string')
    expect(current).toBeTruthy()
    return current!
  })
  if (status.type !== 'terminal.status' || status.takeoverId === null || a.attached.mode !== 'controller') throw new Error('missing takeover state')

  a.send('human.takeover', { target: status.takeoverId })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
  await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
  const closed = once(a.socket, 'close')
  a.socket.close()
  await closed
  const b = await attachController(f, { resume: a.attached.resume })
  await vi.waitFor(() => expect(b.frames.some(frame => frame.type === 'human.granted')).toBe(true))

  b.send('human.input', { input: 'yes\r' })
  await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('yes\r'))
  f.subprocess.handles[0]!.output.write('Install location? ')
  b.send('human.input', { input: '/tmp/npm-cache\r' })
  await vi.waitFor(() => expect(f.subprocess.handles[0]!.write).toHaveBeenCalledWith('/tmp/npm-cache\r'))
  expect(followup).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()

  const record = await f.service.ensure(f.agent)
  f.subprocess.handles[0]!.output.write(`ANSWER=[yes]\r\nLOCATION=[/tmp/npm-cache]\r\n${record.terminal.prompt.marker}`)
  await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1))
  expect(steer).not.toHaveBeenCalled()
  const message = followup.mock.calls[0]![0]
  expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-interactive-terminal', form: 'notice' })
  const block = message.content[0]
  if (block?.type !== 'text') throw new Error('missing notice text')
  expect(block.text).toContain('shared_terminal_read')
  expect(block.text).toContain('generation=1')
  expect(block.text).toContain('waitReason=prompt')
  expect(block.text).not.toContain('ANSWER=[yes]')
  expect(block.text).not.toContain('/tmp/npm-cache')
  await Promise.resolve()
  expect(followup).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Add failing transport tests for routing, failure, exclusions, and disposal**

Add focused cases using the same public WebSocket path:

```ts
it('steers a completed takeover into a running owner', async () => {
  const f = await makeTransport()
  Object.defineProperty(f.agent, 'status', { configurable: true, value: 'running' })
  const followup = vi.spyOn(f.agent, 'followup')
  const steer = vi.spyOn(f.agent, 'steer')
  const a = await attachController(f)
  const model = f.service.send(f.agent, { text: 'ask', submit: true })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
  const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
  if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
  a.send('human.takeover', { target: state.takeoverId })
  await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
  f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
  await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1))
  expect(followup).not.toHaveBeenCalled()
})

it('does not notify for ordinary input, rejected takeover, or disposed ownership', async () => {
  const f = await makeTransport()
  const followup = vi.spyOn(f.agent, 'followup')
  const steer = vi.spyOn(f.agent, 'steer')
  const a = await attachController(f)
  a.send('human.begin', { input: 'echo ordinary\r' })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
  f.subprocess.handles[0]!.output.write((await f.service.ensure(f.agent)).terminal.prompt.marker)
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.revoked')).toBe(true))
  a.send('human.takeover', { target: '999' })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.error')).toBe(true))

  const model = f.service.send(f.agent, { text: 'dispose me', submit: true })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
  const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
  if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
  a.send('human.takeover', { target: state.takeoverId })
  await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
  await f.service.disposeAgent(f.agent)
  expect(followup).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
})

it('reports an acquired takeover failure once without leaking error or terminal text', async () => {
  const f = await makeTransport()
  const followup = vi.spyOn(f.agent, 'followup')
  const a = await attachController(f)
  const model = f.service.send(f.agent, { text: 'ask', submit: true })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)).toBe(true))
  const state = a.frames.findLast(frame => frame.type === 'terminal.status' && frame.takeoverId !== null)
  if (state?.type !== 'terminal.status' || state.takeoverId === null) throw new Error('missing takeover target')
  a.send('human.takeover', { target: state.takeoverId })
  await expect(model).resolves.toMatchObject({ waitReason: 'human_handoff' })
  await vi.waitFor(() => expect(a.frames.some(frame => frame.type === 'human.granted')).toBe(true))
  f.subprocess.handles[0]!.output.write('PRIVATE_TERMINAL_TEXT')
  f.subprocess.handles[0]!.signalForeground.mockRejectedValueOnce(new Error('private transport failure'))
  a.send('human.cancel')
  await vi.waitFor(() => expect(followup).toHaveBeenCalledTimes(1))
  const block = followup.mock.calls[0]![0].content[0]
  if (block?.type !== 'text') throw new Error('missing notice text')
  expect(block.text).toContain('handoff failed')
  expect(block.text).not.toContain('PRIVATE_TERMINAL_TEXT')
  expect(block.text).not.toContain('private transport failure')
  await Promise.resolve()
  expect(followup).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 3: Run the focused tests to verify the missing behavior**

Run: `pnpm vitest run tests/transport.spec.ts`

Expected: the new tests fail because `followup` and `steer` are never called.

- [ ] **Step 4: Implement the minimal takeover-only settlement hook**

In `src/transport.ts`, import `createUserMessage` and the terminal result/read types. Add this private vocabulary near `HumanOperation`:

```ts
type HandoffSettlement =
  | { kind: 'completed'; result: TerminalOperationResult }
  | { kind: 'failed'; state: TerminalReadResult }

interface HandoffObserver {
  failedState(): TerminalReadResult
  settled(outcome: HandoffSettlement): void
}
```

Change `operate` to accept an optional non-throwing observer. Invoke it only after `acquire()` returned a lease: once with the resolved `lease.done` result, or once with `failed` if that Promise rejects. Do not invoke it when acquisition itself fails.

```ts
private operate(
  controller: Controller,
  acquire: (operation: HumanOperation) => Promise<HumanLease>,
  observer?: HandoffObserver,
): void {
  const operation: HumanOperation = { abort: new AbortController(), done: Promise.resolve() }
  controller.operation = operation
  operation.done = (async () => {
    let lease: HumanLease | undefined
    try {
      lease = await acquire(operation)
      operation.lease = lease
      if (controller.socket) this.send(controller.socket, { type: 'human.granted' })
      observer?.settled({ kind: 'completed', result: await lease.done })
    } catch {
      if (lease && observer) observer.settled({ kind: 'failed', state: observer.failedState() })
      if (!operation.abort.signal.aborted && controller.socket) this.error(controller.socket)
    } finally {
      if (controller.operation === operation) controller.operation = undefined
      if (controller.socket) { this.send(controller.socket, { type: 'human.revoked' }); this.status(controller.socket) }
    }
  })()
  this.track(operation.done)
}
```

Pass the observer only from `takeover`; `begin` remains unchanged:

```ts
private takeover(connection: Connection, controller: Controller, target: TakeoverId): void {
  this.operate(
    controller,
    operation => connection.attachment!.takeover(target, operation.abort.signal),
    {
      failedState: () => connection.attachment!.read(),
      settled: outcome => this.notifyHandoff(controller.agent, outcome),
    },
  )
}
```

Add `notifyHandoff(agent, outcome)` as a private `TerminalTransport` method. It must check `this.stopped`, `ctx.agents.get(agent.id) === agent`, and `!ctx.interactiveTerminals.isDisposed(agent)`, then create this bounded, output-free message:

```ts
private notifyHandoff(agent: Agent, outcome: HandoffSettlement): void {
  if (this.stopped || this.ctx.agents.get(agent.id) !== agent || this.ctx.interactiveTerminals.isDisposed(agent)) return
  const state = outcome.kind === 'completed' ? outcome.result : outcome.state
  const reason = outcome.kind === 'completed' ? ` waitReason=${outcome.result.waitReason}` : ''
  const label = outcome.kind === 'completed' ? 'finished' : 'failed'
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: `Shared terminal human handoff ${label}.\n`
        + `generation=${state.generation} sequence=${state.snapshot.sequence}${reason} terminalStatus=${JSON.stringify(state.status)}\n`
        + 'Before sending terminal input or signals, call shared_terminal_read and inspect its newest retained history page plus viewport. The read is cumulative for this terminal generation, not isolated to this handoff.',
    }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-interactive-terminal',
      form: 'notice',
      summary: `Shared terminal human handoff ${label}${outcome.kind === 'completed' ? ` (${outcome.result.waitReason})` : ''}`,
    },
  })
  try {
    if (agent.status === 'idle') agent.followup(message)
    else agent.steer(message)
  } catch (error) {
    this.ctx.logger('interactive-terminals').warn(error)
  }
}
```

The synchronous status check and delivery run in one JavaScript turn. The contained throw ensures a disposal race cannot turn an already settled terminal lease into another terminal failure.

- [ ] **Step 5: Run the transport tests to verify all routes**

Run: `pnpm vitest run tests/transport.spec.ts`

Expected: PASS, including exactly-once reconnect, multi-prompt silence before the final prompt, running steering, idle wake, failure notice, and non-takeover exclusions.

- [ ] **Step 6: Commit the host behavior**

```bash
git add src/transport.ts tests/transport.spec.ts
git commit -m "feat: notify agent after terminal handoff"
```

### Task 2: Teach the model and users the completion protocol

**Files:**
- Modify: `src/tools.ts:190-200`
- Modify: `tests/tools.spec.ts:112-132`
- Modify: `README.md:65-104`
- Modify: `README.zh.md:65-104`
- Modify: `CHANGELOG.md:3-8`

**Interfaces:**
- Consumes: the notice text and delivery semantics from Task 1.
- Produces: stable system-prompt guidance and bilingual current-state documentation; no schema or runtime API change.

- [ ] **Step 1: Update the prompt test before changing prompt prose**

Replace the old “wait for the user” assertions with the complete behavior:

```ts
const prompt = (await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:shared-terminal')?.text.toLowerCase() ?? ''
expect(prompt).toContain('human handoff')
expect(prompt).toContain('plugin notifies')
expect(prompt).toContain('shared_terminal_read')
expect(prompt).toContain('before sending terminal input or signals')
```

- [ ] **Step 2: Run the prompt test to verify the old instruction fails**

Run: `pnpm vitest run tests/tools.spec.ts -t "human handoff"`

Expected: FAIL because the current prompt only says to wait for the user.

- [ ] **Step 3: Replace the handoff sentence in the system-prompt section**

Keep the section name and order. Replace only its handoff guidance with:

```ts
'If send returns a human handoff, do not send answers behind the human input lease. The plugin notifies you when that lease settles; after the notice, call shared_terminal_read before sending terminal input or signals.'
```

The surrounding one-terminal, Bash preference, FIFO, read-bypass, reset, and timeout statements remain unchanged.

- [ ] **Step 4: Document the exact user-visible behavior in both READMEs**

Append this English paragraph after the takeover paragraph in `README.md`:

```markdown
One takeover lease covers every prompt in the same foreground interaction. Enter submits an answer without notifying the Agent, and reconnect resumes the same lease. When the interaction returns to the controlled Shell prompt, exits, or finishes interrupt recovery, the plugin notifies the owning Agent once. The Agent reads `shared_terminal_read` before sending later terminal input or signals; its `text` and `viewport` are cumulative for the PTY generation, not isolated to that handoff. A live REPL or TUI sends no completion notice until it exits or is interrupted.
```

Append the corresponding Chinese paragraph after the takeover paragraph in `README.zh.md`:

```markdown
一次接手租约覆盖同一前台交互中的全部问题。Enter 只提交答案，不通知 Agent；重新连接恢复同一个租约。交互返回受控 Shell 提示符、退出或完成中断恢复后，插件只通知所属 Agent 一次。Agent 必须先调用 `shared_terminal_read`，再发送后续终端输入或信号；其中的 `text` 和 `viewport` 是该 PTY 代次的累计内容，不是本次接手的独立输出。仍在运行的 REPL 或 TUI 只有在退出或被中断后才发送完成通知。
```

In both Security/logging sections, extend the existing statement with: “The completion notice contains lifecycle metadata only; PTY output and human answers still reach the model only through terminal tool results.” Use the direct Chinese equivalent in `README.zh.md`.

Add one `0.1.0 - Unreleased` changelog bullet: “Notify the owning Agent once after an explicit human handoff settles, then require a cumulative shared-terminal read before further terminal input or signals.”

- [ ] **Step 5: Run focused prompt tests and prose checks**

Run: `pnpm vitest run tests/tools.spec.ts && git diff --check`

Expected: PASS; no trailing whitespace, untranslated behavior mismatch, or tool-schema change.

- [ ] **Step 6: Commit prompt and documentation**

```bash
git add src/tools.ts tests/tools.spec.ts README.md README.zh.md CHANGELOG.md
git commit -m "docs: explain terminal handoff completion"
```

### Task 3: Prove automatic continuation through the real Agent loop

**Files:**
- Modify: `examples/web/handoff-replay.json:1-54`
- Modify: `tests/browser.e2e.spec.ts:129-196`

**Interfaces:**
- Consumes: the plugin notice from Task 1, the system prompt from Task 2, existing `shared_terminal_read`, and the public replay/Web profile.
- Produces: a keyless, real-Agent-loop transcript proving `human_handoff → plugin notice → shared_terminal_read → next terminal send`.

- [ ] **Step 1: Change the handoff replay to require notice-driven reading**

Replace `examples/web/handoff-replay.json` with five scripted responses in this exact order:

```json
[
  {"kind":"chunks","chunks":[{"type":"tool-call-delta","index":0,"id":"handoff-start","name":"shared_terminal_send","argumentsDelta":"{\"text\":\"/bin/bash ./handoff-child.sh\",\"submit\":true}"},{"type":"finish","reason":{"kind":"tool-calls"}}]},
  {"kind":"chunks","chunks":[{"type":"text-delta","index":0,"text":"WAITING_FOR_HANDOFF_COMPLETION"},{"type":"finish","reason":{"kind":"stop"}}]},
  {"kind":"chunks","chunks":[{"type":"tool-call-delta","index":0,"id":"handoff-read","name":"shared_terminal_read","argumentsDelta":"{\"offset\":0,\"count\":500}"},{"type":"finish","reason":{"kind":"tool-calls"}}]},
  {"kind":"chunks","chunks":[{"type":"tool-call-delta","index":0,"id":"handoff-follower","name":"shared_terminal_send","argumentsDelta":"{\"text\":\"printf 'FOLLOWER_%s\\n' DONE\",\"submit\":true}"},{"type":"finish","reason":{"kind":"tool-calls"}}]},
  {"kind":"chunks","chunks":[{"type":"text-delta","index":0,"text":"HANDOFF_REPLAY_DONE"},{"type":"finish","reason":{"kind":"stop"}}]}
]
```

- [ ] **Step 2: Extend the browser child program and assertions for two human prompts**

Change the generated script to read two answers under one takeover:

```ts
await writeFile(join(app.workspace, 'handoff-child.sh'), [
  'trap "touch .handoff-interrupted; exit 130" INT',
  'printf "Download package? (Y/n) "',
  'while [ ! -f .handoff-ready ]; do sleep 0.05; done',
  'IFS= read -r answer',
  'printf "Install location: "',
  'IFS= read -r location',
  'printf "ANSWER_%s\\nLOCATION_%s\\n" "$answer" "$location"',
  '',
].join('\n'))
```

After takeover, type `Y`, wait for `Install location:`, then type `/tmp/npm-cache`. Before the second Enter, assert the final assistant marker and any plugin notice are absent. After completion, assert the terminal output contains both answers and `FOLLOWER_DONE` appears later.

- [ ] **Step 3: Assert the durable model-visible ordering and output separation**

After parsing the session log, identify the sole plugin notice:

```ts
const notices = events.filter(event => event.type === 'user/message'
  && event.data.source.kind === 'plugin'
  && event.data.source.plugin === 'dsh-interactive-terminal')
expect(notices).toHaveLength(1)
const noticeText = notices[0]!.data.content.map(block => block.type === 'text' ? block.text : '').join('')
expect(noticeText).toContain('shared_terminal_read')
expect(noticeText).toContain('waitReason=prompt')
expect(noticeText).not.toContain('ANSWER_Y')
expect(noticeText).not.toContain('/tmp/npm-cache')
```

Map tool calls by call id and assert the order and results:

```ts
const calls = events.filter(event => event.type === 'tool/call')
const names = new Map(calls.map(event => [event.data.callId, event.data.name]))
const results = events.filter(event => event.type === 'tool/result').map(event => {
  const block = event.data.message.content[0]!
  if (block.isError || block.content[0]?.type !== 'text') throw new Error('Expected successful JSON terminal result')
  return { name: names.get(block.toolCallId), ...JSON.parse(block.content[0].text) }
})
expect(calls.map(call => call.data.name)).toEqual([
  'shared_terminal_send',
  'shared_terminal_read',
  'shared_terminal_send',
])
expect(results[0]).toMatchObject({ name: 'shared_terminal_send', waitReason: 'human_handoff' })
expect(`${results[1]!.text}\n${results[1]!.viewport}`).toContain('ANSWER_Y')
expect(`${results[1]!.text}\n${results[1]!.viewport}`).toContain('LOCATION_/tmp/npm-cache')
expect(results[2]).toMatchObject({ name: 'shared_terminal_send', waitReason: 'prompt', output: expect.stringContaining('FOLLOWER_DONE') })
```

Also compare event sequence numbers to prove the notice precedes `handoff-read`, retain the assertion that no `interactive-terminal/output` session event exists, and assert the original `handoff-start` output does not contain either human answer.

- [ ] **Step 4: Run the assembled browser acceptance**

Run: `pnpm run build && pnpm vitest run tests/browser.e2e.spec.ts -t "interactive program"`

Expected: PASS with one generation, no SIGINT marker, one plugin notice, one read after that notice, and the follower after the read.

- [ ] **Step 5: Commit the keyless acceptance**

```bash
git add examples/web/handoff-replay.json tests/browser.e2e.spec.ts
git commit -m "test: replay terminal handoff completion"
```

### Task 4: Regenerate publishable artifacts and verify the complete change

**Files:**
- Modify: `lib/index.js` (generated from Host source)
- Verify unchanged unless the build proves otherwise: `lib/index.d.ts`, `lib/invariant.js`, `lib/invariant.d.ts`, `lib/protocol.d.ts`, `dist/client.js`

**Interfaces:**
- Consumes: all source, tests, replay fixtures, and documentation from Tasks 1-3.
- Produces: the checked-in Host artifact containing completion-notice delivery and complete release-candidate verification evidence.

- [ ] **Step 1: Run focused source tests before generation**

Run: `pnpm vitest run tests/transport.spec.ts tests/tools.spec.ts tests/browser.e2e.spec.ts`

Expected: PASS.

- [ ] **Step 2: Regenerate Host and client artifacts**

Run: `pnpm run build`

Expected: tsdown emits `lib/index.js` and declarations, the client type build succeeds, and the browser bundle rebuilds without adding a new external dependency.

- [ ] **Step 3: Inspect generated changes and commit only owned artifacts**

Run: `git status --short && git diff --stat && git diff --check`

Expected: only `lib/index.js` differs; client artifacts are byte-identical because no client source changed. If any other generated file differs, stop and inspect the unexplained output before committing.

```bash
git add lib/index.js
git commit -m "build: update terminal host artifact"
```

- [ ] **Step 4: Run the complete repository verification**

Run: `pnpm run verify`

Expected: typechecks, Host/client builds, type-artifact consumers, unit/integration/browser tests, published-artifact checks, and package checks all pass.

- [ ] **Step 5: Confirm the final diff and clean worktree**

Run: `git status --short && git log -5 --oneline`

Expected: no uncommitted files in the isolated worktree; four implementation commits follow the approved design commit, and no npm publication occurred.
