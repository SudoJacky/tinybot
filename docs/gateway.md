# 网关服务

网关服务用于让 Tinybot 长时间运行，并向网页界面、聊天平台、定时任务和心跳服务提供入口。简单说：如果你想用浏览器访问 Tinybot，通常就需要启动 gateway。

## 什么时候需要网关

| 场景 | 是否需要 |
|------|----------|
| 命令行临时聊天 | 不需要，使用 `uv run tinybot agent` |
| 浏览器 WebUI | 需要 |
| 飞书、钉钉、微信等频道 | 需要 |
| 定时任务和心跳服务长期运行 | 需要 |
| OpenAI 兼容 API | 不使用 gateway，使用 `uv run tinybot api` |

## 启动网关

```bash
uv run tinybot gateway
```

如果 WebSocket 频道已启用，浏览器访问：

```text
http://127.0.0.1:18790
```

## 启用网页频道

配置文件中需要有：

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

`127.0.0.1` 表示只有本机能访问，适合个人使用。不要在不了解网络安全的情况下把服务暴露到公网。

## 修改端口

如果 `18790` 被占用，可以临时指定端口：

```bash
uv run tinybot gateway --port 18800
```

也可以修改 WebSocket 频道配置：

```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18800
    }
  }
}
```

然后访问：

```text
http://127.0.0.1:18800
```

## 连接聊天平台

Tinybot 内置飞书、钉钉、微信等频道。配置好频道后，gateway 会负责接收平台消息并交给 Agent 处理。

通用流程：

1. 在对应平台创建应用
2. 获取平台要求的 ID、Secret、Token 等信息
3. 在 `channels` 下启用对应频道
4. 启动 `uv run tinybot gateway`
5. 在平台侧完成回调地址或登录配置

示例结构：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "你的 App ID",
      "appSecret": "你的 App Secret"
    }
  }
}
```

不同平台字段不同，以对应频道配置为准。

## 心跳服务

gateway 中包含心跳服务，用于周期性维护，例如整理记忆、检查后台任务等。

相关配置：

```json
{
  "gateway": {
    "heartbeat": {
      "enabled": true,
      "intervalS": 1800,
      "keepRecentMessages": 8
    }
  }
}
```

新手保持默认即可。

## 定时任务

启动 gateway 后，Tinybot 可以处理定时任务。例如你可以在对话中说：

```text
每天早上 9 点提醒我检查待办事项。
```

定时任务需要 gateway 持续运行。如果你关闭终端，定时任务也会停止。

## 常见问题

### 网页打不开

检查：

1. `uv run tinybot gateway` 是否仍在运行
2. WebSocket 频道是否启用
3. 端口是否正确
4. 防火墙是否拦截

### gateway 启动了但没有网页

通常是 `channels.websocket.enabled` 没有开启，或 `staticDir` 指向的 WebUI 文件不存在。

### 局域网其他设备访问不了

需要把 `host` 改为 `0.0.0.0`，并确认防火墙允许端口访问。只在可信网络中这样做。

## 下一步

- [网页界面](webui.md)：使用浏览器和 Tinybot 对话
- [配置说明](config.md)：了解网关和频道配置
- [任务系统](tasks.md)：使用定时任务和复杂任务
