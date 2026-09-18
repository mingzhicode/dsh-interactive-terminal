# Web example

This overlay adds the built package to the public `@deepseek-ai/dsh` rc.8 Web profile. It uses the official Web shell, client-module host, Agent loop, local PTY provider, and ordinary session events.

From this package directory, build the package, install it into the intended Web profile with `pnpm exec dsh plugin --profile web add "$PWD"`, then run `pnpm exec dsh --profile web --patch "$PWD/examples/web/cordis.yml" --no-open`. Configure credentials through Harness's normal settings before asking the live model to use `shared_terminal_send`.

For an isolated local launch without changing your existing profile, the acceptance launcher creates a temporary Harness home, agent home, workspace, and profile, then starts the same public CLI:

```sh
pnpm run build
node --input-type=module -e 'import {startWeb} from "./tests/web-app.mjs"; const app = await startWeb(); console.log(app.origin, app.workspace); process.on("SIGINT", async () => { await app.dispose(); process.exit() })'
```

Open the printed origin, accept the preview notice, select the printed workspace with the browser directory picker, and send a message to create an Agent. Expand **Terminal** to interact with its shared shell. Collapse retains the shell; **Reconnect** replaces the browser screen from the Host snapshot; **Reset Terminal** destroys the old shell and creates a new generation. Geometry remains 40 rows by 160 columns.

The default sandbox mode of the isolated acceptance launcher is `danger-full-access`; it is a localhost demonstration using a temporary workspace. The installed-profile command retains that profile's policy. The launcher selects the official browser directory picker and disables automatic LLM titles. An optional `credentialsPath` selects an existing managed store through the normal credentials provider with watching disabled; no credential values are read by the launcher.

## Keyless acceptance

`replay.json` is an explicit scripted model provider, not a recorded live response. The public replay adapter supplies five model responses to the real Agent loop, which executes the four real terminal tools. `expected.jsonl` is the stable projection of the resulting ordinary session log: tool calls, bounded tool results, and the final assistant message. Timing, PTY packet sequence, cursor location, and process ids are checked outside the snapshot; they are not portable snapshot fields. Replay uses the official persistence provider's uncompressed JSONL option. Raw human keys and PTY byte events are not session events.

```sh
pnpm exec playwright install chromium
pnpm vitest run tests/example.spec.ts tests/browser.e2e.spec.ts
```

To reuse an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. Each test creates a new browser context and a new server with isolated writable state. Browser acceptance observes actual WebSocket frames while driving only the normal UI: human input queues behind a model command; collapse and reconnect preserve the shell; reset advances the generation. To intentionally re-record the stable transcript after reviewing a behavior change, run the example test with `DSH_RECORD_EXPECTED=1`.

On macOS, rc.8 supports ordinary model commands and human terminal interaction. Model-driven `stdin_read` and multi-round REPL validation remain Linux targets and have not been executed on this host. No Host device-query responder is included.
