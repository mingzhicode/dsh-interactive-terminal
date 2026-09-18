# dsh-interactive-terminal

`dsh-interactive-terminal` adds one persistent Bash terminal to each live DeepSeek Harness Agent. The light, collapsible terminal dock sits above the conversation composer, and the model and browser share the same process through a server-authoritative FIFO queue. Version 0.1 targets the public `@deepseek-ai/dsh` `0.1.0-rc.8` interfaces on macOS and Linux.

## Install a local release candidate

Build and inspect the package before installing it. The package runs no build or `postinstall` step after installation.

```sh
pnpm run build
npm pack --dry-run
npm pack
pnpm exec dsh plugin --profile web add ./dsh-interactive-terminal-0.1.0.tgz
pnpm exec dsh --profile web --no-open
```

The plugin command adds the tarball to the normal Web profile under `DSH_HOME` and activates its declared bundle layer. Set `DSH_HOME` to a new temporary directory first when an isolated verification profile is required. Do not use the bare registry name until the package has been published. After manual publication, the equivalent registry command is `dsh plugin --profile web add dsh-interactive-terminal`.

Open the Web URL, create or select an Agent, and expand **Terminal** above the composer. The first tool call or dock expansion lazily creates that Agent's shell. Use **Terminal settings** for reconnect, local clear, text size, and the confirmed terminal reset.

## Configuration

Override the installed row in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-interactive-terminal
  config:
    shellPath: /bin/bash
    shellArgs: [--noprofile, --norc, -i]
    rows: 40
    cols: 160
    scrollbackLines: 10000
    scrollbackMaxBytes: 4194304
    maxToolOutputBytes: 262144
    maxInputBytes: 65536
    maxQueuedOperations: 128
    maxSessions: 32
    pollIntervalMs: 50
    operationTimeoutMs: 30000
    interruptTimeoutMs: 5000
    disconnectGraceMs: 15000
    disposeGraceMs: 3000
```

| Field | Default | Meaning |
| --- | ---: | --- |
| `shellPath` | `/bin/bash` | Bash executable. Version 0 rejects other shells. |
| `shellArgs` | `--noprofile --norc -i` | Arguments for the interactive shell. Empty arguments are rejected. |
| `rows` | `40` | Fixed backend rows for every PTY generation. |
| `cols` | `160` | Fixed backend columns for every PTY generation. |
| `scrollbackLines` | `10000` | Maximum retained history lines, excluding the fixed viewport. |
| `scrollbackMaxBytes` | `4194304` | Maximum UTF-8 bytes in one serialized ANSI history replay, excluding the viewport. |
| `maxToolOutputBytes` | `262144` | Maximum UTF-8 bytes in the complete serialized JSON of a successful tool result. The minimum is `1024`, and the value cannot exceed `scrollbackMaxBytes`. |
| `maxInputBytes` | `65536` | Maximum bytes in one model send or one accepted human input lease. |
| `maxQueuedOperations` | `128` | Maximum accepted mutations for one Agent, including the active operation. |
| `maxSessions` | `32` | Maximum live Agent terminal generations. |
| `pollIntervalMs` | `50` | Delay before the next foreground-process check, measured after the previous check completes. |
| `operationTimeoutMs` | `30000` | Model mutation deadline before interrupt recovery begins. |
| `interruptTimeoutMs` | `5000` | Time allowed for a controlled prompt after recovery sends `SIGINT`. |
| `disconnectGraceMs` | `15000` | Controller disconnect grace before queued recovery ends human ownership. |
| `disposeGraceMs` | `3000` | Process-tree termination grace during reset or teardown. |

The dock uses the composer's normal page layout and scrolls wide terminal content locally. Browser resizing, vertical dock resizing, and text-size controls change only the visible viewport. They never change `rows`, `cols`, `stty`, or the PTY geometry. Collapsing the dock hides the existing terminal without ending its shell or releasing input ownership.

## Model tools

All four tools address the executing Agent; callers cannot select a session, PTY, working directory, shell, environment, sandbox, or another Agent.

- `shared_terminal_send({ text, submit? })` writes text and, by default, Enter. It returns on a controlled prompt, observed `stdin_read`, explicit human handoff, shell exit, timeout recovery, or cancellation recovery. `waitReason: human_handoff` means the human owns the still-running interaction, not that the program completed; wait for the user instead of submitting another answer.
- `shared_terminal_read({ offset?, count? })` reads without joining the mutation queue. `offset` skips retained history lines from the newest end and `count` selects the preceding page. `lineBegin` is inclusive and `lineEnd` is exclusive in the retained history; `totalLines` reports its current length. The result also contains the current viewport and zero-based cursor coordinates.
- `shared_terminal_signal({ signal })` queues `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGTSTP`, or `SIGHUP` for the foreground process group. `SIGKILL` against the top-level shell is refused.
- `shared_terminal_reset({})` queues destruction of the current generation and creates a fresh shell. Reset is the only operation that replaces a naturally exited shell.

Successful results report the generation, output sequence, fixed geometry, viewport, cursor, process status, queue status, holder, pending count, truncation state, and operation-specific fields. Mutation results also report queue time and `waitReason`; send and signal results include output captured for that operation. The complete serialized JSON result is bounded by `maxToolOutputBytes`, not only its output field. Text keeps the newest valid UTF-8 suffix when truncation is necessary, and `truncated` is set. The tool renderer uses that same bounded operation output.

## Queue, ownership, and recovery

Each exact live Agent owns at most one lazily created PTY, and two Agents never share terminal state. Independent model sends, human input, signals and resets enter one strict acceptance-order queue. Reads do not acquire an input slot. Human handoff transfers the active operation in place; it does not start another operation ahead of queued work.

When a model-started program asks for input, click **Take over input** and wait for the human grant before typing in the same terminal. The handoff sends no signal, clears that operation's model deadline, and keeps later operations queued until the human interaction ends. Typing during model ownership does not buffer an answer for later Shell execution. Handoff targets an exact operation and generation; stale or recovering targets are rejected rather than applied to a later command. Click before `operationTimeoutMs` expires (30 seconds by default); handoff cannot revive an already interrupted program.

At an available Shell, the browser's first key atomically requests a human lease and carries that key. Later keys remain buffered until the Host grants the lease. Enter submits input but does not itself release ownership; a controlled Shell prompt or exit ends the interaction. **Interrupt input** sends `SIGINT` to the re-inspected foreground group and retains the queue slot until prompt recovery completes. It interrupts the program; it is not a handoff button. A timeout does not prove that the command exited. Failed recovery changes the queue to `blocked`; the earliest queued reset is the only mutation allowed to recover it.

A natural shell exit keeps the final screen and exit status. Collapsing the panel, clearing its local view, or reconnecting does not replace the shell. Reconnect begins with a bounded snapshot and watermark before live output, so stale browser state is replaced without an unbounded replay.

Browser output uses xterm's native ordered write queue without waiting between chunks or updating the React toolbar per chunk. Each reconnect snapshot creates a fresh browser renderer, retaining the text size and isolating old queued output; it does not recreate the PTY. Connection, generation, and sequence checks remain active. xterm accounts for pending data and enforces its native buffer limit; a rejected write stops the connection with a visible notice and requires explicit **Reconnect**. This is not end-to-end backpressure for sustained high-volume output. A disconnected human controller remains subject to `disconnectGraceMs` recovery.

The Host combines bytes already buffered by the PTY stream, capping each aggregate at the stream's readable high-water mark without delaying the first arriving chunk. It publishes each batch only after screen and operation-capture ingestion. Foreground inspection waits `pollIntervalMs` after each completed check, leaving an interval for output processing even when a provider uses synchronous process scans. Signal delivery still performs its own foreground inspection.

One browser is controller for an Agent. Additional browser views are read-only, and all mobile views are read-only in version 0.1.

## Security and logging

The Host resolves the selected session through the public Agent registry and owns the working directory, sandbox policy, environment, and PTY identity. Attach tokens are cryptographically random, hashed while retained, bound to one Agent, valid for 10 seconds, and accepted once through the WebSocket subprotocol on the fixed upgrade path. The WebSocket accepts no Agent, session, or PTY identifier.

The shell receives explicit terminal variables and does not inherit Harness credentials. Raw PTY bytes and human keystrokes are not session events. Model tool arguments and bounded results remain ordinary tool log entries, so all model-visible terminal content is reconstructable without logging the human terminal stream.

Plugin unload, HMR, Agent disposal, and reset revoke tokens, close sockets, settle queued work, and terminate the owned process tree. Custom subprocess providers must provide the same send-time foreground reinspection as the official rc.8 provider and must refuse `SIGKILL` against the top-level terminal shell.

## Limits and troubleshooting

- Version 0.1 supports local Bash on macOS and Linux only. Windows and non-Bash `shellPath` values fail during activation.
- macOS rc.8 supports ordinary model commands and explicit human takeover of model-started interactions. The official macOS process inspector does not report `stdin_read`; without takeover before the deadline, a waiting model operation enters timeout recovery. Linux can release model input ownership on observed `stdin_read`, allowing the next input to continue the foreground program. Automatic model-driven `stdin_read` and multi-round REPL remain Linux validation targets; Linux native validation has not been run for this release candidate.
- The browser suppresses renderer-generated terminal query replies, and the Host has no device-query responder. The shell uses `TERM=dumb`, fixed geometry, and `PAGER=cat`; full-screen or query-dependent TUIs are not supported.
- A confined sandbox mode needs a usable same-world sandbox provider for the Agent. Missing or unusable confinement fails before the shell spawns; it does not fall back to an unconfined process.
- `terminal capacity reached` means `maxSessions` live or cleanup-retained generations are already allocated. Dispose an Agent or reset/finish cleanup before increasing the limit.
- `terminal queue is full` means the Agent reached `maxQueuedOperations`. Wait for accepted work rather than retrying mutations in parallel.
- `queue is blocked until reset` means interrupt recovery did not reach the controlled prompt within `interruptTimeoutMs`. Use the earliest queued reset; later mutations remain rejected.

The keyless Web acceptance uses a scripted replay provider with a real Agent loop and native PTY. It is not a live-model demonstration. Local live-model GUI evidence exists for macOS ordinary commands and human interaction; the Linux targets above remain unexecuted.

## Manual publication checklist

Publication is never part of build or verification.

1. Run the release checks and inspect `npm pack --dry-run`; confirm only `lib/`, `dist/client.js`, the Cordis patch, package metadata, the bilingual READMEs, changelog, and license are present.
2. Authenticate explicitly with npm and verify the target account and registry without copying credentials into this repository or its logs.
3. Obtain explicit user authorization for this exact tarball and version.
4. Only then run `npm publish` and verify the registry package before using the bare-name installation command.

## License

MIT. See [LICENSE](LICENSE).
