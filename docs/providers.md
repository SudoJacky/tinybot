# AI 服务配置

## 支持哪些 AI 服务？

Tinybot 支持多种 AI 服务提供商：

| 服务 | 说明 | 推荐场景 |
|------|------|----------|
| DeepSeek | 国内服务，价格实惠 | 日常使用、编程助手 |
| OpenAI (GPT-4) | 功能强大 | 复杂任务、多模态需求 |
| 通义千问 (Qwen) | 阿里云服务 | 国内用户、中文优化 |
| 智谱 AI (GLM) | 国产模型 | 中文场景 |
| Moonshot (Kimi) | 长文本处理 | 文档分析 |
| OpenRouter | 多模型聚合 | 尝试不同模型 |
| Ollama | 本地运行 | 无需网络、隐私保护 |

---

## 如何配置？

### 方法一：初始化配置

运行初始化命令，会引导你配置：

```bash
uv run tinybot onboard
```

### 方法二：网页界面

在网页界面的设置面板中配置 API 密钥。

### 方法三：环境变量（推荐）

设置环境变量，更安全：

**Windows (PowerShell):**
```powershell
$env:DEEPSEEK_API_KEY = "你的密钥"
```

**Mac/Linux:**
```bash
export DEEPSEEK_API_KEY="你的密钥"
```

---

## 获取 API 密钥

在对应平台注册账号后获取：

| 服务 | 获取地址 |
|------|----------|
| DeepSeek | https://platform.deepseek.com |
| OpenAI | https://platform.openai.com |
| 通义千问 | https://dashscope.aliyuncs.com |
| 智谱 AI | https://open.bigmodel.cn |
| Moonshot | https://platform.moonshot.cn |
| OpenRouter | https://openrouter.ai |

---

## 选择模型

不同模型适合不同场景：

### DeepSeek 模型

| 模型 | 说明 |
|------|------|
| deepseek-chat | 日常对话，快速响应 |
| deepseek-reasoner | 深度思考，适合复杂问题 |

### OpenAI 模型

| 模型 | 说明 |
|------|------|
| gpt-4o | 最新旗舰，功能全面 |
| gpt-4o-mini | 轻量版，速度快 |
| o1/o3 | 推理模型，适合复杂逻辑 |

### 通义千问模型

| 模型 | 说明 |
|------|------|
| qwen-max | 高性能版 |
| qwen-turbo | 快速版 |

---

## 自动匹配

Tinybot 会根据模型名称自动选择对应的 AI 服务：

- 使用 `deepseek-chat` → 自动使用 DeepSeek 服务
- 使用 `gpt-4o` → 自动使用 OpenAI 服务
- 使用 `qwen-max` → 自动使用通义千问服务

你只需要配置对应服务的 API 密钥即可。

---

## 本地模型 (Ollama)

如果你在本机安装了 Ollama，可以使用本地模型，无需 API 密钥。

### 安装 Ollama

访问 https://ollama.com 下载安装

### 运行模型

```bash
ollama run llama3.2
```

### 配置 Tinybot

在设置中选择 `ollama` 作为 Provider，模型名称填 `llama3.2`。

---

## 常见问题

### API 调用失败？

检查：
1. API 密钥是否正确
2. 网络是否正常
3. 账户余额是否充足

### 如何更换模型？

在配置中修改 `model` 参数，或使用 `/config` 命令打开配置编辑器。

### 费用太高？

考虑：
1. 使用 DeepSeek（价格较低）
2. 使用本地模型（完全免费）
3. 减少不必要的长对话

---

## 下一步

- [详细配置](config.md) - 所有配置选项说明
- [快速开始](quickstart.md) - 开始使用
