# CLI 交互命令

## 启动方式

```bash
# 交互聊天模式
uv run tinybot agent

# 发送单条消息
uv run tinybot agent -m "你好"

# 指定会话
uv run tinybot agent -s session-key
```

## 内置命令

交互模式下可用以下命令：

| 命令 | 描述 |
|------|------|
| `/config` 或 `Ctrl+O` | 打开配置编辑器 |
| `/help` | 显示可用命令 |
| `/clear` | 清除对话历史 |
| `/new` | 开始新对话会话 |
| `/exit` 或 `:q` | 退出聊天 |

## 配置编辑器

按 `Ctrl+O` 或输入 `/config` 打开全屏配置编辑器：

- 分组显示配置项
- 可编辑 Agent、Provider、Tools 等设置
- 按 `q` 保存并返回聊天

## 实时进度显示

任务执行时在 CLI 显示实时进度：

```
┌──────────────────────────────────────────────┐
│ Tasks: ████████████░░░░░░░░ 60%               │
│                                                │
│ Running: extract_features                      │
│ Pending: generate_doc, write_summary           │
│ Completed: scan_directory, analyze_structure   │
└──────────────────────────────────────────────┘
```

## 输入快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 输入换行 |
| `Ctrl+O` | 打开配置 |
| `Ctrl+C` | 中断生成 |
| `Ctrl+D` | 退出 |

## 消息格式

### Markdown 支持

输入支持 Markdown 格式：

```
# 标题
- 列表项
**粗体**
`代码`
```

### 代码块

使用三引号包裹代码：

```
```python
def hello():
    print("Hello, World!")
```
```

## 多行输入

使用 `Shift+Enter` 输入多行内容，或粘贴完整代码块。

## 会话管理

### 查看会话

会话保存在 `~/.tinybot/sessions/` 目录：

```
~/.tinybot/sessions/
├── session-2026-04-20.json
├── session-2026-04-21.json
└── ...
```

### 继续会话

```bash
uv run tinybot agent -s session-key
```

## 输出格式

Agent 输出支持：

- Markdown 渲染
- 代码语法高亮
- 表格显示
- 工具调用展示

## 最佳实践

1. **清晰描述** - 任务描述越清晰，Agent 执行越准确
2. **分步请求** - 复杂任务分多步完成
3. **检查进度** - 关注任务进度显示
4. **及时中断** - 发现错误时 Ctrl+C 中断
