# Quick Start

This document is for users new to AI agents. You do not need to understand every concept first. If you complete installation, configure keys, and send your first command, you can start using Tinybot.

## What is Tinybot

Tinybot is an AI assistant that can use tools. It does more than answer questions: with your permissions, it can read files, organize materials, run commands, search the web, manage a knowledge base, decompose complex tasks, and interact with you through web or CLI.

You can think of it as:

| What you want to do | What Tinybot does |
|------------|----------------|
| Ask a question | Reply like a normal chatbot |
| Organize a document set | Read it, extract key points, and generate results |
| Analyze a project | Scan files, understand structure, and produce a report |
| Perform multi-step work | Break into small steps and show progress |
| Keep using consistent habits | Persist through config, skills, and knowledge base |

## Before you begin

Prepare three things:

| Item | Description |
|------|------|
| Python | Requires Python 3.13 or newer |
| uv | This project uses uv for dependency management and Python command execution |
| AI service key | Start with one of DeepSeek, OpenAI, or Qwen |

If you do not have uv yet, install it first. Run all commands in the project directory.

## Step 1: Install dependencies

```bash
uv sync
```

This installs Tinybot dependencies according to project configuration. First run can take some time.

## Step 2: Initialize configuration

```bash
uv run tinybot onboard
```

The onboarding wizard asks for AI service, model, keys, workspace, and gateway options. Beginners can keep the minimum setup:

| Option | Recommendation |
|--------|------|
| Provider | Choose one you already have a key for, e.g. DeepSeek |
| API Key | Enter the key from that platform |
| Model | Start with `deepseek-chat` for DeepSeek, switch to `deepseek-reasoner` for complex reasoning |
| Workspace | Keep default or set to your desired file directory for Tinybot operations |

Check status after setup:

```bash
uv run tinybot status
```

If config file, workspace, and model info are shown, the basic setup is working.

## Step 3: Start a conversation

### Method 1: CLI chat

```bash
uv run tinybot agent
```

After entering chat, type your request directly, for example:

```text
Please summarize what this project is about.
```

For a single-line question and immediate exit:

```bash
uv run tinybot agent -m "Hi, introduce Tinybot in one sentence"
```

### Method 2: Web UI

Web UI requires WebSocket enabled. If onboarding did not enable it, add this to config:

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

Then start gateway:

```bash
uv run tinybot gateway
```

Open in browser:

```text
http://127.0.0.1:18790
```

Beginners usually start with web UI because it shows conversations, tools, skills, knowledge base, and settings.

## How to ask first

AI agents work best on requests with clear goals and defined scope. Example prompts:

```text
Please read the README and docs directory in the current workspace and tell me who this project is for and how to start it.
```

```text
Please check whether docs/quickstart.md is beginner-friendly and point out likely sticking points.
```

```text
Please turn this meeting note into a to-do list and group by owner.
```

A better prompt usually includes three parts:

| Item | Example |
|------|------|
| Goal | I need installation instructions |
| Scope | Look only at docs directory and README |
| Output format | Step-by-step list, concise |

## Common commands

| Command | Purpose | Who should use |
|------|------|--------|
| `uv run tinybot onboard` | Initialize or reconfigure | Everyone |
| `uv run tinybot status` | Check configuration status | Troubleshooting |
| `uv run tinybot agent` | CLI chat | Terminal users |
| `uv run tinybot agent -m "question"` | One-shot prompt | Quick Q&A |
| `uv run tinybot gateway` | Start web UI and multi-channel services | Web users, long-running sessions |
| `uv run tinybot api` | Start OpenAI-compatible API | Developers |

## Common issues

### AI does not reply or API errors

Check:

1. Whether `uv run tinybot onboard` has been run
2. Whether API key is correct
3. Whether model name belongs to the correct provider
4. Whether account balance is sufficient
5. Whether network access to the AI service works

Run:

```bash
uv run tinybot status
```

### Web UI cannot open

Check:

1. Whether `channels.websocket.enabled` is enabled
2. Whether `uv run tinybot gateway` is running
3. Whether URL is `http://127.0.0.1:18790`

If port is in use, change port:

```bash
uv run tinybot gateway --port 18800
```

Then open `http://127.0.0.1:18800`.

### Concerned about file safety

Set workspace to a dedicated directory and enable workspace restriction:

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

This limits file operations to workspace scope.

## Next steps

- [Web UI](webui.md): learn conversations, settings, knowledge base, and skills in browser
- [CLI](cli.md): learn terminal chatting, shortcuts, and one-shot prompts
- [Configuration](config.md): learn model, keys, workspace, and safety limits
- [Tools](tools.md): learn which tools Tinybot can call
- [Knowledge base](knowledge.md): use your own documents for answers
