# Agent Web 工具

这里放置提供给 agent 的网络和浏览器工具。

## 对外工具

- `web.open`：打开 URL，后端自动创建或复用 browser session。
- `web.read`：读取当前页面；携带上一次的 `snapshotId` 时，可返回精简的 `unchanged`。
- `web.act`：在当前页面执行一个动作，必须携带 `snapshotId`。

这三个工具始终提供给 agent，不需要先通过 `tool_search` 激活。浏览器操作通常会跨越多个用户回合，保持常驻可以避免新回合丢失工具 schema 和名称映射。

agent 不需要处理 browser session、tab、control epoch、capture ID 或 observation revision。这些底层参数由本目录中的适配层自动补齐。

原有的 `browser.observe` 和 `browser.interact` 仍作为内部能力使用，不直接暴露给 agent。

## 浏览器生命周期

关闭 TinyOS 面板只会隐藏界面，保留 browser session，方便稍后继续。用户选择“Exit TinyOS and release browser”或删除所属聊天线程时，后端会关闭该 session 的所有 tab；Windows 上会调用 WebView 的 `close()` 并释放句柄。再次打开 TinyOS 时会按需新建 session。

## 分层

- `registry.rs`：定义 agent 可以看到的工具和输入 schema。
- `agent.rs`：实现 `web.open`、`web.read`、`web.act` 的高层流程。
- `browser.rs`：封装底层 browser observe/interact 调用和所有权检查。
- 浏览器 session、tab、事件和快照状态仍由 `native_browser` 管理。

## 快照状态

每个 tab 只维护当前状态：

```text
generation
revision
dirty
current observation
```

对 agent 暴露的 ID 为：

```text
<generation>.<revision>
```

例如 `b13ac72.4`。它只是一个不透明版本号。

不保存历史快照，也不在每个 `targetRef` 中重复携带 `snapshotId`。

`targetRef` 是不透明的语义节点引用，当前内部格式为：

```text
target-<observation revision>-<index>
```

其中 observation revision 只标识语义目标集合，不等同于页面级 `snapshotId`。agent 不应解析或拼接 `targetRef`。

返回给 agent 的 targets 只保留当前 viewport 中有名称或受保护含义的节点，并限制为最多 100 个。底层仍保留本次 observation 的完整目标映射。

## dirty 与刷新

页面 DOM 变化时，WebView 只发送 dirty 信号：

1. 后端把当前 tab 标记为 dirty。
2. 此时不生成或广播完整快照。
3. 下一次读取或动作前再执行 observe。
4. 如果语义内容确实变化，递增 revision。
5. 如果内容相同，只清除 dirty，保留原 snapshotId 和 targetRef。

用户直接输入和导航开始会立即推进 revision，避免 agent 在旧页面状态上继续操作。

## 动作校验

`web.act` 的基本流程：

```text
刷新 dirty 页面
→ 比较请求 snapshotId
→ 在浏览器命令锁内再次校验
→ 执行动作
→ observe 最新页面
→ 返回最新 snapshotId
```

如果 ID 已过期，动作不会执行：

```json
{
  "status": "stale_snapshot",
  "actionExecuted": false,
  "requestedSnapshotId": "b13ac72.3",
  "snapshotId": "b13ac72.4",
  "snapshot": {}
}
```

锁内二次校验用于处理“第一次比较后、真正点击前，用户又操作了页面”的竞态。

目标动作需要把字段放在 `action` 对象内：

```json
{
  "snapshotId": "b13ac72.4",
  "action": {
    "type": "clickTarget",
    "targetRef": "target-2-7"
  }
}
```

URL 跳转使用 `web.open`，不作为 `web.act` 动作。

## 转交给用户

密码、一次性验证码、CAPTCHA、支付信息、文件选择器等步骤不应由 agent 代替用户完成。agent 调用：

```json
{
  "snapshotId": "b13ac72.4",
  "action": {
    "type": "userHandoff",
    "reason": "请完成登录验证"
  }
}
```

浏览器进入 `user_required`，前端展示当前页面和原因。用户操作、切换标签页以及处理 popup 或外部协议期间都保持这个状态，但每次直接输入都会让旧快照失效。只有用户点击 “Hand control back to Agent” 后，前端才读取最新 control epoch、执行内部 `resume`，并在同一会话发起一个简短续接回合。agent 随后通过 `web.read` 获取新的 `snapshotId`。

`user_required` 期间 agent 只允许观察；`resume` 不对 agent 开放。弹窗和外部协议仍使用各自的 Allow/Deny 确认，处理完后继续保持用户控制，直到用户明确交回。

## 保持简单

当前设计刻意不做：

- 快照历史和回滚。
- 后台持续生成完整快照。
- agent 手动管理浏览器内部 ID。
- 额外的缓存、同步协议或全局静态状态表。

需要扩展时，优先保持 `web.*` 接口稳定，把浏览器实现细节留在后端。
