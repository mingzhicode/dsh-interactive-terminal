# dsh-interactive-terminal

English | [中文](README.zh.md)

A persistent Bash terminal shared by the model and user in DeepSeek Harness Web. Each live Agent owns one PTY, rendered with xterm.js in a collapsible panel above the composer. Input operations follow a strict FIFO queue; explicit handoff lets a user continue a model-started program.

## Install and start

Requirements: macOS or Linux, Bash, and Node.js `^22.19 || >=24`. This plugin is tested against DSH `0.1.0-rc.8`; other DSH versions are unverified. DSH's plugin command requires pnpm on `PATH`.

### Install from npm

Install the tested CLI and package manager. Skip this step if these versions are already available:

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.8 pnpm@10.18.3
```

Install version `0.2.0` into the Web profile and start DSH:

```sh
dsh plugin --profile web add dsh-interactive-terminal@0.2.0
dsh --profile web --no-open
```

The registry command requires a published package. If it returns `404`, use a supplied `.tgz` as described below. Installing the plugin globally with `npm install -g` alone does not activate it in DSH.

`dsh plugin` downloads the package into the Web profile and activates its bundle automatically; no additional `--patch` is needed. Installation and startup must use the same `DSH_HOME` (default: `~/.dsh`). Restart an already running DSH after installation.

Open the URL printed by DSH, configure the model if needed, select a workspace and conversation, then expand **Terminal**. The first expansion or tool call creates the shell. Type `echo hello` at the idle prompt to check input and output. Subsequent launches only need:

```sh
dsh --profile web --no-open
```

### Install a downloaded npm tarball

If you have `dsh-interactive-terminal-0.2.0.tgz`, install it without cloning or building the source:

```sh
dsh plugin --profile web add ./dsh-interactive-terminal-0.2.0.tgz
dsh --profile web --no-open
```

The tarball includes the host and browser builds and has no build-on-install or `postinstall` step. Its dependencies may still require registry access. To download a published tarball separately, use `npm pack dsh-interactive-terminal@0.2.0`.

## Use the terminal

- At an idle shell, type directly in the terminal. The first key requests input ownership; later keys wait for the grant.
- When a model-started program asks for input, click **Take over input**, wait for the grant, then answer. Handoff keeps the same process, sends no signal, and clears that operation's model deadline. Later operations remain queued until the interaction ends. Take over before `operationTimeoutMs` expires; stale or recovering targets are rejected.
- Typing during model ownership does not queue an answer for later shell execution. Enter submits input but does not release ownership; a controlled shell prompt or exit does.
- **Interrupt input** sends `SIGINT` to the re-inspected foreground group. It interrupts the program, not hands off control, and retains ownership until prompt recovery.
- **Terminal settings** provides reconnect, local clear, text size and confirmed reset. Collapse, clear and reconnect keep the shell alive. Resizing changes only the visible panel, not PTY geometry.

One browser controls an Agent's terminal; additional views and all mobile views are read-only. Independent model sends, human input, signals and resets run in acceptance order. Handoff transfers the active slot in place; reads bypass the queue.

One takeover lease covers every prompt in the same foreground interaction. Enter submits an answer without notifying the Agent, and reconnect resumes the same lease. When the interaction returns to the controlled Shell prompt, exits, or finishes interrupt recovery, the plugin notifies the owning Agent once. The Agent reads `shared_terminal_read` before sending later terminal input or signals; its `text` and `viewport` are cumulative for the PTY generation, not isolated to that handoff. A live REPL or TUI sends no completion notice until it exits or is interrupted.

## Configuration

Add an override to `~/.dsh/profiles/web/cordis.patch.yml`, or `$DSH_HOME/profiles/web/cordis.patch.yml` when using a custom home:

```yaml
- id: dsh-interactive-terminal
  config:
    shellPath: /bin/bash
    shellArgs: [--noprofile, --norc, -i]
    rows: 40
    cols: 160
```

A patch replaces the row's entire `config`; include all custom values you want to retain. Omitted fields use the defaults below. Resetting the terminal creates a new shell and loses its in-memory state.

| Field | Default | Meaning |
| --- | ---: | --- |
| `shellPath` | `/bin/bash` | Bash executable; other shells are rejected. |
| `shellArgs` | `--noprofile --norc -i` | Interactive-shell arguments; no empty arguments. |
| `rows` | `40` | Fixed PTY rows. |
| `cols` | `160` | Fixed PTY columns. |
| `scrollbackLines` | `10000` | Retained history lines, excluding the viewport. |
| `scrollbackMaxBytes` | `4194304` | UTF-8 limit for serialized ANSI history, excluding the viewport. |
| `maxToolOutputBytes` | `262144` | Complete tool-result JSON limit; at least `1024`, no greater than `scrollbackMaxBytes`. |
| `maxInputBytes` | `65536` | Input bytes per model send or accepted human input lease. |
| `maxQueuedOperations` | `128` | Accepted mutations per Agent, including the active operation. |
| `maxSessions` | `32` | Maximum live Agent terminals. |
| `pollIntervalMs` | `50` | Delay after each foreground check before the next check. |
| `operationTimeoutMs` | `30000` | Model mutation deadline before interrupt recovery. |
| `interruptTimeoutMs` | `5000` | Controlled-prompt recovery deadline after `SIGINT`. |
| `disconnectGraceMs` | `15000` | Controller disconnect grace before human-input recovery. |
| `disposeGraceMs` | `3000` | Process-tree termination grace during reset or teardown. |

## Model tools

All four tools use the executing Agent's terminal. Callers cannot select another Agent, PTY, working directory, shell, environment or sandbox.

| Tool | Behavior |
| --- | --- |
| `shared_terminal_send({ text, submit? })` | Write text; `submit` defaults to `true` (append Enter). Return on prompt, observed `stdin_read`, handoff, exit or timeout/cancellation recovery. |
| `shared_terminal_read({ offset?, count? })` | Read without acquiring input ownership. `offset` skips history lines from the newest end; `count` selects preceding lines. |
| `shared_terminal_signal({ signal })` | Queue `SIGINT`, `SIGTERM`, `SIGKILL`, `SIGTSTP` or `SIGHUP` for the foreground group. Top-level shell `SIGKILL` is refused. |
| `shared_terminal_reset({})` | Queue teardown and a fresh shell; also replaces a naturally exited shell. |

Results include generation, output sequence, geometry, viewport, cursor, process/queue status, holder, pending count and truncation state. Mutations add queue time and `waitReason`; send/signal add captured operation output. Reads add `text`, `lineBegin` (inclusive), `lineEnd` (exclusive) and `totalLines`. Cursor coordinates are zero-based. Tool rendering uses the same captured output; the complete JSON is byte-bounded and truncation retains the newest valid UTF-8 suffix.

`waitReason: human_handoff` means the user owns an ongoing interaction, not that the command completed. The model must wait for the user rather than submit another answer. A timeout likewise does not prove process exit.

## Recovery and limits

Reconnect restores a bounded snapshot before live output and validates connection, generation and sequence. The browser uses xterm's ordered queue; the host batches buffered output and publishes it only after parsing. A rejected browser write requires explicit **Reconnect**. This is not end-to-end backpressure for sustained high-volume output. Disconnected controllers remain subject to `disconnectGraceMs`.

- A natural exit retains the final screen and status until reset.
- `queue is blocked until reset`: interrupt recovery missed its deadline. Only the earliest queued reset can recover; later mutations are rejected.
- `terminal queue is full`: wait for accepted operations rather than retrying in parallel.
- `terminal capacity reached`: dispose an Agent or finish pending cleanup before increasing `maxSessions`.
- macOS rc.8 does not report `stdin_read`. Use explicit takeover for interactive prompts before the model deadline. Linux can yield on an observed stdin wait, but Linux native validation and multi-round REPL validation remain outstanding.
- `TERM=dumb`, fixed geometry and `PAGER=cat` are intentional. Full-screen or query-dependent TUIs are unsupported; renderer-generated query replies are suppressed and the host has no query responder.

## Security

The host owns terminal identity, workspace and sandbox policy. Required confinement must be available or startup fails; it never falls back to unconfined execution. The shell does not inherit Harness credentials.

Browser attachment uses hashed, Agent-bound, single-use tokens valid for 10 seconds. The WebSocket accepts no caller-selected Agent, session or PTY identifier. Raw PTY output and human keystrokes are not session events; model tool arguments and bounded results are logged normally. The completion notice contains lifecycle metadata only; PTY output and human answers still reach the model only through terminal tool results.

Reset, Agent disposal and plugin unload/HMR revoke connections and terminate the owned process tree. Custom subprocess providers must re-inspect the foreground at signal delivery and refuse top-level shell `SIGKILL`, as the official rc.8 provider does.

## Development and packaging

From a source checkout:

```sh
pnpm install
pnpm run build
npm pack --dry-run
npm pack
```

Install the resulting `.tgz` using the commands above. For isolated verification, set `DSH_HOME` to a fresh directory before both installation and startup. The keyless Web tests use a replay model with a real Agent loop and native PTY, not a live model.

Build and verification do not publish. Before manual publication, run the release checks, inspect package contents and confirm the npm account, registry, version and explicit publishing authorization. Never put credentials in the repository or logs.

## License

MIT. See [LICENSE](LICENSE).
