# 人工接手完成后通知 Agent

## 背景与目标

模型通过 `shared_terminal_send` 启动交互程序后，用户可以在原队列位置接手输入。接手成功时，原工具调用以 `waitReason: human_handoff` 返回；人工输入租约继续持有终端，直到受控 Shell 提示符恢复、Shell 退出或中断恢复结束。当前浏览器会在租约结束后撤销人工输入状态，但 Agent 不会收到完成事实，因此用户还需要在聊天框中手工提醒 Agent。

本次改动只为显式 `human.takeover` 增加一次自动完成通知。通知让仍在运行的 Agent 在下一步继续，或唤醒已经空闲的 Agent；Agent 随后通过现有 `shared_terminal_read` 获取终端内容。普通空闲 Shell 上的人工输入不触发通知，避免用户独立使用终端时无故启动模型请求。

## 接手与多轮输入

一次接手以服务端 `HumanLease` 为单位，不以一次按键或一次 Enter 为单位。npm 更新中的下载确认、版本选择和安装位置等多轮输入都复用同一个租约。Enter 只向当前前台程序提交答案，不结束租约，也不发送中间通知。只有前台程序结束并返回受控 Shell 提示符、Shell 退出，或租约经过中断恢复结算时，插件才发送一次通知。

浏览器重连恢复原 controller 和同一个租约，不创建新的完成源。通知绑定服务端操作对象，并在该对象的 `done` 结算路径中派发一次；重连、重复状态帧及 `human.revoked` 渲染不能再次派发。程序一直停留在 REPL 或 TUI 时租约仍未完成，因此不会通知；用户需要正常退出或使用现有“中断输入”动作。

## 通知内容与终端读取

通知只记录人工接手已经结算的生命周期事实，不复制原始 PTY 输出、人工按键或当前 viewport。消息包含 PTY generation、完成时的输出 sequence、`waitReason` 和终端状态，并明确要求 Agent 在发送新的终端输入或信号之前先调用 `shared_terminal_read`。消息使用 `source.kind: plugin`、插件名 `dsh-interactive-terminal` 和 `form: notice`，使会话投影能够把它与用户输入区分。

`shared_terminal_read` 保持现有累计读取语义。默认调用返回当前固定 viewport，以及该 PTY generation 中已经滚出 viewport 的最近 500 行历史；它不是本次接手的独立输出。通知因此要求 Agent 检查最新历史和 viewport，以最新内容为准；当最新页不足时，Agent 可以使用 `offset` 和 `count` 向更早历史分页。此次不增加按 operation 或 sequence 过滤的读取接口，也不保存第二份接手输出。

原始 PTY 字节和人工按键继续不进入会话日志。真正的终端内容仍只通过正常的 `shared_terminal_read` 工具调用与结果进入模型上下文。通知作为插件来源的 `user/message` 在被 Agent 认领时写入日志，因此完成事实和后续工具结果都可以从会话重建，不修改已经追加的 `shared_terminal_send` 工具结果，也不合成没有对应调用的工具结果。

## 投递与生命周期

人工租约结算后，Host 使用拥有该租约的精确 `Agent` 对象投递通知，不通过可复用 session id 重新查找：

- Agent 为 `running` 时调用 `inject()`，将通知放入最近的后续 step；下一步先读取终端，再继续原任务。
- Agent 为 `idle` 时调用 `followup()`，为通知打开新的 turn，并自动继续任务。
- Agent 已经销毁或正在销毁时不投递；投递期间的销毁竞态被视为完成通知随其 owner 一同丢弃，不转发给同 id 的替代 Agent。

正常提示符、Shell 退出和中断结算都发送真实完成原因。失败路径不能声称操作成功；若租约结算 Promise 拒绝，则通知说明人工接手失败并要求先读取终端状态。通知本身不写入 PTY、不申请队列位置，也不绕过后续 mutation 的 FIFO 顺序。`shared_terminal_read` 是只读操作并绕过输入队列，因此不会与先前的 `shared_terminal_send` 或人工租约竞争。

完成通知由显式人工接手触发，不会形成后台任务自行唤醒的循环，因此不增加次数预算或部署配置。一次接手最多产生一次通知；下一条交互命令需要新的模型发送和新的显式接手，结算后才能产生下一次通知。

## 实现边界

在 Host 侧把 `TerminalTransport` 已经等待的接手租约 `done` 结果交给一个小型通知函数。该函数负责构造有界摘要并选择 `inject()` 或 `followup()`；普通 `human.begin` 继续只管理终端输入。复用现有 `@deepseek-ai/dsh-llm` 消息构造器和 Agent 公共 API，不修改 DeepSeek Harness、agent-loop、队列协议、WebSocket 帧、四个工具 schema 或客户端界面。

同步系统提示词，说明 `human_handoff` 之后无需等待用户在聊天中确认：插件会在人工租约结算时通知，收到通知后必须先调用 `shared_terminal_read`。更新中英文 README，明确一次接手覆盖多轮人工确认、读取结果是累计终端状态，以及 REPL/TUI 未退出时不会通知。

## 验收

- 服务与传输测试证明接手租约的正常提示符、Shell 退出、中断和失败各投递一次，浏览器重连与重复状态事件不重复投递。
- Agent 为 `running` 时只调用 `inject()`，为 `idle` 时只调用 `followup()`；销毁中的 owner 和同 id 替代 Agent 均不接收通知。
- 普通 `human.begin`、只读连接、接手申请失败及尚未结算的多轮人工输入不发送通知。
- 多轮交互测试在同一租约中依次回答下载确认和安装位置，期间通知数为零；返回受控 Shell 后通知数为一。
- 通知不包含终端输出或人工答案，并要求先调用 `shared_terminal_read`；读取结果仍包含累计 `text`、`viewport` 和现有状态字段。
- keyless 组装 replay 更新模型可见 transcript，覆盖 `human_handoff`、完成 notice、`shared_terminal_read` 和继续执行的顺序。
- 运行受影响的队列、服务、传输、工具、真实 PTY、组装 Web、类型检查和构建验证；不发布 npm 包。

## 未采用方案

让原 `shared_terminal_send` 一直等待人工租约，会把 Agent turn 和人工交互重新耦合，并可能因长时间未退出的 REPL 或断线而无限占用运行状态。把 viewport 直接放入通知会改变“终端输出只经工具结果进入模型”的既有设计并重复记录内容。增加“完成并通知 Agent”按钮仍要求用户执行额外动作，且把完成判断错误地交给浏览器连接。这三种方式均不采用。
