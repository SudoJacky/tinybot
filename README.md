# Tinybot

一个轻量的个人 AI 助手框架，将大语言模型与多种聊天平台、工具系统和自动化机制集成在一起。

## 特性

- **多平台接入** — 内置微信、钉钉、飞书频道，支持插件扩展
- **丰富的工具** — 文件读写、Shell 执行、浏览器自动化、定时任务等
- **智能记忆** — 基于向量存储的记忆系统，支持会话整合与语义搜索
- **多 LLM 支持** — 兼容 OpenAI、DeepSeek、智谱、通义千问、Gemini 等 14+ 家提供商
- **自动化** — 定时任务（Cron）+ 心跳服务，周期性自动执行任务
- **OpenAI 兼容 API** — 可作为 OpenAI 兼容后端服务运行

## 快速开始

```bash
# 安装
uv sync

# 初始化配置
uv run tinybot onboard

# 交互模式
uv run tinybot agent

# 发送单条消息
uv run tinybot agent -m "你好"

# 启动网关（多频道 + 定时任务 + 心跳）
uv run tinybot gateway
```

## 编程接口

```python
from tinybot import Tinybot

bot = Tinybot.from_config()
result = await bot.run("帮我总结这个仓库")
print(result.content)
```

## 环境要求

- Python >= 3.13

## 许可证

[MIT](LICENSE)
