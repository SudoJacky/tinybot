# Tinybot Documentation

## 快速开始 / Quick Start

### 安装 / Installation

使用 `uv` 进行依赖管理和安装：

```bash
# 安装依赖
uv sync

# 初始化配置
uv run tinybot onboard
```

### 启动模式 / Start Modes

| 命令 | 描述 |
|------|------|
| `uv run tinybot agent` | 交互聊天模式 |
| `uv run tinybot agent -m "Hello"` | 发送单条消息 |
| `uv run tinybot gateway` | 启动网关（WebUI + 多频道 + 定时任务） |
| `uv run tinybot api` | 作为 OpenAI 兼容 API 服务运行 |

### 系统要求 / Requirements

- Python >= 3.13

## 下一步 / Next Steps

- [WebUI 使用指南](webui.md) - 了解 Web 界面功能
- [任务调度系统](tasks.md) - Agentic DAG 任务分解
- [知识库 RAG](knowledge.md) - 向量检索知识系统
- [工具系统](tools.md) - 内置工具详解
