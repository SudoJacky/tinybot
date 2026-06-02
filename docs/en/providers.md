# AI Provider Configuration

Providers are the backend model service sources Tinybot can call, such as DeepSeek, OpenAI, Qwen, local compatible services, and more.

## Suggested providers

| Provider | Default choice |
|--------|------|
| Budget-friendly general use | DeepSeek + `deepseek-chat` |
| More careful reasoning | DeepSeek + `deepseek-reasoner` or OpenAI-compatible alternatives |
| OpenAI account users | OpenAI + your preferred model |
| Users with local compatible endpoints | DashScope / compatible provider |
| Private/Open source/local models | Ollama or local endpoint |

Select one that fits your usage and budget.

## Get API URLs

| Provider | URL |
|------|------|
| DeepSeek | https://platform.deepseek.com |
| OpenAI | https://platform.openai.com |
| DashScope / OpenAI-compatible | https://dashscope.aliyuncs.com |

After obtaining an API key, add it to Tinybot config.

## Configure through wizard

```bash
uv run tinybot onboard
```

Choose `[P] LLM Provider`, select provider and fill in `apiKey`, then go to `[A] Agent Settings` to set the default model.

Check status after setup:

```bash
uv run tinybot status
```

## Manual configuration examples

### DeepSeek

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat"
    }
  },
  "providers": {
    "deepseek": {
      "apiKey": "your DeepSeek key"
    }
  }
}
```

### OpenAI

```json
{
  "agents": {
    "defaults": {
      "model": "gpt-4o"
    }
  },
  "providers": {
    "openai": {
      "apiKey": "your OpenAI key"
    }
  }
}
```

### DashScope / Qwen

```json
{
  "agents": {
    "defaults": {
      "model": "qwen-max"
    }
  },
  "providers": {
    "dashscope": {
      "apiKey": "your DashScope key"
    }
  }
}
```

## Provider to model mapping

Tinybot uses provider and model names to route calls.

| Model name | Auto-associated provider |
|--------------|----------|
| `deepseek-chat` / `deepseek-reasoner` | DeepSeek |
| `gpt-4o` / `gpt-4o-mini` | OpenAI |
| `qwen-max` / `qwen-turbo` | DashScope |

If automatic matching fails, set both model and provider in config:

```json
{
  "agents": {
    "defaults": {
      "provider": "deepseek",
      "model": "deepseek-chat"
    }
  }
}
```

## Customizing OpenAI-compatible endpoint

If you use a custom OpenAI-compatible service, set `apiBase`:

```json
{
  "providers": {
    "openai": {
      "apiKey": "your key",
      "apiBase": "https://example.com/v1"
    }
  }
}
```

For provider name placeholders in config, treat them as labels, not service IDs.

## Model selection recommendations

| Requirement | Suggestion |
|------|------|
| Cost-sensitive casual use | DeepSeek |
| Rich analysis and coding workflows | OpenAI |
| Large-scale inference / heavy usage | DeepSeek |
| Strong Chinese support | Qwen or DashScope |

Pick based on cost, speed, availability, and your own model availability. You can switch later as needed.

## Troubleshooting

### API call failures

Check:

1. Whether API key is valid
2. Whether client can reach provider backend
3. Whether model name exists
4. Whether model matches provider
5. Whether gateway/network is healthy

### Low-quality answers from specific providers

Tinybot first follows `agents.defaults.model` and `agents.defaults.provider`. For quality-sensitive work, verify:

```bash
uv run tinybot status
```

### Key format issues

Use `uv run tinybot onboard` for consistent onboarding.
If a key is malformed, Tinybot can fail silently or return confusing errors.

## Next steps

- [Quick start](quickstart.md): set up and run first request
- [Configuration](config.md): manage global config details
## Provider catalog and cards

Provider setup is catalog-backed. The WebUI Providers section requests
`/api/providers` and renders cards for built-in, local, aggregator, and custom
providers. Each card shows readiness, credential state, API base, model count,
default model state, and available actions.

Status meanings:

- `ready`: credentials or local access are available and at least one model is known.
- `needs_key`: the provider requires an API key and neither config nor env provides it.
- `no_models`: the provider is configured but has no curated, discovered, profile, or manual models.
- `unavailable`: a custom/local provider is missing required endpoint details.
- `unsupported`: the catalog entry uses an API mode Tinybot cannot run yet.

Model lists merge curated catalog models, profile models, live `/models`
discovery, and manual model ids without duplicates. Discovery failures are
warnings; curated and manual models stay selectable. Custom, local, and
aggregator providers can use manual model ids when strict validation cannot
prove them invalid.
