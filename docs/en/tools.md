# Tool Features

The main difference between an AI agent and a normal chat bot is that an agent can use tools. Tinybot’s tools let the AI read files, search the web, execute commands, work with the knowledge base, and call external MCP services.

## Cowork

The `cowork` tool is used to start and drive multi-agent collaboration sessions. It dynamically generates a set of roles based on the goal, where each role has its own context, mailbox, tasks, and discussion thread. It works well for research, travel planning, writing, analysis, operations, and other tasks that benefit from multiple perspectives.

Cowork can also be used as a standalone workflow without entering regular chat: `uv run tinybot cowork start "..."`.

Cowork supports multiple canonical architectures on one shared session, task, mailbox, and shared-memory model: `adaptive_starter`, `team`, `generator_verifier`, `message_bus`, `shared_state`, and `swarm`.

Common actions:

- `start`: create a cowork session; optional `auto_run=true` immediately runs one round
- `status`: view agents, tasks, discussion threads, and events
- `run`: continue running scheduling rounds
- `send_message`: user sends extra constraints or requirements to specific agents
- `add_task`: add a task to a specific agent
- `summary`: summarize current results

## What it means for a tool-backed assistant

A normal chatbot only generates text from your input. Tinybot can perform actions during a task, for example:

| User request | Tool Tinybot can use |
|----------|------------------------|
| “Summarize this project” | Read README, search docs, organize output |
| “Check whether config is correct” | Read config files, analyze fields |
| “Generate docs for me” | Read references, write Markdown files |
| “Search for latest information” | Search the web, open pages, summarize sources |
| “Run tests” | Execute commands, read test output |

The more tools are enabled, the more clearly you should define scope and safety boundaries.

## File operations

Tinybot can read, search, create, and modify files. It is useful for:

- Summarizing project structure
- Editing documentation
- Finding configuration entries
- Generating reports
- Organizing text materials

Recommended prompts:

```text
Please read only the docs directory and identify places where the instructions are not beginner-friendly.
```

```text
Please update docs/quickstart.md to make it more suitable for first-time Tinybot users.
```

If you do not want file changes, state it clearly:

```text
Do not edit files yet. Just give me suggestions.
```

## Command execution

Tinybot can execute terminal commands, such as installing dependencies, running tests, and checking status.

Example:

```text
Please run project tests and summarize the failure reasons.
```

Related settings:

```json
{
  "tools": {
    "exec": {
      "enable": true,
      "timeout": 60
    }
  }
}
```

If you do not want AI to execute commands, disable this:

```json
{
  "tools": {
    "exec": {
      "enable": false
    }
  }
}
```

## Web search

Tinybot can search the internet, useful for information that changes over time, such as news, prices, versions, policies, and third-party docs.

```text
Please search the latest docs for this library and tell me upgrade notes.
```

Related settings:

```json
{
  "tools": {
    "web": {
      "enable": true,
      "search": {
        "provider": "duckduckgo",
        "maxResults": 5
      }
    }
  }
}
```

If web access is restricted, you can configure a proxy:

```json
{
  "tools": {
    "web": {
      "proxy": "http://127.0.0.1:7890"
    }
  }
}
```

## Browser automation

Browser automation lets AI open web pages, click buttons, enter content, and extract page data. It usually requires extra browser bridge tooling and extensions.

Good for:

- Checking web interfaces
- Extracting structured data from pages
- Assisting local WebUI testing

If you are not familiar, you can skip this at first; basic chat, file operations, and knowledge base still work.

## MCP tools

MCP connects external tool services into Tinybot. After integration, these tools can be called by the agent like built-in ones.

Useful for developer/team scenarios, such as connecting internal systems, databases, design tools, or code platforms. New users do not need to configure MCP right away.

## Security recommendations

| Setting | Recommendation |
|------|------|
| Workspace | Set it to a clear directory, not your entire system root |
| `restrictToWorkspace` | Recommended for beginners |
| Command execution | Turn off when not needed |
| API Key | Do not commit real keys to public repos |
| File edits | Let Tinybot announce scope before making changes |

Recommended safe config:

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  },
  "tools": {
    "restrictToWorkspace": true,
    "exec": {
      "enable": true,
      "timeout": 60
    }
  }
}
```

## Common issues

### Tinybot says "permission denied"

This is often caused by workspace restrictions. Confirm the target file is inside `agents.defaults.workspace`.

### Command execution timeout

Default timeout is 60 seconds. Increase `tools.exec.timeout`, or ask Tinybot to split large tasks.

### Search results are inaccurate

Use clearer questions, or increase `maxResults`. For static/official references, prefer the knowledge base over live web searches.

## Next steps

- [Configuration](config.md): enable or disable tools
- [Knowledge base](knowledge.md): manage long-lived materials
- [Task system](tasks.md): understand how complex tasks are decomposed and executed
