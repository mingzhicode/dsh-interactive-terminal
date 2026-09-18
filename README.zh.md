# dsh-interactive-terminal

`dsh-interactive-terminal` 为每个存活的 DeepSeek Harness Agent 提供一个持久 Bash 终端。浅色、可折叠的终端停靠区位于对话输入框上方，模型与浏览器通过服务端权威的严格 FIFO 队列共享同一进程。0.1 版本面向 macOS 和 Linux，并使用 `@deepseek-ai/dsh` `0.1.0-rc.8` 的公开接口。

## 安装本地候选发布包

安装前先构建并检查包内容。安装后不会执行构建或 `postinstall`。

```sh
pnpm run build
npm pack --dry-run
npm pack
pnpm exec dsh plugin --profile web add ./dsh-interactive-terminal-0.1.0.tgz
pnpm exec dsh --profile web --no-open
```

插件命令会把 tarball 加入 `DSH_HOME` 下的普通 Web profile，并激活它声明的 bundle 层。需要隔离验证时，应先把 `DSH_HOME` 指向一个新的临时目录。在包尚未发布前，不要使用裸 registry 包名。手工发布完成后，等价命令才是 `dsh plugin --profile web add dsh-interactive-terminal`。

打开 Web 地址，创建或选择 Agent，然后展开输入框上方的 **Terminal**。首次工具调用或首次展开停靠区时，插件才为该 Agent 创建 shell。通过 **Terminal settings** 可以重新连接、清除本地显示、调整字号，或在确认后重置终端。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖已安装条目：

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

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `shellPath` | `/bin/bash` | Bash 可执行文件。0.1 版本拒绝其他 shell。 |
| `shellArgs` | `--noprofile --norc -i` | 交互式 shell 参数；不允许空参数。 |
| `rows` | `40` | 每个 PTY generation 的固定后端行数。 |
| `cols` | `160` | 每个 PTY generation 的固定后端列数。 |
| `scrollbackLines` | `10000` | 视口之外最多保留的历史行数。 |
| `scrollbackMaxBytes` | `4194304` | 一次序列化 ANSI 历史回放的 UTF-8 字节上限，不含固定视口。 |
| `maxToolOutputBytes` | `262144` | 成功工具结果完整 JSON 序列化后的 UTF-8 字节上限。最小值为 `1024`，且不得超过 `scrollbackMaxBytes`。 |
| `maxInputBytes` | `65536` | 一次模型发送或一次已接受人工输入 lease 的字节上限。 |
| `maxQueuedOperations` | `128` | 单个 Agent 已接受 mutation 的上限，包含当前操作。 |
| `maxSessions` | `32` | 存活的 Agent 终端 generation 上限。 |
| `pollIntervalMs` | `50` | 上一次前台进程检查完成后，到下一次检查开始前的等待时间。 |
| `operationTimeoutMs` | `30000` | 模型 mutation 进入中断恢复前的时限。 |
| `interruptTimeoutMs` | `5000` | 恢复发送 `SIGINT` 后等待受控提示符的时限。 |
| `disconnectGraceMs` | `15000` | controller 断开后，结束人工所有权前的宽限时间。 |
| `disposeGraceMs` | `3000` | reset 或 teardown 终止进程树时的宽限时间。 |

停靠区参与输入框的正常页面布局，过宽的终端内容只在停靠区内滚动。浏览器尺寸变化、停靠区的纵向调整和字号控制只改变可见视口，不会改变 `rows`、`cols`、`stty` 或 PTY geometry。折叠停靠区只隐藏现有终端，不会结束 shell 或释放输入所有权。

## 模型工具

四个工具都只作用于正在执行它们的 Agent；调用者不能选择 session、PTY、工作目录、shell、环境、sandbox 或其他 Agent。

- `shared_terminal_send({ text, submit? })` 写入文本，并默认附加 Enter。它在受控提示符、检测到 `stdin_read`、显式人工接手、shell 退出、超时恢复或取消恢复时返回。`waitReason: human_handoff` 表示人工已接手仍在运行的交互，不代表程序完成；模型应等待用户，而不是继续提交回答。
- `shared_terminal_read({ offset?, count? })` 不进入 mutation 队列。`offset` 从最新端跳过保留的历史行，`count` 选择此前的一页。`lineBegin` 是保留历史中的闭区间起点，`lineEnd` 是开区间终点，`totalLines` 是当前历史长度。结果还包含当前 viewport 和从零开始的 cursor 坐标。
- `shared_terminal_signal({ signal })` 把 `SIGINT`、`SIGTERM`、`SIGKILL`、`SIGTSTP` 或 `SIGHUP` 排队发送给前台进程组。对顶层 shell 的 `SIGKILL` 会被拒绝。
- `shared_terminal_reset({})` 按队列顺序销毁当前 generation 并创建新 shell。自然退出的 shell 只能通过 reset 替换。

成功结果包含 generation、输出 sequence、固定 geometry、viewport、cursor、进程状态、队列状态、holder、pending 数和截断状态，以及各操作专用字段。Mutation 结果还包含排队时长和 `waitReason`；send 与 signal 包含该操作期间捕获的输出。`maxToolOutputBytes` 限制的是完整序列化 JSON，而不只是输出字段。需要截断时保留最新的有效 UTF-8 后缀，并设置 `truncated`。工具渲染器使用同一份受限操作输出。

## 队列、所有权与恢复

每个精确的存活 Agent 最多拥有一个惰性创建的 PTY，两个 Agent 从不共享终端状态。独立的模型 send、人工输入、signal 和 reset 进入同一个按接受顺序排列的严格队列；read 不申请输入占用。人工接手是在原位置交接当前操作，不是在排队工作之前插入另一项操作。

模型启动的程序需要回答时，点击 **Take over input（接手输入）**，等待人工授权后直接在同一个终端输入。接手不发送信号，会清除该操作的模型超时计时器；后续操作仍排队等待人工交互结束。模型占用期间键入的回答不会被缓存为稍后的 Shell 命令。接手请求绑定确切操作和 generation；目标过期或已经进入恢复时拒绝请求，不应用于后来的命令。需要在 `operationTimeoutMs` 到期前接手，默认期限为 30 秒；已经被中断的程序不能通过接手复活。

Shell 可用时，浏览器的首个按键会原子地申请人工 lease，并携带该按键。Host 授权前，后续按键留在浏览器缓冲区。Enter 只提交输入，本身不释放所有权；受控 Shell 提示符或退出结束交互。**Interrupt input（中断输入）** 会向重新检查后的前台进程组发送 `SIGINT`，并持续占用队列槽直到提示符恢复；这是中断程序，不是接手按钮。超时不代表命令已经退出。恢复失败会把队列置为 `blocked`，只有最早排队的 reset 可以恢复。

Shell 自然退出后会保留最终屏幕和退出状态。折叠面板、清除本地视图或重新连接都不会替换 shell。重新连接先接收有界快照和 sequence 水位，再接收实时输出，因此会替换过期浏览器状态，也不会无界回放。

浏览器输出直接进入 xterm 原生有序写入队列，不逐段等待，也不逐段更新 React 工具栏。每次重连快照都会创建新的浏览器渲染实例，保留字号并隔离旧队列，不会重建 PTY；连接、generation 和 sequence 校验继续生效。xterm 负责统计待处理数据并限制原生缓冲区；写入被拒绝时会断开连接、显示提示，等待用户显式点击 **Reconnect**。这不是针对持续海量输出的端到端背压；人工 controller 断线后仍遵守 `disconnectGraceMs` 恢复规则。

Host 合并 PTY 流中已经缓冲的字节，每个合并批次不超过流的 readable high-water mark，不延迟首个到达的数据块。每批数据完成屏幕解析与操作输出捕获后才发布。前台进程检查完成后再等待 `pollIntervalMs`，即使 provider 同步扫描进程，也会为输出处理留出间隔；发送信号时仍会独立检查前台进程。

每个 Agent 最多有一个浏览器 controller。其他浏览器视图为只读；0.1 版本的所有移动端视图均为只读。

## 安全与日志

Host 通过公开 Agent registry 解析所选 session，并负责工作目录、sandbox policy、环境和 PTY 身份。Attach token 使用密码学随机数，保留时只保存哈希，与单个 Agent 绑定，10 秒有效，并且只能通过固定升级路径上的 WebSocket subprotocol 使用一次。WebSocket 不接受 Agent、session 或 PTY id。

Shell 只接收显式终端环境变量，不继承 Harness credentials。原始 PTY 字节和人工按键不会成为 session event。模型工具参数和有界结果仍是普通工具日志，因此所有模型可见的终端内容都可重建，而无需记录人工终端流。

插件卸载、HMR、Agent disposal 和 reset 会撤销 token、关闭 socket、结算排队工作并终止所属进程树。自定义 subprocess provider 必须与官方 rc.8 provider 一样在发送信号时重新检查前台进程，并拒绝对顶层终端 shell 发送 `SIGKILL`。

## 限制与排障

- 0.1 版本仅支持 macOS 和 Linux 上的本地 Bash。Windows 和非 Bash `shellPath` 会在激活时失败。
- macOS rc.8 支持普通模型命令，以及对模型启动的交互程序显式人工接手。官方 macOS 进程检查器不报告 `stdin_read`；若未在期限内接手，等待中的模型操作会进入超时恢复。Linux 检测到 `stdin_read` 后可以释放模型输入占用，让下一次输入接续前台程序。自动模型驱动的 `stdin_read` 和多轮 REPL 仍是 Linux 验证目标；本候选发布包尚未执行 Linux 原生验证。
- 浏览器会抑制 renderer 自动生成的终端查询回复，Host 也没有设备查询 responder。Shell 使用 `TERM=dumb`、固定 geometry 和 `PAGER=cat`；不支持全屏或依赖查询的 TUI。
- 受限 sandbox 模式要求 Agent 具有可用且处于同一执行环境的 sandbox provider。缺失或不可用的 confinement 会在 shell 启动前失败，不会退回非受限进程。
- `terminal capacity reached` 表示已达到 `maxSessions`，其中可能包含尚在清理的 generation。应先 dispose Agent 或等待 reset/清理完成，再考虑提高限制。
- `terminal queue is full` 表示该 Agent 已达到 `maxQueuedOperations`。应等待已接受工作完成，不要并行重试 mutation。
- `queue is blocked until reset` 表示中断恢复未能在 `interruptTimeoutMs` 内到达受控提示符。使用最早排队的 reset；其后的 mutation 仍会被拒绝。

无密钥 Web acceptance 使用脚本化 replay provider，但运行真实 Agent loop 和原生 PTY；它不是实时模型演示。本地实时模型 GUI 证据覆盖 macOS 普通命令和人工交互；上述 Linux 目标仍未执行。

## 手工发布清单

发布绝不是构建或验证的一部分。

1. 运行发布检查并查看 `npm pack --dry-run`；确认只包含 `lib/`、`dist/client.js`、Cordis patch、包元数据、中英文 README、changelog 和 license。
2. 显式登录 npm，并确认目标账户和 registry；不要把凭据复制到本仓库或日志。
3. 针对这个确切 tarball 和版本取得用户明确授权。
4. 只有此时才运行 `npm publish`，并在使用裸包名安装命令前验证 registry 包。

## 许可证

MIT，见 [LICENSE](LICENSE)。
