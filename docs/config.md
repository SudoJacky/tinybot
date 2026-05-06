# 配置说明

配置决定 Tinybot 使用哪个模型、能访问哪些工具、在哪里读写文件，以及网页服务如何启动。新手不需要一次理解全部配置，先掌握模型、密钥、工作区和安全限制即可。

## 配置文件位置

默认配置文件：

```text
~/.tinybot/config.json
```

查看当前状态：

```bash
uv run tinybot status
```

重新打开初始化向导：

```bash
uv run tinybot onboard
```

在命令行聊天里也可以输入 `/config` 或按 `Ctrl+O` 打开配置编辑器。

## 最小可用配置

一个能正常对话的最小配置需要三类信息：

| 配置 | 作用 |
|------|------|
| Provider API Key | 让 Tinybot 能调用 AI 服务 |
| Model | 告诉 Tinybot 使用哪个模型 |
| Workspace | 告诉 Tinybot 可以在哪个目录工作 |

示例：

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
      "apiKey": "你的 DeepSeek 密钥"
    }
  }
}
```

配置文件支持 camelCase 和 snake_case。上面的 `apiKey` 也可以写成 `api_key`。

## 选择模型

Tinybot 会根据模型名称自动匹配 Provider。新手可以按下面选择：

| 场景 | 推荐模型 |
|------|----------|
| 日常聊天、写文档、总结 | `deepseek-chat` |
| 复杂分析、代码推理、多步骤规划 | `deepseek-reasoner` |
| 已有 OpenAI 账号 | `gpt-4o` 或其他 OpenAI 模型 |
| 通义千问用户 | `qwen-max` 或你账号可用的 Qwen 模型 |

配置位置：

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat"
    }
  }
}
```

如果模型名称和密钥不匹配，例如使用 `gpt-4o` 但只配置了 DeepSeek 密钥，就会调用失败。

## 配置 API 密钥

推荐用初始化向导或网页设置填写密钥。也可以手动写配置文件：

```json
{
  "providers": {
    "deepseek": {
      "apiKey": "你的密钥"
    },
    "openai": {
      "apiKey": "你的密钥"
    },
    "dashscope": {
      "apiKey": "你的密钥"
    }
  }
}
```

如果你把项目分享给别人，提交代码前一定不要把真实密钥提交到 Git。

## 工作区和安全限制

工作区是 Tinybot 读写文件时默认使用的目录：

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  }
}
```

新手建议同时开启工作区限制：

```json
{
  "tools": {
    "restrictToWorkspace": true
  }
}
```

这样 Tinybot 的文件操作会尽量限制在工作区内，降低误改系统文件或其他项目文件的风险。

## 常用 Agent 参数

| 配置 | 默认倾向 | 说明 |
|------|----------|------|
| `temperature` | `0.1` | 越低越稳定，适合编程和严肃任务 |
| `maxTokens` | `8192` | 单次回复最大长度 |
| `contextWindowTokens` | `65536` | 可保留的上下文长度 |
| `maxToolIterations` | `200` | 一轮任务最多调用多少次工具 |
| `reasoningEffort` | 空或模型支持值 | 推理模型可设置 `low`、`medium`、`high` |
| `timezone` | `UTC` | 建议中国用户设为 `Asia/Shanghai` |

示例：

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

## 工具配置

Tinybot 的工具能力由 `tools` 控制：

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

| 配置 | 建议 |
|------|------|
| `tools.web.enable` | 需要联网搜索时开启 |
| `tools.exec.enable` | 需要执行命令时开启；不放心可以关闭 |
| `tools.exec.timeout` | 命令最长运行时间，默认 60 秒 |
| `tools.restrictToWorkspace` | 新手建议开启 |

## 网页界面配置

网页界面由 WebSocket 频道提供：

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

`gateway.port` 是网关服务配置，WebSocket 频道也有自己的 `port`。通常保持二者一致或只使用 WebSocket 频道默认值即可。

启动：

```bash
uv run tinybot gateway
```

访问：

```text
http://127.0.0.1:18790
```

## 知识库配置

知识库默认关闭。需要让 Tinybot 引用你的文档时再开启：

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

| 配置 | 说明 |
|------|------|
| `enabled` | 是否启用知识库 |
| `autoRetrieve` | 每次提问时是否自动检索相关文档 |
| `maxChunks` | 每次最多取回多少片段 |
| `retrievalMode` | `hybrid` 适合大多数场景 |

## 常见问题

### 配置改坏了怎么办

先备份旧配置，再重新初始化：

```bash
uv run tinybot onboard
```

如果要完全重来，可以删除 `~/.tinybot/config.json` 后再执行初始化。删除前请确认里面没有你还需要的配置。

### 设置了环境变量但 Tinybot 没读到

当前配置 schema 主要从 `config.json` 读取 Provider 密钥。最稳妥的方式是通过 `uv run tinybot onboard` 或网页设置写入配置文件。

### 更换模型后报错

检查模型和 Provider 是否匹配。例如：

| 模型 | 需要的密钥 |
|------|------------|
| `deepseek-chat` | DeepSeek |
| `gpt-4o` | OpenAI |
| `qwen-max` | DashScope/通义千问 |

## 下一步

- [AI 服务配置](providers.md)：选择和配置 Provider
- [工具功能](tools.md)：理解工具权限和安全边界
- [网页界面](webui.md)：通过浏览器修改配置
