# dsh-interactive-terminal

[English](README.md) | 中文

在 DeepSeek Harness Web 中提供模型与用户共享的持久 Bash 终端。每个存活的 Agent 独占一个 PTY，使用 xterm.js 显示在对话输入框上方的可折叠面板中。输入操作严格按 FIFO 排队，用户可显式接手模型启动的交互程序。

## 安装与启动

要求：macOS 或 Linux、Bash、Node.js `^22.19 || >=24`。本插件已针对 DSH `0.1.0-rc.8` 验证，其他 DSH 版本尚未验证。DSH 插件命令需要 `PATH` 中有 pnpm。

### 从 npm 安装

安装已验证版本的 CLI 和包管理器；如果已有这些版本，可跳过：

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.8 pnpm@10.18.3
```

插件 `0.1.0` 发布到 npm 后，安装到 Web profile 并启动 DSH：

```sh
dsh plugin --profile web add dsh-interactive-terminal@0.1.0
dsh --profile web --no-open
```

按包名安装要求该版本已发布；若返回 `404`，请使用下方的 `.tgz` 安装方式。只执行 `npm install -g` 全局安装插件，不会在 DSH 中启用它。

`dsh plugin` 会下载包到 Web profile 并自动启用，无需额外添加 `--patch`。安装和启动必须使用同一个 `DSH_HOME`，默认为 `~/.dsh`。安装后，已运行的 DSH 需要重启。

打开 DSH 输出的 Web 地址，按需配置模型，选择工作区和对话，再展开 **Terminal**。首次展开或首次工具调用时创建 shell。在空闲提示符下输入 `echo hello`，即可验证输入输出。以后只需运行：

```sh
dsh --profile web --no-open
```

### 安装已下载的 npm 压缩包

如果已获得 `dsh-interactive-terminal-0.1.0.tgz`，无需克隆或构建源码，直接安装：

```sh
dsh plugin --profile web add ./dsh-interactive-terminal-0.1.0.tgz
dsh --profile web --no-open
```

压缩包已包含服务端与浏览器构建产物，安装时不执行构建或 `postinstall`；安装依赖仍可能需要访问 registry。若要单独下载已发布的压缩包，可运行 `npm pack dsh-interactive-terminal@0.1.0`。

## 使用终端

- Shell 空闲时直接输入。首个按键申请输入权，后续按键等待授权。
- 模型启动的程序需要回答时，点击 **Take over input（接手输入）**，等待授权后输入。接手保留原进程、不发送信号，并解除当前操作的模型超时；后续操作继续排队。须在 `operationTimeoutMs` 到期前接手，过期或正在恢复的目标会被拒绝。
- 模型占用期间键入的回答不会排队成为稍后的 shell 命令。Enter 只提交输入，不释放输入权；受控 shell 提示符或进程退出才结束交互。
- **Interrupt input（中断输入）** 向重新检查后的前台进程组发送 `SIGINT`，并保持输入权直到提示符恢复。这是中断，不是接手。
- **Terminal settings** 提供重连、清除本地显示、字号调整和需确认的重置。折叠、清屏、重连不结束 shell；面板缩放不改变 PTY 行列数。

每个 Agent 只允许一个浏览器控制终端，其他视图和所有移动端视图均为只读。独立的模型输入、人工输入、信号和重置按接受顺序执行；接手只转移当前队列位置，读取不占用输入权。

一次接手租约覆盖同一前台交互中的全部问题。Enter 只提交答案，不通知 Agent；重新连接恢复同一个租约。交互返回受控 Shell 提示符、退出或完成中断恢复后，插件只通知所属 Agent 一次。Agent 必须在后续终端 mutation 前调用 `shared_terminal_read`；其中的 `text` 和 `viewport` 是该 PTY generation 的累计内容，不是本次接手的独立输出。仍在运行的 REPL 或 TUI 只有在退出或被中断后才发送完成通知。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 中添加覆盖项；使用自定义目录时，路径为 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-interactive-terminal
  config:
    shellPath: /bin/bash
    shellArgs: [--noprofile, --norc, -i]
    rows: 40
    cols: 160
```

Patch 会替换该条目的整个 `config`，需写全要保留的自定义值；省略的字段使用下表默认值。重置终端会创建新 shell，原 shell 的内存状态随之丢失。

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `shellPath` | `/bin/bash` | Bash 路径，不支持其他 shell。 |
| `shellArgs` | `--noprofile --norc -i` | 交互式 shell 参数，不允许空参数。 |
| `rows` | `40` | PTY 固定行数。 |
| `cols` | `160` | PTY 固定列数。 |
| `scrollbackLines` | `10000` | 保留的历史行数，不含视口。 |
| `scrollbackMaxBytes` | `4194304` | 序列化 ANSI 历史的 UTF-8 字节上限，不含视口。 |
| `maxToolOutputBytes` | `262144` | 完整工具结果 JSON 的字节上限；至少 `1024`，不超过 `scrollbackMaxBytes`。 |
| `maxInputBytes` | `65536` | 单次模型发送或一次人工输入授权的字节上限。 |
| `maxQueuedOperations` | `128` | 每个 Agent 接受的操作数上限，含当前操作。 |
| `maxSessions` | `32` | 存活 Agent 终端数上限。 |
| `pollIntervalMs` | `50` | 前台进程检查完成后，到下一次检查前的等待时间。 |
| `operationTimeoutMs` | `30000` | 模型操作进入中断恢复前的时限。 |
| `interruptTimeoutMs` | `5000` | 发送 `SIGINT` 后等待受控提示符恢复的时限。 |
| `disconnectGraceMs` | `15000` | 控制端断开后，恢复人工输入占用前的宽限时间。 |
| `disposeGraceMs` | `3000` | 重置或销毁时终止进程树的宽限时间。 |

## 模型工具

四个工具均作用于当前 Agent 的终端，调用者不能另选 Agent、PTY、工作目录、shell、环境或 sandbox。

| 工具 | 行为 |
| --- | --- |
| `shared_terminal_send({ text, submit? })` | 写入文本，`submit` 默认为 `true`（附加 Enter）；在提示符、检测到 `stdin_read`、接手、退出或超时/取消恢复时返回。 |
| `shared_terminal_read({ offset?, count? })` | 不占用输入权；`offset` 从最新端跳过历史行，`count` 选取此前的行。 |
| `shared_terminal_signal({ signal })` | 排队向前台进程组发送 `SIGINT`、`SIGTERM`、`SIGKILL`、`SIGTSTP` 或 `SIGHUP`；拒绝对顶层 shell 发送 `SIGKILL`。 |
| `shared_terminal_reset({})` | 排队销毁并创建新 shell，也用于替换自然退出的 shell。 |

结果包含终端代次、输出序号、行列数、视口、光标、进程/队列状态、当前占用者、排队数和截断标记。修改类操作另含排队时长和 `waitReason`，发送/信号操作另含捕获的输出。读取另含 `text`、`lineBegin`（含）、`lineEnd`（不含）和 `totalLines`。光标坐标从零开始。工具界面使用同一份捕获输出；完整 JSON 受字节上限约束，截断时保留最新的有效 UTF-8 后缀。

`waitReason: human_handoff` 表示用户接手了仍在运行的交互，不表示命令完成。模型应等待用户，而不是继续提交回答；超时也不证明进程已退出。

## 恢复与限制

重连先恢复有界快照，再接收实时输出，并校验连接、终端代次与输出序号。浏览器使用 xterm 有序队列；服务端合并缓冲输出，解析后才发布。浏览器拒绝写入时需要显式点击 **Reconnect**。这不是持续海量输出的端到端背压；控制端断开后仍遵守 `disconnectGraceMs`。

- Shell 自然退出后保留最终屏幕和状态，直到重置。
- `queue is blocked until reset`：中断恢复超时，只有最早排队的重置可恢复，后续修改操作被拒绝。
- `terminal queue is full`：等待已接受操作完成，不要并行重试。
- `terminal capacity reached`：先结束 Agent 或等待清理完成，再考虑提高 `maxSessions`。
- macOS rc.8 不报告 `stdin_read`；交互提示需要在模型超时前显式接手。Linux 可在检测到标准输入等待时让出输入权，但 Linux 原生环境和多轮 REPL 尚待验证。
- 固定使用 `TERM=dumb`、固定行列数和 `PAGER=cat`。不支持全屏或依赖终端查询的 TUI；浏览器抑制自动查询回复，服务端也不提供查询响应器。

## 安全

服务端决定终端身份、工作目录和 sandbox 策略。需要隔离时，隔离不可用就拒绝启动，不会退回非隔离执行。Shell 不继承 Harness 凭据。

浏览器使用与 Agent 绑定、只存哈希、10 秒有效的一次性令牌连接；WebSocket 不接受调用者指定的 Agent、session 或 PTY 标识。原始终端输出和人工按键不作为会话事件记录；模型工具参数和有界结果仍正常记录。完成通知只包含生命周期元数据；PTY 输出和人工回答仍仅通过终端工具结果提供给模型。

重置、Agent 销毁及插件卸载/HMR 会撤销连接并终止所属进程树。自定义 subprocess provider 必须与官方 rc.8 provider 一样，在发送信号时重新检查前台进程，并拒绝对顶层 shell 发送 `SIGKILL`。

## 开发与打包

在源码目录执行：

```sh
pnpm install
pnpm run build
npm pack --dry-run
npm pack
```

生成的 `.tgz` 按上文安装。需要隔离验证时，在安装和启动前将 `DSH_HOME` 设置为新目录。无密钥 Web 测试使用回放模型、真实 Agent loop 和原生 PTY，不等同于实时模型测试。

构建和验证不会发布 npm 包。手工发布前需完成发布检查、核对包内容，并确认 npm 账户、registry、版本和明确的发布授权。不要将凭据写入仓库或日志。

## 许可证

MIT，见 [LICENSE](LICENSE)。
