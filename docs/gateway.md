# Gateway 配置

## 简介

Gateway 模式提供多频道接入、定时任务和心跳服务。

```bash
uv run tinybot gateway
```

## 配置结构

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 18790,
    "heartbeat": {
      "enabled": true,
      "interval": 300
    }
  }
}
```

| 参数 | 描述 |
|------|------|
| `host` | 监听地址 |
| `port` | 监听端口 |
| `heartbeat.enabled` | 是否启用心跳 |
| `heartbeat.interval` | 心跳间隔（秒） |

## 频道配置

### WebSocket 频道

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

### 微信频道

```json
{
  "channels": {
    "wechat": {
      "enabled": true,
      "token": "your-token"
    }
  }
}
```

### DingTalk 频道

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "app_key": "...",
      "app_secret": "..."
    }
  }
}
```

### Feishu 频道

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "app_id": "...",
      "app_secret": "..."
    }
  }
}
```

## 消息发送配置

```json
{
  "channels": {
    "send_progress": true,
    "send_tool_hints": true,
    "max_retries": 3
  }
}
```

| 参数 | 描述 |
|------|------|
| `send_progress` | 发送任务进度消息 |
| `send_tool_hints` | 发送工具调用提示 |
| `max_retries` | 发送失败重试次数 |

## 心跳服务

心跳服务在空闲时执行自动任务：

- 内存整理
- 经验分析
- 定期检查

### 配置心跳

```json
{
  "gateway": {
    "heartbeat": {
      "enabled": true,
      "interval": 300
    }
  }
}
```

## 定时任务

Gateway 启动时会加载定时任务：

```json
{
  "cron_tasks": [
    {
      "id": "daily-reminder",
      "schedule": "0 9 * * *",
      "message": "每天提醒检查代码",
      "session_key": "default"
    }
  ]
}
```

## API 模式

作为 OpenAI 兼容 API 服务：

```bash
uv run tinybot api
```

### API 配置

```json
{
  "api": {
    "host": "127.0.0.1",
    "port": 8000,
    "api_key": "your-api-key"
  }
}
```

### 使用方式

任何 OpenAI 客户端都可以连接：

```python
import openai

client = openai.OpenAI(
    api_key="your-api-key",
    base_url="http://127.0.0.1:8000/v1"
)

response = client.chat.completions.create(
    model="tinybot",
    messages=[{"role": "user", "content": "Hello"}]
)
```

## 最佳实践

1. **心跳间隔** - 建议 5-10 分钟
2. **错误重试** - 设置合理的重试次数
3. **安全配置** - 生产环境使用 HTTPS
4. **资源监控** - 监控 Gateway 内存和 CPU
