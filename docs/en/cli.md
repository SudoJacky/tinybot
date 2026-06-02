# Command-line Interface

The CLI is suitable for terminal users and is also good for quick one-line questions or when you need Tinybot to work with files in the current workspace.

## Start chat

```bash
uv run tinybot agent
```

After starting, you enter a full-screen chat interface. Type your request and press Enter.

```text
Please read the current directory and tell me the main modules of this project.
```

Exit chat by entering `/exit` or pressing `Ctrl+C`.

## One-shot prompts

If you do not want to open interactive chat, use `-m` to send one message:

```bash
uv run tinybot agent -m "Introduce this project in three sentences"
```

This is good for scripts, quick queries, or ad-hoc summaries.

## What you can see in terminal

| Area | Meaning |
|------|------|
| Top status | Current model, context, workspace, etc. |
| Message history | You and Tinybot chat history |
| Task progress | Step and status shown during complex tasks |
| Bottom input | Enter messages or commands like `/config`, `/help` |

When Tinybot reads files, runs commands, or decomposes tasks, the interface shows progress, helping you track what it is doing.

## Shortcuts and built-in commands

| Action | Usage |
|------|------|
| Send message | Enter |
| Open config editor | `Ctrl+O` or type `/config` |
| Show help | `/help` |
| Clear current conversation | `/clear` |
| Exit | `/exit`, `:q`, or `Ctrl+C` |
| Show deeper reasoning text | `Ctrl+R`, useful only when the model returns reasoning content |

Note: Enter in the input line sends immediately; it is not a multi-line editor. For long prompts, write to a file first, then let Tinybot read that file.

## Config editor

In chat, enter:

```text
/config
```

Or press `Ctrl+O` to open the config editor. Commonly changed items include:

| Setting | When to change |
|------|----------------|
| Provider/API Key | Switch AI service or key |
| Model | Choose faster or stronger model |
| Workspace | Restrict where Tinybot can operate |
| Tools | Toggle web search, command execution, MCP, etc. |
| Gateway | Change web port and heartbeat settings |

Edit and follow UI prompts to save and return to chat.

## How to instruct an agent

Because Tinybot can call tools, make instructions clear about goal, scope, and output format.

Recommended:

```text
Please read only the docs directory and identify unclear parts in beginner docs, then suggest fixes.
```

Not recommended:

```text
Look at this.
```

If you want file changes, say it explicitly:

```text
Please update docs/quickstart.md to make installation steps easier for first-time users.
```

If you only want recommendations and no edits, say that explicitly:

```text
Do not edit files yet, only list recommendations.
```

## Common issues

### Garbled Chinese output

Windows users should use PowerShell or Windows Terminal and ensure UTF-8 output is enabled. Tinybot tries to set encoding automatically, but older terminals may still display incorrectly.

### Slow AI responses

Common causes are slow model responses, network latency, large file reads, or active tool execution. Try:

1. Switching to a faster model such as `deepseek-chat`
2. Narrowing task scope, e.g. “docs directory only”
3. Splitting into smaller tasks

### Command execution fails or lacks permission

Check workspace, command execution tool, and system permissions. If `restrict_to_workspace` is on, Tinybot can only modify files inside workspace.

## Next steps

- [Web UI](webui.md): manage conversations, knowledge, and skills more visually
- [Configuration](config.md): learn model, keys, and security settings
- [Tools](tools.md): know what file reads and knowledge retrieval can do
