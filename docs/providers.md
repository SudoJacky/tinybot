# AI 服务配置

Provider 是 Tinybot 调用大模型的服务来源，例如 DeepSeek、OpenAI、通义千问。你至少需要配置一个 Provider，Tinybot 才能正常回复。

## 新手怎么选

| 你是谁 | 推荐 |
|--------|------|
| 国内个人用户，想先跑起来 | DeepSeek + `deepseek-chat` |
| 需要更强推理能力 | DeepSeek + `deepseek-reasoner`，或 OpenAI 推理模型 |
| 已经有 OpenAI 账号 | OpenAI + 你账号可用的模型 |
| 使用阿里云生态 | DashScope/通义千问 |
| 重视隐私并愿意本地部署 | 本地 OpenAI 兼容服务或 Ollama 类服务 |

先选择一个即可，不需要同时配置所有服务。

## 获取密钥

| 服务 | 地址 |
|------|------|
| DeepSeek | https://platform.deepseek.com |
| OpenAI | https://platform.openai.com |
| 通义千问 / DashScope | https://dashscope.aliyuncs.com |

在平台创建 API Key 后，回到 Tinybot 配置中填写。

## 通过向导配置

```bash
uv run tinybot onboard
```

选择 `[P] LLM Provider`，进入对应 Provider，填写 `apiKey`。然后到 `[A] Agent Settings` 设置默认模型。

配置完成后检查：

```bash
uv run tinybot status
```

## 手动配置示例

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
      "apiKey": "你的 DeepSeek 密钥"
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
      "apiKey": "你的 OpenAI 密钥"
    }
  }
}
```

### 通义千问

```json
{
  "agents": {
    "defaults": {
      "model": "qwen-max"
    }
  },
  "providers": {
    "dashscope": {
      "apiKey": "你的 DashScope 密钥"
    }
  }
}
```

## 模型和 Provider 的匹配关系

Tinybot 会根据模型名称自动推断 Provider：

| 模型名称示例 | 自动匹配 |
|--------------|----------|
| `deepseek-chat`、`deepseek-reasoner` | DeepSeek |
| `gpt-4o`、`gpt-4o-mini` | OpenAI |
| `qwen-max`、`qwen-turbo` | DashScope |

如果自动匹配失败，可以在配置中显式设置：

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

## 自定义 OpenAI 兼容地址

如果你使用的是 OpenAI 兼容服务，可以配置 `apiBase`：

```json
{
  "providers": {
    "openai": {
      "apiKey": "你的密钥",
      "apiBase": "https://example.com/v1"
    }
  }
}
```

这类服务的模型名称以服务商文档为准。

## 模型选择建议

| 任务 | 建议 |
|------|------|
| 普通问答、改文档、总结 | 快速对话模型 |
| 复杂代码分析、长链路任务 | 推理模型 |
| 大量资料整理 | 上下文更长、价格可接受的模型 |
| 低成本长期使用 | DeepSeek 或本地服务 |

不要盲目选择最贵模型。先用便宜模型跑通流程，只有在推理质量不够时再升级。

## 常见问题

### API 调用失败

检查：

1. API Key 是否复制完整
2. 账户是否有余额
3. 模型名称是否存在
4. 模型和 Provider 是否匹配
5. 网络是否能访问该服务

### 为什么填了多个密钥仍然用错模型

Tinybot 优先根据 `agents.defaults.model` 和 `agents.defaults.provider` 匹配服务。先检查当前模型：

```bash
uv run tinybot status
```

### 密钥应该放哪里

最简单稳定的方式是通过 `uv run tinybot onboard` 或网页设置写入配置。不要把包含真实密钥的配置文件提交到公开仓库。

## 下一步

- [快速开始](quickstart.md)：跑通第一次对话
- [配置说明](config.md)：理解完整配置结构
