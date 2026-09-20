# dsh-interactive-terminal

[English](README.md) | 中文

在 DeepSeek Harness Web 中提供模型与用户共享的持久 Bash 终端。每个存活的 Agent 独占一个 PTY，通过 xterm.js 显示在对话输入框上方。模型可以调用终端工具，用户也可以在同一交互进程中继续输入，无需另开 shell。

![完成多轮 UTF-8 终端交互后的 Controller 视图](assets/terminal-in-use.png)

> 模型启动交互程序后，用户完成四轮 UTF-8 输入时的已连接 Controller 视图。

## 快速开始

要求：macOS 或 Linux、Bash、Node.js `^22.19 || >=24`，且 `PATH` 中有 pnpm。插件 `0.1.0` 已针对 DSH `0.1.0-rc.8` 和 pnpm `10.18.3` 验证。

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.8 pnpm@10.18.3
dsh plugin --profile web add dsh-interactive-terminal@0.1.0
dsh --profile web
```

打开 DSH 输出的 Web 地址，按需配置模型，选择工作区和对话，再点击 **Open terminal（打开终端）**。在空闲提示符下输入 `echo hello`，即可验证浏览器输入。以后启动只需：

```sh
dsh --profile web
```

## 安装

### 使用已安装的 DSH CLI 加载 npm 包

```sh
dsh plugin --profile web add dsh-interactive-terminal@0.1.0
dsh --profile web
```

插件命令会把包安装到 Web profile，并自动启用包内的 `cordis.patch.yml`，无需额外添加 `--patch`。仅执行 `npm install -g` 全局安装插件不会在 DSH 中启用它。

安装和启动必须使用同一个 `DSH_HOME`，默认值是 `~/.dsh`。添加或更新插件后，需要重启已运行的 DSH。若 pnpm 报告没有可用版本，请确认 profile 使用 npm 公共 registry：

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm config set registry https://registry.npmjs.org/ --location=project
```

### 从 DSH 源码加载 npm 包

使用插件支持的 DSH 标签，再运行仓库中的源码 CLI：

```sh
git clone --branch dsh-v0.1.0-rc.8 --depth 1 https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm dsh plugin --profile web add dsh-interactive-terminal@0.1.0
pnpm dsh --profile web
```

第一个 `pnpm dsh` 等价于已安装的 `dsh` 命令，但直接运行源码。Profile 仍保存在同一个 `DSH_HOME` 下，因此后续从源码启动只需执行最后一条命令。

### 从插件源码安装

```sh
git clone https://github.com/mingzhicode/dsh-interactive-terminal.git
cd dsh-interactive-terminal
pnpm install
pnpm run build
dsh plugin --profile web add "$PWD"
dsh --profile web
```

Profile 会加载本地 checkout 中已构建的 `lib/` 和 `dist/` 文件。修改插件源码后，需要重新构建并重启 DSH。如果同时使用 DSH 源码，请在 DSH 仓库中运行 `pnpm dsh`，并把本插件的绝对目录传给 `plugin add`。

### 安装已下载的 npm 压缩包

```sh
dsh plugin --profile web add ./dsh-interactive-terminal-0.1.0.tgz
dsh --profile web
```

压缩包包含服务端和浏览器构建产物，安装时不执行构建或 `postinstall`；安装依赖仍可能需要访问 registry。可用 `npm pack dsh-interactive-terminal@0.1.0` 单独下载已发布的压缩包。

## 交互过程

1. 点击 **Open terminal（打开终端）**。首次展开面板或首次调用 Agent 工具时，才为该 Agent 创建 shell。
2. 确认状态栏以 **Controller** 开头。Shell 空闲时可以直接输入；首个按键申请人工输入权，后续按键等待授权。
3. 让模型调用 `shared_terminal_send` 启动程序。模型操作占用队列时，普通键盘输入会被忽略，不会在稍后变成 shell 命令。
4. 程序要求输入时，点击 **Take over input（接手输入）**，等待授权后再输入。接手保留原进程、不发送信号，并解除模型操作的时限。
5. 在同一个 PTY 中继续输入文字、Enter、emoji 或其他 UTF-8 内容。Enter 只提交输入，不释放输入权；验证过的 shell 提示符或进程退出才结束本轮交互。所有人工交互完成后，无论是从空闲提示符直接输入还是通过接手输入，插件都会直接通知 Agent，使其读取终端并继续执行。
6. 使用 **Interrupt input（中断输入）** 向重新检查后的前台进程组发送 `SIGINT`。它会中断程序，并保持输入权直到提示符恢复；它不是输入接手。

设置菜单提供 **Reconnect（重新连接）**、本地 **Clear view（清除显示）**、字号调整和需要确认的 **Reset Terminal（重置终端）**。折叠面板、清屏或重连不会结束 shell；调整面板大小也不会改变固定的 PTY 行列数。服务端销毁终端时，面板会关闭并清理本地渲染器和未发送输入；短暂断线仍会自动重连。

每个 Agent 只允许一个浏览器视图控制终端，其他视图和所有移动端视图均为只读。**Take over input** 是把模型当前占用的队列操作转交给浏览器 Controller，并不会从另一个浏览器视图夺取 Controller。若状态栏显示 **Read only**，请关闭控制端视图，等待 `disconnectGraceMs`，再点击 **Reconnect**。

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

Patch 会替换该条目的完整 `config`；请写入所有需要保留的自定义值。省略字段使用下表默认值。

插件加载时解析配置。修改 patch 后需要重启 DSH，新值才会生效。**Reset Terminal** 会销毁当前 shell，并使用内存中已经加载的配置创建新代次；它不会重新读取 YAML 文件。

| 字段 | 默认值 | 生效方式 |
| --- | ---: | --- |
| `shellPath` | `/bin/bash` | Bash 可执行文件，不支持其他 shell；创建终端代次时使用。 |
| `shellArgs` | `--noprofile --norc -i` | 交互式 shell 参数，不允许空参数；生成 shell 时使用。 |
| `rows` | `40` | 每个新终端代次固定的 PTY 行数。 |
| `cols` | `160` | 每个新终端代次固定的 PTY 列数。 |
| `scrollbackLines` | `10000` | 保留的历史行数，不含视口；用于服务端快照和浏览器渲染器。 |
| `scrollbackMaxBytes` | `4194304` | 序列化 ANSI 历史的 UTF-8 字节上限，不含视口。 |
| `maxToolOutputBytes` | `262144` | 完整工具结果 JSON 的字节上限；至少 `1024`，且不超过 `scrollbackMaxBytes`。 |
| `maxInputBytes` | `65536` | 单次模型发送或一次人工输入授权的字节上限。 |
| `maxQueuedOperations` | `128` | 每个 Agent 接受的修改操作数上限，包含当前操作。 |
| `maxSessions` | `32` | 存活 Agent 终端数上限。 |
| `pollIntervalMs` | `50` | 两次前台进程检查之间的等待时间。 |
| `operationTimeoutMs` | `30000` | 模型修改操作进入中断恢复前的时限。 |
| `interruptTimeoutMs` | `5000` | 发送 `SIGINT` 后等待受控提示符恢复的时限。 |
| `disconnectGraceMs` | `15000` | Controller 断开后，在恢复并释放人工输入权前保留重连机会的时间。 |
| `disposeGraceMs` | `3000` | 重置或销毁时终止进程树的宽限时间。 |

## 方案说明

### 终端持有与生命周期

- 终端属于确切的存活 Agent，而不是浏览器标签页或某次工具调用。首次展开 UI 或调用工具时，才在该 Agent 的工作区和 sandbox 策略下创建终端。
- 折叠面板和通过认证的重连会保留原 shell。重连先恢复有界屏幕快照，再接收实时输出，并校验终端代次和输出序号。
- 每个 Agent 只有一个浏览器 WebSocket 是 Controller。私有重连凭证可以在 `disconnectGraceMs` 内恢复控制权；其他桌面视图和所有移动端视图只读。
- 重置会终止当前进程树并创建新代次。Agent 销毁、插件卸载和 HMR 会撤销浏览器连接并终止所属进程树。Shell 自然退出后保留最终屏幕，直到重置。

### FIFO 队列、接手与恢复

- 模型发送、人工输入授权、信号和重置共用每个 Agent 的严格 FIFO 修改队列，按接受顺序执行；`shared_terminal_read` 不占用输入权并绕过该队列。
- 已授权的模型发送可以原地转交给 Controller。接手保留当前队列位置、清除模型超时、向模型返回 `waitReason: human_handoff`，并让后续操作继续等待。
- 提示符、检测到的前台 `stdin_read` 或进程退出会完成当前操作。macOS 上的 DSH `rc.8` 不报告 `stdin_read`，因此交互提示需要在 `operationTimeoutMs` 到期前显式接手。
- 模型超时或取消时，会向重新检查后的前台进程组发送 `SIGINT`，恢复提示符前不会释放队列。若在 `interruptTimeoutMs` 内未恢复，队列进入 blocked 状态；只有最早接受的 reset 可以替换它。
- 配置会限制队列长度、输入字节、保留输出、工具 JSON 和存活 Agent 终端数。输出快照截断时保留最新的有效 UTF-8 后缀。

## Agent 工具

四个工具都作用于当前执行 Agent 的终端。调用者不能另选 Agent、PTY、工作目录、shell、环境或 sandbox。

| 工具 | 行为 |
| --- | --- |
| `shared_terminal_send({ text, submit? })` | 排队发送模型输入。`submit` 默认为 `true`，会附加 Enter；在提示符、检测到 `stdin_read`、人工接手、退出或超时/取消恢复时返回。 |
| `shared_terminal_read({ offset?, count? })` | 不申请输入权，读取视口和相对最新端的历史分页。`offset` 从最新端跳过行，`count` 选择此前的行。 |
| `shared_terminal_signal({ signal })` | 排队向重新检查后的前台进程组发送 `SIGINT`、`SIGTERM`、`SIGKILL`、`SIGTSTP` 或 `SIGHUP`；拒绝对顶层 shell 发送 `SIGKILL`。 |
| `shared_terminal_reset({})` | 排队终止进程树并创建新 shell 代次，也用于替换自然退出的 shell。 |

结果包含终端代次、输出序号、行列数、视口、光标、进程与队列状态、当前持有者、排队数和截断状态。修改类操作另含排队时长和 `waitReason`；发送与信号另含捕获的操作输出。读取另含 `text`、`lineBegin`（含）、`lineEnd`（不含）和 `totalLines`。光标坐标从零开始。

`waitReason: human_handoff` 表示用户持有仍在运行的交互，不表示命令已经完成。模型必须等待，不应在人工输入授权之后继续提交回答。超时同样不能证明前台进程已经退出。

## 恢复与限制

- `queue is blocked until reset`：中断恢复超时。等待最早接受的 reset；后续修改操作会被拒绝。
- `terminal queue is full`：等待已经接受的操作完成，不要并行重试。
- `terminal capacity reached`：先结束 Agent 或等待清理完成，再考虑提高 `maxSessions`。
- 浏览器写入被拒绝后，需要显式点击 **Reconnect**。Controller 断开恢复仍遵守 `disconnectGraceMs`。
- 固定使用 `TERM=dumb`、固定行列数和 `PAGER=cat`。不支持全屏或依赖终端查询的 TUI；浏览器会抑制自动生成的查询回复，Host 也没有查询响应器。
- Linux 可以在检测到前台标准输入等待时让出输入权，但 Linux 原生环境和多轮 REPL 尚待验证。

## 安全

Host 决定终端身份、工作目录和 sandbox 策略。需要隔离时，如果隔离不可用就拒绝启动，不会退回非隔离执行。Shell 不继承 Harness 凭据。

浏览器使用与 Agent 绑定、只存哈希、十秒有效的一次性令牌连接。WebSocket 不接受调用者指定的 Agent、Session 或 PTY 标识。原始终端输出和人工按键不作为会话事件记录；模型工具参数和有界结果仍正常记录。

自定义 subprocess provider 必须和官方 DSH `rc.8` provider 一样，在发送信号时重新检查前台进程组，并拒绝对顶层 shell 发送 `SIGKILL`。

## 开发与打包

```sh
pnpm install
pnpm run build
npm pack --dry-run
npm pack
```

生成的 `.tgz` 可以按上方压缩包方式安装。需要隔离验证时，请在安装和启动前把 `DSH_HOME` 设为新目录。无密钥 Web 测试使用回放模型、真实 Agent loop 和原生 PTY，不等同于实时模型测试。

构建和验证不会发布 npm 包。手工发布前需运行发布检查、核对包内容，并确认 npm 账户、registry、版本和明确的发布授权。不要把凭据写入仓库或日志。

## 许可证

MIT，见 [LICENSE](LICENSE)。
