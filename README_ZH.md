# Tinybot

<p align="center">
  <img src="./webui/assets/logo.svg" width="96" alt="Tinybot logo">
</p>

[![Python](https://img.shields.io/badge/Python-3.13%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-green?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/SudoJacky/tinybot?style=social&logo=github)](https://github.com/SudoJacky/tinybot/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/SudoJacky/tinybot?logo=github)](https://github.com/SudoJacky/tinybot/issues)
[![GitHub Release](https://img.shields.io/github/v/release/SudoJacky/tinybot?include_prereleases&logo=github)](https://github.com/SudoJacky/tinybot/releases)

[English](README.md) | [快速开始](docs/quickstart.md) | [网页界面](docs/webui.md) | [配置说明](docs/config.md)

Tinybot 是一个轻量的个人 AI Agent 框架。它可以像聊天机器人一样回答问题，也可以在你允许的范围内使用工具：读取文件、修改文档、执行命令、搜索网络、管理知识库、拆分复杂任务，并通过命令行、网页界面或聊天平台与你协作。

如果你不熟悉 AI Agent，可以先把它理解成“会使用工具的 AI 助手”：你提出目标，它会根据需要阅读资料、调用工具、拆步骤、给出结果。

## 适合用 Tinybot 做什么

| 场景 | 示例 |
|------|------|
| 项目理解 | “请阅读 README 和 docs，告诉我这个项目怎么启动” |
| 文档整理 | “请把使用说明改得更适合新手” |
| 文件处理 | “请总结这个目录里的 Markdown 文件” |
| 任务拆解 | “请分析这个问题，列计划并逐步处理” |
| 知识问答 | “根据我上传的产品文档回答用户问题” |
| 自动化 | “每天早上 9 点提醒我检查待办事项” |

## 快速开始

### 1. 安装依赖

本项目使用 uv 管理依赖和运行 Python 命令：

```bash
uv sync
```

### 2. 初始化配置

```bash
uv run tinybot onboard
```

新手建议先完成最小配置：

| 配置 | 建议 |
|------|------|
| Provider | 选择你已有密钥的服务，例如 DeepSeek、OpenAI、通义千问 |
| API Key | 填入对应平台的 API 密钥 |
| Model | DeepSeek 可先用 `deepseek-chat` |
| Workspace | 保持默认，或设为你希望 Tinybot 操作文件的目录 |

检查配置状态：

```bash
uv run tinybot status
```

### 3. 启动命令行聊天

```bash
uv run tinybot agent
```

也可以只发送一条消息：

```bash
uv run tinybot agent -m "请用一句话介绍 Tinybot"
```

### 4. 启动网页界面

先确保配置中启用了 WebSocket 频道：

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

然后运行：

```bash
uv run tinybot gateway
```

浏览器访问：

```text
http://127.0.0.1:18790
```

第一次使用更推荐网页界面，因为它能看到会话、设置、知识库、技能和工具状态。

## 常用命令

| 命令 | 作用 |
|------|------|
| `uv run tinybot onboard` | 初始化或重新配置 |
| `uv run tinybot status` | 查看配置、工作区和 Provider 状态 |
| `uv run tinybot agent` | 打开命令行聊天 |
| `uv run tinybot agent -m "问题"` | 单次提问 |
| `uv run tinybot gateway` | 启动网页界面、多频道和定时任务 |
| `uv run tinybot api` | 启动 OpenAI 兼容 API 服务 |

## 核心能力

### WebUI

![webui](./show/webui_1.PNG)

浏览器界面提供会话管理、设置面板、知识库、技能管理、工具状态和工作区文件查看。

### 任务系统

![task](./show/task_1.gif)

复杂请求会被拆成多个步骤执行，并显示进度。适合项目分析、文档重写、批量整理、测试排查等任务。

### 知识库

知识库可以索引你提供的文档，让 Tinybot 在回答时引用你的资料。适合产品手册、项目文档、制度流程和长期 FAQ。

### 技能系统

技能是写给 Tinybot 的工作说明。它能把你反复强调的流程固定下来，例如会议总结、代码审查、客服回复、周报生成。

### 工具系统

Tinybot 可使用文件、命令、网络搜索、浏览器自动化、MCP 等工具。新手建议设置明确工作区，并开启工作区限制。

## 安全建议

Tinybot 能操作文件和命令，因此建议：

- 把 `agents.defaults.workspace` 设置为明确目录
- 开启 `tools.restrictToWorkspace`
- 不要把真实 API Key 提交到公开仓库
- 让 Tinybot 修改文件前说明范围
- 对重要文件先使用 Git 或其他方式保留历史

推荐配置：

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  },
  "tools": {
    "restrictToWorkspace": true
  }
}
```

## 文档

- [快速开始](docs/quickstart.md)
- [网页界面](docs/webui.md)
- [命令行界面](docs/cli.md)
- [配置说明](docs/config.md)
- [AI 服务配置](docs/providers.md)
- [工具功能](docs/tools.md)
- [任务系统](docs/tasks.md)
- [知识库](docs/knowledge.md)
- [技能系统](docs/skills.md)
- [网关服务](docs/gateway.md)

## 环境要求

- Python >= 3.13
- uv

## 许可证

[MIT](LICENSE)
