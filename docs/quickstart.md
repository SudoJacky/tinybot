# 快速开始

这篇文档面向第一次接触 AI Agent 的用户。你不需要先理解所有概念，只要按顺序完成安装、配置密钥、发出第一条指令，就能开始使用 Tinybot。

## Tinybot 是什么

Tinybot 是一个可以使用工具的 AI 助手。它不只是回答问题，还可以在你允许的范围内读取文件、整理资料、执行命令、搜索网络、管理知识库、拆分复杂任务，并通过网页或命令行与你对话。

可以把它理解成：

| 你想做的事 | Tinybot 的作用 |
|------------|----------------|
| 问一个问题 | 像普通聊天机器人一样回答 |
| 整理一份资料 | 自动阅读、提取重点、生成结果 |
| 分析一个项目 | 扫描文件、理解结构、写报告 |
| 做多步骤任务 | 自动拆成小步骤并显示进度 |
| 以后继续使用同一套习惯 | 通过配置、技能、知识库固定下来 |

## 使用前准备

你需要准备三样东西：

| 项目 | 说明 |
|------|------|
| Python | 需要 Python 3.13 或更高版本 |
| uv | 本项目用 uv 管理依赖和运行 Python 命令 |
| AI 服务密钥 | 推荐先用 DeepSeek、OpenAI 或通义千问中的一个 |

如果你还没有 uv，请先安装 uv。安装完成后，在项目目录中执行本文所有命令。

## 第一步：安装依赖

```bash
uv sync
```

这一步会根据项目配置安装 Tinybot 需要的 Python 依赖。第一次运行会比较慢。

## 第二步：初始化配置

```bash
uv run tinybot onboard
```

初始化向导会让你配置 AI 服务、模型、密钥、工作目录和网关等选项。新手建议先只完成最小配置：

| 配置项 | 建议 |
|--------|------|
| Provider | 选择你已经有密钥的服务，例如 DeepSeek |
| API Key | 填入对应平台提供的密钥 |
| Model | DeepSeek 可先用 `deepseek-chat`，复杂推理再换 `deepseek-reasoner` |
| Workspace | 保持默认值，或设置为你希望 Tinybot 操作文件的目录 |

完成后可以检查状态：

```bash
uv run tinybot status
```

如果能看到配置文件、工作区和模型信息，说明基础配置已经生效。

## 第三步：开始对话

### 方式一：命令行聊天

```bash
uv run tinybot agent
```

进入聊天界面后，直接输入你的需求。例如：

```text
帮我总结一下这个项目是做什么的
```

如果只想问一句话并立即退出：

```bash
uv run tinybot agent -m "你好，请用一句话介绍 Tinybot"
```

### 方式二：网页界面

网页界面需要启用 WebSocket 频道。初始化向导里如果没有启用，可以在配置文件中加入：

```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18790
    }
  }
}
```

然后启动网关：

```bash
uv run tinybot gateway
```

浏览器访问：

```text
http://127.0.0.1:18790
```

新手通常更适合先用网页界面，因为它能看到会话、工具、技能、知识库和设置面板。

## 第一次应该怎么问

AI Agent 更适合处理“目标清楚、范围明确”的请求。你可以这样写：

```text
请阅读当前工作区的 README 和 docs 目录，告诉我这个项目适合什么用户，以及怎么启动。
```

```text
请检查 docs/quickstart.md 是否适合新手阅读，指出最容易卡住的地方。
```

```text
请把这段会议记录整理成待办事项，并按负责人分组。
```

比起只说“帮我看看”，更推荐说明三件事：

| 信息 | 示例 |
|------|------|
| 目标 | 我要生成一份安装说明 |
| 范围 | 只看 docs 目录和 README |
| 输出 | 用步骤列表，不要太长 |

## 常用命令

| 命令 | 作用 | 适合谁 |
|------|------|--------|
| `uv run tinybot onboard` | 初始化或重新配置 | 所有人 |
| `uv run tinybot status` | 检查配置状态 | 排查问题时 |
| `uv run tinybot agent` | 命令行聊天 | 喜欢终端的用户 |
| `uv run tinybot agent -m "问题"` | 单次提问 | 快速问答 |
| `uv run tinybot gateway` | 启动网页界面和多频道服务 | 网页用户、长期运行 |
| `uv run tinybot api` | 启动 OpenAI 兼容 API | 开发者 |

## 最常见的问题

### AI 不回复或报 API 错误

先检查：

1. 是否已经执行 `uv run tinybot onboard`
2. API Key 是否填对
3. 模型名称是否属于对应 Provider
4. 账户是否有余额
5. 网络是否能访问该 AI 服务

可以运行：

```bash
uv run tinybot status
```

### 网页打不开

检查三点：

1. 是否已经在配置里启用 `channels.websocket.enabled`
2. 是否正在运行 `uv run tinybot gateway`
3. 地址是否是 `http://127.0.0.1:18790`

如果端口被占用，可以换端口：

```bash
uv run tinybot gateway --port 18800
```

然后访问 `http://127.0.0.1:18800`。

### 担心 AI 修改不该改的文件

先把工作区设置成一个专门目录，并开启工作区限制：

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  },
  "tools": {
    "restrict_to_workspace": true
  }
}
```

这样 Tinybot 的文件操作会被限制在工作区范围内。

## 下一步

- [网页界面](webui.md)：了解浏览器里的会话、设置、知识库和技能面板
- [命令行界面](cli.md)：了解终端聊天、快捷键和单次提问
- [配置说明](config.md)：了解模型、密钥、工作区和安全限制
- [工具功能](tools.md)：了解 Tinybot 能调用哪些工具
- [知识库](knowledge.md)：让 Tinybot 使用你自己的文档回答问题
