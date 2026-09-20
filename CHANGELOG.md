# Changelog

## 0.1.0 - Unreleased

- Add one persistent, Agent-owned Bash terminal shared by model tools and the Web controller through a strict FIFO mutation queue.
- Notify the owning Agent once after an explicit human handoff settles, then require a cumulative shared-terminal read before further terminal input or signals.
- Add four bounded terminal tools, fixed-geometry screen snapshots, reconnect and reset handling, invariant checks, and coordinated teardown.
- Support local Bash on macOS and Linux through public DeepSeek Harness rc.8 services; Linux native validation remains pending for model-driven `stdin_read` and multi-round REPL behavior.
- Document the current `TERM=dumb` device-query limitation and the read-only mobile experience.
