# Configuration Guide

Configuration determines which model Tinybot uses, which tools it can access, where it can read/write files, and how web services are started. Beginners do not need to understand all settings at once; focus first on model, keys, workspace, and safety limits.

## Configuration location

Default configuration file:

```text
~/.tinybot/config.json
```

Check current state:

```bash
uv run tinybot status
```

Reopen the onboarding wizard:

```bash
uv run tinybot onboard
```

You can also open the configuration editor in CLI chat by entering `/config` or pressing `Ctrl+O`.

## Minimum workable configuration

A minimum working setup needs three kinds of information:

| Setting | Purpose |
|------|------|
| Provider API Key | Allows Tinybot to call the AI service |
| Model | Specifies which model Tinybot uses |
| Workspace | Defines where Tinybot can operate |

Example:

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat",
      "workspace": "~/.tinybot/workspace",
      "timezone": "Asia/Shanghai"
    }
  },
  "providers": {
    "deepseek": {
      "apiKey": "your DeepSeek key"
    }
  }
}
```

The configuration supports both camelCase and snake_case. `apiKey` above can also be written as `api_key`.

## Model selection

Tinybot automatically maps model names to providers. For beginners, choose:

| Scenario | Recommended model |
|------|----------|
| Daily chat, writing docs, summarization | `deepseek-chat` |
| Complex analysis, code reasoning, multi-step planning | `deepseek-reasoner` |
| Existing OpenAI account | `gpt-4o` or another OpenAI model |
| Qwen users | `qwen-max` or an available Qwen model in your account |

Config location:

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat"
    }
  }
}
```

If model and key do not match, for example using `gpt-4o` while only DeepSeek key is configured, calls will fail.

## Configure API keys

Use the onboarding wizard or web settings to fill keys. You can also edit the config manually:

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "your key"
    },
    "openai": {
      "apiKey": "your key"
    },
    "dashscope": {
      "apiKey": "your key"
    }
  }
}
```

If you share the project with others, make sure no real keys are committed to Git.

## Workspace and safety limits

Workspace is the default directory for file reads and writes:

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  }
}
```

Beginners should also enable workspace restrictions:

```json
{
  "tools": {
    "restrictToWorkspace": true
  }
}
```

This keeps Tinybot’s file operations mostly within the workspace and reduces the chance of modifying system or unrelated project files.

## Common agent parameters

| Setting | Default tendency | Description |
|------|----------|------|
| `temperature` | `0.1` | Lower is more stable; suitable for coding and strict tasks |
| `maxTokens` | `8192` | Maximum length of one response |
| `contextWindowTokens` | `65536` | Maximum retained context length |
| `maxToolIterations` | `200` | Maximum tool calls in one task cycle |
| `reasoningEffort` | empty or model-supported values | For reasoning models use `low`, `medium`, or `high` |
| `timezone` | `UTC` | For users in China, use `Asia/Shanghai` |

Example:

```json
{
  "agents": {
    "defaults": {
      "temperature": 0.1,
      "maxToolIterations": 100,
      "timezone": "Asia/Shanghai"
    }
  }
}
```

## Tool settings

Tool capabilities are controlled by `tools`:

```json
{
  "tools": {
    "web": {
      "enable": true,
      "proxy": null,
      "search": {
        "provider": "duckduckgo",
        "maxResults": 5
      }
    },
    "exec": {
      "enable": true,
      "timeout": 60
    },
    "restrictToWorkspace": true
  }
}
```

| Setting | Recommendation |
|------|------|
| `tools.web.enable` | Enable when web search is needed |
| `tools.exec.enable` | Enable for command execution; disable if unsure |
| `tools.exec.timeout` | Maximum command runtime, default 60 seconds |
| `tools.restrictToWorkspace` | Recommended for beginners |

## Web UI settings

The web UI is served by the WebSocket channel:

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

`gateway.port` config is for gateway service settings; WebSocket channel also has its own `port`. Usually keep them aligned or use the WebSocket default.

Start:

```bash
uv run tinybot gateway
```

Visit:

```text
http://127.0.0.1:18790
```

## Knowledge settings

Knowledge base is off by default. Turn it on only if you want Tinybot to reference your documents:

```json
{
  "knowledge": {
    "enabled": true,
    "autoRetrieve": true,
    "maxChunks": 5,
    "retrievalMode": "hybrid"
  }
}
```

| Setting | Meaning |
|------|------|
| `enabled` | Whether knowledge base is on |
| `autoRetrieve` | Whether to auto-retrieve relevant docs for each question |
| `maxChunks` | Max number of chunks returned each turn |
| `retrievalMode` | `hybrid` works best for most cases |

Default low-cost mode keeps `retrievalMode: "hybrid"` and `semanticExtractionMode: "rule"`, using keyword, vector, and rule-based semantic signals. It does not call LLM for extraction or evidence expansion by default.

For higher-quality traceable provenance, explicitly enable the more expensive stages:

```json
{
  "knowledge": {
    "semanticExtractionMode": "llm",
    "llmExtractionStrategy": "entity_guided",
    "evidenceExpansionEnabled": true,
    "evidenceExpansionScope": "document",
    "evidenceExpansionMaxQueries": 5,
    "evidenceExpansionMaxLlmCalls": 0,
    "evidenceExpansionMaxTokens": 0,
    "evidenceExpansionTimeoutSeconds": 30,
    "evidenceExpansionConcurrency": 2
  }
}
```

| Setting | Meaning |
|------|------|
| `semanticExtractionMode` | `rule` for free rule extraction; `llm` for model-based extraction; `hybrid` combines both |
| `llmExtractionStrategy` | `single_pass` one-pass extraction; `entity_guided` uses known entities for a second-pass extraction |
| `evidenceExpansionEnabled` | Whether evidence expansion is enabled; off by default |
| `evidenceExpansionScope` | `document`, `collection`, or `global`; default is current document |
| `evidenceExpansionMaxQueries` | Max expansion queries per entity or record |
| `evidenceExpansionMaxLlmCalls` / `evidenceExpansionMaxTokens` | Budget for LLM calls and tokens in expansion stage (default 0) |
| `evidenceExpansionTimeoutSeconds` / `evidenceExpansionConcurrency` | Timeout and concurrency limits for expansion stage |

Prefer the default low-cost mode first. Enable LLM extraction or evidence expansion only when you need traceable claims, relations, conflicts, GraphRAG community reports, and original evidence.

## Common issues

### What to do if configuration is broken

Back up the old config first, then run onboarding again:

```bash
uv run tinybot onboard
```

To fully reset, delete `~/.tinybot/config.json` and run onboarding again. Ensure nothing important is missing before deletion.

### Environment variables set but Tinybot does not read them

Current schema mainly reads provider keys from `config.json`. The most reliable method is to write keys through `uv run tinybot onboard` or web settings.

### Errors after model switch

Check if model and provider match:

| Model | Required key |
|------|------------|
| `deepseek-chat` | DeepSeek |
| `gpt-4o` | OpenAI |
| `qwen-max` | DashScope/Qwen |

## Next steps

- [AI provider setup](providers.md): choose and configure providers
- [Tool features](tools.md): understand tool permissions and security boundaries
- [Web UI](webui.md): edit settings in browser
## Catalog-backed providers

Tinybot now accepts provider ids from the backend provider catalog in
`agents.defaults.provider`, not only the legacy `openai`, `deepseek`, and
`dashscope` values. Existing configs remain valid.

```toml
[agents.defaults]
provider = "openrouter"
model = "openai/gpt-4o-mini"

[providers.openrouter]
api_key = "..."
api_base = "https://openrouter.ai/api/v1"
```

Named profiles continue to work and can carry model lists, manual model ids,
model discovery settings, and provider request defaults:

```toml
[agents.defaults]
active_profile = "dashscope-coding"
model = "qwen3-coder-plus"

[providers.profiles.dashscope-coding]
provider = "dashscope"
api_key = "..."
api_base = "https://dashscope.aliyuncs.com/compatible-mode/v1"
models = ["qwen3-coder-plus"]
manual_models = ["custom-qwen-id"]
supports_model_discovery = true
```
