# Tinybot

<p align="center">
  <img src="./webui/assets/logo.svg" width="96" alt="Tinybot logo">
</p>

[![Python](https://img.shields.io/badge/Python-3.13%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-green?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/SudoJacky/tinybot?style=social&logo=github)](https://github.com/SudoJacky/tinybot/stargazers)
[![GitHub Clones](https://img.shields.io/badge/dynamic/json?color=success&label=Clone&query=count&url=https://gist.githubusercontent.com/SudoJacky/1ed488e49d2ce0a4af8ce5a63af4396e/raw/clone.json&logo=github)](https://github.com/MShawon/github-clone-count-badge)
[![GitHub Issues](https://img.shields.io/github/issues/SudoJacky/tinybot?logo=github)](https://github.com/SudoJacky/tinybot/issues)
[![GitHub Release](https://img.shields.io/github/v/release/SudoJacky/tinybot?include_prereleases&logo=github)](https://github.com/SudoJacky/tinybot/releases)
[![oosmetrics](https://api.oosmetrics.com/api/v1/badge/achievement/2a28dc05-c0df-45b8-babd-90411f7c20aa.svg)](https://oosmetrics.com/repo/SudoJacky/tinybot)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/SudoJacky/tinybot)

[English](README.md) | [快速开始](#快速开始) | [核心亮点](#-核心亮点) | [命令](#交互式聊天命令)

Tinybot 是一个轻量级个人 AI 助手框架，集成了大语言模型、多种聊天平台、工具系统和自动化机制。

## 变更日志

<details>
<summary>2026.05.15 持续演进 Cowork 架构运行时。</summary>

Cowork 现在使用规范化架构（`adaptive_starter`、`team`、`generator_verifier`、`message_bus`、`shared_state`、`swarm`），支持分支感知的会话快照、Agent Step 观察详情扩展、架构专属投影，以及显式的分支结果选择或合并控制。

</details>

<details>
<summary>2026.05.13 将 Cowork 演进为图驱动、蓝图感知的 Agent 群体控制平面。</summary>

Cowork 现在提供版本化的图/轨迹快照、可复用 JSON 蓝图、预算感知运行控制、阻塞面板，以及蓝图校验/预览 API。

![cowork](./show/webui_cowork_agent_field_v2.PNG)

</details>

<details>
<summary>2026.05.11 显著增强 Cowork 的性能和呈现效果。</summary>

![cowork](./show/webui_cowork_agent_field.PNG)

</details>

<details>
<summary>2026.05.08 新增 “cowork” 能力，可创建自主运行的多 Agent 团队系统。</summary>
</details>

<details>
<summary>2026.05.07 修改工具使用的展示逻辑。</summary>
</details>

<details>
<summary>2026.04.30 修复多个 UI 问题，修订浏览器控制界面演示，并新增任务展示功能。</summary>

![browser_snapshot2](./show/browser_snapshot2.png)

![task_webui1](./show/task_webui1.png)

</details>

<details>
<summary>2026.04.29 修复多个 UI 问题，并新增浏览器控制界面演示。</summary>

![auto_snapshot](./show/snapshot.gif)

</details>

<details>
<summary>2026.04.28 新增 beta 版 RAG 关系图。</summary>

![rag_graph_beta_gif](./show/webui_rag_graph_beta1.gif)

![rag_graph_beta](./show/webui_rag_graph_beta1.PNG)

</details>

<details>
<summary>2026.04.27 新增文档并修复部分问题。</summary>

![doc_home](./show/webui_doc_home.PNG)

![startup](./show/webui_startup.PNG)

</details>

<details>
<summary>2026.04.26 新增 RAG 模块，当前支持文本内容。</summary>

![RAG](./show/webui_RAG.PNG)
</details>

<details>
<summary>2026.04.24 新增 WebUI、人工创建 skills、启用/禁用 skills 等能力。</summary>

浅色模式

![white](./show/webui_1.PNG)

深色模式

![dark](./show/webui_2.PNG)
</details>

## ✨ 核心亮点

### Chatbot-agent

<video src="https://github.com/user-attachments/assets/6b2e9439-7870-440e-8c49-61d38d46caf9" controls width="100%"></video>

### Agent cowork!

Cowork 提供共享的多 Agent 会话模型，包含架构运行时策略、分支导航、架构专属投影、可观察的 Agent Steps，以及显式的最终结果选择。

![cowork](./show/webui_cowork_agent_field_content_v3.PNG)

![cowork](./show/webui_cowork_agent_field_v3.PNG)

### 🧠 Agentic DAG 任务调度

![task](./show/task_1.gif)

自动将复杂任务拆解为可执行的子任务 DAG，支持：

- **智能拆解** - LLM 分析任务并生成基于依赖关系的子任务图
- **自动链式执行** - SubAgent 完成后自动触发依赖它的任务
- **并行执行** - 可安全并行的任务会同时运行，以获得更高效率
- **动态调整** - 运行过程中可添加或移除子任务

### WebUI

![webui](./show/webui_1.PNG)

### 🔄 经验自进化系统

一个可以从问题解决经验中持续改进的自学习系统：

~~~json
{
  "id": "exp_86788c0e",
  "timestamp": "2026-04-20T21:19:17",
  "tool_name": "exec",
  "error_type": "argument error",
  "error_message": "",
  "params": {},
  "outcome": "resolved",
  "resolution": "当使用opencli的scroll命令时，确保只传递一个参数，避免参数过多错误。检查命令调用格式，正确示例为`scroll(distance)`或`scroll(selector)`，而非多个参数。在工具调用前验证参数数量，可参考opencli文档或使用测试命令确认API要求。",
  "context_summary": "网页自动化执行：使用opencli执行JavaScript命令时参数错误和代码语法/类型错误，通过调整命令和防御性编程解决",
  "confidence": 0.7,
  "session_key": "cli:direct",
  "merged_count": 0,
  "last_used_at": "2026-04-20T21:19:17",
  "category": "api",
  "tags": ["opencli", "scroll", "参数错误", "浏览器自动化"],
  "use_count": 0,
  "success_count": 0,
  "feedback_positive": 0,
  "feedback_negative": 0
}
~~~

- **语义经验搜索** - 基于向量的搜索能理解问题意图，而不只是匹配关键词
- **自动上下文注入** - 相关历史解决方案会在需要时自动出现
- **主动错误诊断** - 工具失败时，会自动从已解决经验中给出建议
- **智能置信度模型** - 多维度评分：使用频率、成功率、新鲜度、反馈
- **自动分类** - 按类别为经验打标签（路径、权限、编码、网络等）

### 🤖 SubAgent 异步执行

- **非阻塞执行** - 后台任务不会阻塞主对话
- **并发控制** - 可配置最大并发数，避免过载
- **心跳监控** - 自动检测超时任务，避免残留进程
- **自动通知** - 任务完成后自动触发主 Agent 总结结果

### 💭 Dream 记忆处理

空闲期间进行两阶段自主记忆整合：

- **阶段 1：分析** - LLM 分析对话历史并提取洞察
- **阶段 2：编辑** - AgentRunner 对记忆文件进行定向编辑
- **阶段 3：经验更新** - 合并相似经验并更新策略文档
- **向量存储集成** - 在整合后的记忆中进行语义搜索

### 📊 CLI 实时进度显示

任务执行会在 CLI 中实时显示进度，同时不打断主对话。

### ⚙️ 集成配置编辑器

可在交互式聊天中直接打开全屏终端配置编辑器：

- 按 `Ctrl+O` 或输入 `/config` 打开编辑器
- 无需退出聊天会话
- 编辑 provider 设置、模型参数、工具配置等
- 按 `q` 保存并返回聊天

### 🔌 MCP（Model Context Protocol）支持

无缝连接外部 MCP server 并使用其工具：

- **原生工具封装** - MCP 工具会表现为 tinybot 原生工具
- **多 Server 支持** - 可同时连接多个 MCP server
- **自动工具发现** - 自动发现并注册可用工具

## 🚀 基础功能

- **多平台集成** - 内置微信、钉钉、飞书渠道，并支持插件扩展
- **丰富工具** - 文件读写、shell 执行、浏览器自动化、网页搜索、定时任务
- **智能记忆** - 基于向量存储的记忆系统，集成会话并支持语义搜索
- **多 LLM 支持** - 兼容 OpenAI、DeepSeek、智谱、通义千问、Gemini 以及 14+ provider
- **Skills 系统** - 通过 Markdown 文件定义 skills，无需编码即可教会 Agent 特定工作流
- **自动化** - Cron 定时任务 + heartbeat 服务，用于周期性自动执行
- **OpenAI 兼容 API** - 可作为 OpenAI 兼容后端服务运行，并集成任意 OpenAI client
- **会话管理** - 持久化对话历史，支持 checkpoint 恢复
- **安全** - 工作区限制、命令审计、加密凭据存储

## 快速开始

```bash
# 安装
uv sync

# 初始化配置（交互式向导）
uv run tinybot onboard

# 交互式聊天模式
uv run tinybot agent

# 发送单条消息
uv run tinybot agent -m "Hello"

# 启动 gateway（多渠道 + 定时任务 + heartbeat）
uv run tinybot gateway

# 作为 OpenAI 兼容 API server 运行
uv run tinybot api
```

## WebUI 使用

Tinybot 提供基于浏览器的 Web 界面，可用于和 AI Agent 聊天。

### 启用 WebUI 的步骤

#### 1. 在配置中启用 WebSocket 渠道

编辑你的 `~/.tinybot/config.json` 文件，在 `channels` 下添加：

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

#### 2. 启动 Gateway

```bash
uv run tinybot gateway
```

#### 3. 打开浏览器

在浏览器中访问 `http://127.0.0.1:18790`。

### 可用 API 端点

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions` | GET | 列出所有聊天会话 |
| `/api/sessions/{key}/messages` | GET | 获取会话消息 |
| `/api/sessions/{key}` | DELETE/PATCH | 删除/更新会话 |
| `/api/sessions/{key}/clear` | POST | 清空会话历史 |
| `/api/sessions/{key}/profile` | GET | 获取用户 profile |
| `/api/config` | GET/PATCH | 获取/更新配置 |
| `/api/status` | GET | 获取系统状态 |
| `/api/tools` | GET | 获取可用工具 |
| `/api/skills` | GET | 获取全部 skills |
| `/api/skills/{name}` | GET | 获取 skill 详情 |
| `/api/workspace/files` | GET | 列出工作区文件 |
| `/ws` | WebSocket | 实时聊天连接 |

### WebSocket 事件

| Event | Direction | Description |
|-------|-----------|-------------|
| `new_chat` | Client → Server | 创建新聊天 |
| `attach` | Client → Server | 附加到已有聊天 |
| `message` | Client → Server | 发送消息 |
| `interrupt` | Client → Server | 停止 AI 生成 |
| `ping` | Client → Server | 心跳 |
| `delta` | Server → Client | 流式文本片段 |
| `stream_end` | Server → Client | 流结束 |
| `message` | Server → Client | 完整消息 |
| `file_updated` | Server → Client | 工作区文件已变更 |

## 交互式聊天命令

进入交互模式后，可使用以下命令：

| Command | Description |
|---------|-------------|
| `/config` 或 `Ctrl+O` | 打开配置编辑器 |
| `/help` | 显示可用命令 |
| `/clear` | 清空对话历史 |
| `/new` | 开启新的对话会话 |
| `/exit` 或 `:q` | 退出聊天 |

## Skills 系统

通过简单的 Markdown 文件定义自定义 skills。

Skills 会被自动加载；当条件匹配时，Agent 会遵循其中定义的工作流。

### 使用浏览器前

#### 1. 安装 OpenCLI

```bash
npm install -g @jackwener/opencli
```

#### 2. 安装 Browser Bridge 扩展

OpenCLI 通过轻量级 Browser Bridge 扩展和一个本地小型 daemon 连接 Chrome/Chromium。daemon 会在需要时自动启动。

1. 从 GitHub [Releases 页面](https://github.com/jackwener/opencli/releases)下载最新的 `opencli-extension-v{version}.zip`。
2. 解压后打开 `chrome://extensions`，并启用 **Developer mode**。
3. 点击 **Load unpacked**，选择解压后的文件夹。

#### 3. 验证安装

```bash
opencli doctor
```

## 经验工具

Agent 可以主动管理自己的学习经验：

| Tool | Description |
|------|-------------|
| `query_experience` | 搜索过往问题解决经验 |
| `save_experience` | 保存新的解决方案，供未来参考 |
| `feedback_experience` | 标记某条经验是否有帮助 |
| `delete_experience` | 移除过期或错误的经验 |

## 环境要求

- Python >= 3.13

## 许可证

[MIT](LICENSE)
