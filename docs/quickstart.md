# 快速开始

## 安装

首先确保你已安装 Python 3.13 或更高版本。

### 步骤 1：安装依赖

```bash
uv sync
```

### 步骤 2：初始化配置

```bash
uv run tinybot onboard
```

这个命令会引导你完成初始配置，包括选择 AI 模型和设置 API 密钥。

---

## 启动使用

Tinybot 有几种使用方式：

| 命令 | 说明 |
|------|------|
| `uv run tinybot agent` | 打开聊天界面，和 AI 对话 |
| `uv run tinybot gateway` | 启动网页界面，可在浏览器中使用 |
| `uv run tinybot api` | 作为 API 服务运行（高级用法） |

### 最简单的方式

直接运行：

```bash
uv run tinybot agent
```

然后输入你的问题，AI 会回答并帮你完成任务。

---

## 网页界面

如果你更喜欢用浏览器，可以这样启动：

```bash
uv run tinybot gateway
```

然后打开浏览器访问 `http://127.0.0.1:18790`

---

## 常见问题

### 需要什么 AI 模型？

Tinybot 支持多种 AI 服务。推荐使用：

- **DeepSeek** - 国内服务，性价比高
- **OpenAI (GPT-4)** - 国际服务，功能强大
- **通义千问 (Qwen)** - 阿里云服务

### 如何获取 API 密钥？

在对应 AI 服务的官网注册账号后获取：

| 服务 | 获取地址 |
|------|----------|
| DeepSeek | https://platform.deepseek.com |
| OpenAI | https://platform.openai.com |
| 通义千问 | https://dashscope.aliyuncs.com |

### 必须要配置 API 密钥吗？

是的，大多数 AI 服务需要 API 密钥才能使用。本地模型（如 Ollama）不需要密钥，但需要你在本机部署模型。

---

## 下一步

- [网页界面使用](webui.md) - 了解网页界面的功能
- [知识库](knowledge.md) - 让 AI 学习你的文档
- [工具功能](tools.md) - AI 能做什么
- [技能系统](skills.md) - 自定义 AI 的行为
