# LLM Provider 配置

## 支持的提供商

Tinybot 支持 14+ LLM 提供商：

| Provider | 描述 |
|----------|------|
| `openai` | OpenAI API |
| `openrouter` | OpenRouter 路由 |
| `deepseek` | DeepSeek |
| `groq` | Groq 高速推理 |
| `zhipu` | 智谱 AI |
| `dashscope` | 通义千问 |
| `ollama` | Ollama 本地模型 |
| `gemini` | Google Gemini |
| `moonshot` | Moonshot |
| `minimax` | Minimax |
| `mistral` | Mistral |
| `stepfun` | StepFun |
| `siliconflow` | SiliconFlow |
| `volcengine` | 火山引擎 |
| `byteplus` | BytePlus |
| `custom` | 自定义 API |

## 自动检测

设置 `provider: auto` 时自动检测：

```json
{
  "agent": {
    "model": "gpt-4o",
    "provider": "auto"
  }
}
```

系统根据模型名称自动选择 Provider。

## Provider 配置

### OpenAI

```json
{
  "providers": {
    "openai": {
      "api_key": "sk-...",
      "api_base": "https://api.openai.com/v1"
    }
  }
}
```

### DeepSeek

```json
{
  "providers": {
    "deepseek": {
      "api_key": "sk-...",
      "api_base": "https://api.deepseek.com/v1"
    }
  }
}
```

### 智谱 AI

```json
{
  "providers": {
    "zhipu": {
      "api_key": "...",
      "api_base": "https://open.bigmodel.cn/api/paas/v4"
    }
  }
}
```

### 通义千问

```json
{
  "providers": {
    "dashscope": {
      "api_key": "...",
      "api_base": "https://dashscope.aliyuncs.com/compatible-api/v1"
    }
  }
}
```

### Ollama 本地

```json
{
  "providers": {
    "ollama": {
      "api_base": "http://localhost:11434/v1"
    }
  },
  "agent": {
    "model": "llama3"
  }
}
```

### OpenRouter

```json
{
  "providers": {
    "openrouter": {
      "api_key": "sk-or-...",
      "api_base": "https://openrouter.ai/api/v1"
    }
  },
  "agent": {
    "model": "anthropic/claude-3.5-sonnet"
  }
}
```

### 自定义 API

```json
{
  "providers": {
    "custom": {
      "api_key": "...",
      "api_base": "https://your-api.com/v1"
    }
  }
}
```

## Agent 配置

```json
{
  "agent": {
    "model": "gpt-4o",
    "temperature": 0.7,
    "max_tokens": 4096,
    "context_window": 128000,
    "max_tool_iterations": 50,
    "reasoning_effort": "medium",
    "timezone": "Asia/Shanghai"
  }
}
```

| 参数 | 描述 |
|------|------|
| `model` | 模型名称 |
| `temperature` | 温度参数 (0-2) |
| `max_tokens` | 最大输出长度 |
| `context_window` | 上下文窗口大小 |
| `max_tool_iterations` | 最大工具调用次数 |
| `reasoning_effort` | 推理强度：low/medium/high |
| `timezone` | 时区设置 |

## API Key 管理

### 直接配置

```json
{
  "providers": {
    "openai": {
      "api_key": "sk-..."
    }
  }
}
```

### 环境变量

推荐使用环境变量：

```bash
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
```

系统会自动读取环境变量。

## 多 Provider 支持

可以配置多个 Provider，Agent 根据模型选择：

```json
{
  "providers": {
    "openai": {
      "api_key": "sk-..."
    },
    "deepseek": {
      "api_key": "sk-..."
    },
    "ollama": {
      "api_base": "http://localhost:11434/v1"
    }
  }
}
```

使用时指定：

```json
{
  "agent": {
    "model": "deepseek-chat"
  }
}
```

## 最佳实践

1. **环境变量** - API Key 使用环境变量，不要硬编码
2. **合理温度** - 创意任务用高温度，精确任务用低温度
3. **工具限制** - 设置合理的 `max_tool_iterations`
4. **备用 Provider** - 配置多个 Provider 以备切换
