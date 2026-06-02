# Web UI

The web UI is suitable for most beginners. It is more intuitive than a terminal and lets you see chat history, settings, knowledge base, skills, tools, and task status at the same time.

## Start the web UI

The web UI is provided by the WebSocket channel. Make sure your configuration includes:

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

Then start the gateway:

```bash
uv run tinybot gateway
```

Open in your browser:

```text
http://127.0.0.1:18790
```

If you are using it locally, keep `host` as `127.0.0.1` and avoid changing it to a public address.

## UI regions

| Region | Purpose |
|------|------|
| Left conversation list | Start new sessions, switch history, continue previous conversations |
| Middle chat area | Enter requests and view Tinybot responses and execution progress |
| Right panel | Manage tools, knowledge base, skills, settings, and workspace files |
| Top or status area | View current model, connection status, and task status |

## First-time workflow

1. Open the web UI and enter the settings panel first.
2. Confirm Provider, API Key, and Model are configured.
3. Return to chat and send a simple test message.
4. Then try letting Tinybot read your workspace or organize documentation.

Example test message:

```text
Hi, tell me which model you are currently using, and explain what you can help me with.
```

If it replies normally, try this:

```text
Please read the README in the current workspace and summarize the project purpose and startup method.
```

## Conversation management

The web UI saves conversation history. You can:

| Action | Meaning |
|------|------|
| New conversation | Start a new topic |
| Switch conversation | Continue asking from previous context |
| Clear conversation | Delete history context of the current conversation |
| Delete conversation | Remove no-longer-needed history |

Use separate conversations for different tasks, e.g. "project analysis", "writing docs", "daily Q&A". This keeps context cleaner.

## Right-side function panel

### Settings

Used to change model, API keys, workspace, and tool toggles. The most common settings for beginners are:

| Setting | Purpose |
|------|------|
| `providers.*.apiKey` | Configure the key for the corresponding AI service |
| `agents.defaults.model` | Select the model |
| `agents.defaults.workspace` | Set file operation scope |
| `tools.restrictToWorkspace` | Limit Tinybot to workspace-only file operations |

### Tools

Displays tools Tinybot can currently use. Tools include file operations, command execution, web search, and MCP extensions. More tools increase capability but also require clearer authorization boundaries.

### Knowledge base

Used to let Tinybot answer questions based on your provided materials. Suitable for storing product manuals, project documentation, workflow rules, meeting materials, etc.

### Skills

Skills are behavioral instructions. You can enable, disable, or create skills so Tinybot follows fixed workflows in specific scenarios.

### Workspace files

Use this to inspect the file scope Tinybot can access. Before editing files, verify the workspace points to the correct directory.

## When to use the web UI

| Scenario | Recommended |
|------|----------|
| First-time Tinybot setup | Recommended |
| Long AI collaboration sessions | Recommended |
| Managing knowledge base and skills | Recommended |
| One-sentence quick questions | `agent -m` in CLI is faster |
| API backend integration | Use `tinybot api` |

## FAQ

### Browser cannot open

Check:

1. Whether `uv run tinybot gateway` is running
2. Whether WebSocket channel is enabled
3. Whether the port is in use
4. Whether URL is exactly `http://127.0.0.1:18790`

### Page opens but AI does not reply

Check:

1. Whether API Key is correct
2. Whether model name matches the provider
3. Whether account balance is sufficient
4. Whether backend terminal logs show errors

### Settings do not take effect immediately

Model and keys usually update dynamically. A few gateway, channel, or tool settings may require restart:

```bash
uv run tinybot gateway
```

## Next steps

- [Knowledge Base](knowledge.md): Give Tinybot your own documents to use
- [Skills](skills.md): Make Tinybot follow a fixed workflow
- [Configuration](config.md): Understand each commonly used setting
## Providers page

The settings modal includes a provider card grid loaded from `/api/providers`.
Use search and filters to find providers by name, alias, status, or category.
The Models action refreshes provider models through `/api/provider-models`,
shows source labels, lets a model become the default, and supports manual model
entry. The Settings action selects the provider and exposes API key, base URL,
profile, discovery, and advanced request fields without overloading the card.

Provider cards do not write masked secret placeholders back as new secrets.
When a masked value is unchanged, the backend preserves the existing key.
