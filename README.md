# Tinybot

[中文文档](README_ZH.md)

A lightweight personal AI assistant framework that integrates Large Language Models with multiple chat platforms, tool systems, and automation mechanisms.

## ✨ Core Highlights

### 🧠 Agentic DAG Task Scheduling

![task](./show/task_1.png)

Automatically decomposes complex tasks into executable subtask DAGs, supporting:

- **Intelligent Decomposition** — LLM analyzes tasks and generates dependency-based subtask graphs
- **Automatic Chain Execution** — SubAgent completions automatically trigger dependent tasks
- **Parallel Execution** — Parallel-safe tasks run simultaneously for maximum efficiency
- **Dynamic Adjustment** — Add/remove subtasks during runtime

### 🤖 SubAgent Asynchronous Execution System

- **Non-blocking Execution** — Background tasks don't block main conversation
- **Concurrency Control** — Configurable max concurrency to prevent overload
- **Heartbeat Monitoring** — Auto-detects timeout tasks, prevents zombie processes
- **Auto-notification** — Automatically triggers main Agent to summarize results when complete

### 📊 CLI Real-time Progress Display

Task execution shows real-time progress in CLI without disrupting main conversation:

```
=== Research Cloud Providers [3/5] ===
  ✅ Environment preparation
  ▶️ Access Huawei Cloud and collect info
  ▶️ Access Alibaba Cloud and collect info
  ⏳ Access Tencent Cloud and collect info
  ⏳ Summary and organize results
======================================
```

### ⚙️ Integrated Configuration Editor

Full-screen terminal configuration editor accessible directly within the interactive chat:

- Press `Ctrl+O` or type `/config` to open the editor
- No need to exit the chat session
- Edit provider settings, model parameters, tool configs, etc.
- Press `q` to save and return to chat

## 🚀 Basic Features

- **Multi-platform Integration** — Built-in WeChat, DingTalk, Feishu channels; plugin extensibility
- **Rich Tools** — File read/write, shell execution, browser automation, web search, scheduled tasks
- **Intelligent Memory** — Vector storage-based memory system with session integration and semantic search
- **Multi-LLM Support** — Compatible with OpenAI, DeepSeek, Zhipu, Qwen, Gemini, and 14+ providers
- **Automation** — Cron scheduled tasks + heartbeat service for periodic auto-execution
- **OpenAI Compatible API** — Run as OpenAI-compatible backend service
- **Skills System** — Define skills via Markdown files, teach Agent specific workflows

## Quick Start

```bash
# Install
uv sync

# Initialize configuration (interactive wizard)
uv run tinybot onboard

# Interactive chat mode
uv run tinybot agent

# Send single message
uv run tinybot agent -m "Hello"

# Start gateway (multi-channel + scheduled tasks + heartbeat)
uv run tinybot gateway
```

## Interactive Chat Commands

When in interactive mode, the following commands are available:

| Command | Description |
|---------|-------------|
| `/config` or `Ctrl+O` | Open configuration editor |
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/exit` or `:q` | Exit the chat |

## Requirements

- Python >= 3.13

## License

[MIT](LICENSE)