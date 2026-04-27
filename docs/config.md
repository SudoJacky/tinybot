# 配置说明

## 配置文件位置

配置文件在 `~/.tinybot/config.json`

### 查看配置

```bash
uv run tinybot config show
```

### 编辑配置

```bash
uv run tinybot config edit
```

或在聊天中输入 `/config` 打开配置编辑器。

---

## 基础配置

### 选择 AI 模型

最重要的配置是选择使用哪个 AI 模型：

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat"
    }
  }
}
```

**常用模型：**

| 模型 | 说明 |
|------|------|
| `deepseek-chat` | DeepSeek 对话模型 |
| `deepseek-reasoner` | DeepSeek 深度推理 |
| `gpt-4o` | OpenAI 最新模型 |
| `qwen-max` | 通义千问 |

### 配置 API 密钥

**推荐方式：环境变量**

设置环境变量更安全：

```bash
export DEEPSEEK_API_KEY="你的密钥"
```

**配置文件方式：**

```json
{
  "providers": {
    "deepseek": {
      "api_key": "你的密钥"
    }
  }
}
```

---

## 常用设置

### 工作目录

设置 AI 操作文件的位置：

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.tinybot/workspace"
    }
  }
}
```

### 时区设置

让 AI 知道你的时区：

```json
{
  "agents": {
    "defaults": {
      "timezone": "Asia/Shanghai"
    }
  }
}
```

**常用时区：**

| 时区 | 地区 |
|------|------|
| `Asia/Shanghai` | 中国 |
| `Asia/Tokyo` | 日本 |
| `America/New_York` | 美国东部 |

---

## AI 行为设置

### 回复长度

控制 AI 单次回复的最大长度：

```json
{
  "agents": {
    "defaults": {
      "max_tokens": 4096
    }
  }
}
```

| 值 | 说明 |
|----|------|
| 1024 | 简短回复 |
| 4096 | 中等长度 |
| 8192 | 详细回复 |

### 创造性控制

控制 AI 回复的随机性：

```json
{
  "agents": {
    "defaults": {
      "temperature": 0.1
    }
  }
}
```

| 值 | 说明 | 适用场景 |
|----|------|----------|
| 0 ~ 0.3 | 稳定、确定 | 编程、问答 |
| 0.5 ~ 0.7 | 平衡 | 一般对话 |
| 0.8 ~ 1.0 | 有创意 | 写作、创意 |

### 深度思考模式

让 AI 进行更深入的推理：

```json
{
  "agents": {
    "defaults": {
      "reasoning_effort": "medium"
    }
  }
}
```

| 值 | 说明 |
|----|------|
| `low` | 快速思考 |
| `medium` | 平衡 |
| `high` | 深度思考 |

仅部分模型支持此功能。

---

## 工具设置

### 网络搜索

控制 AI 能否搜索网络：

```json
{
  "tools": {
    "web": {
      "enable": true
    }
  }
}
```

### 代理设置

如果网络受限，配置代理：

```json
{
  "tools": {
    "web": {
      "proxy": "http://127.0.0.1:7890"
    }
  }
}
```

### 安全限制

限制 AI 只能在工作目录操作：

```json
{
  "tools": {
    "restrict_to_workspace": true
  }
}
```

---

## 知识库设置

启用知识库：

```json
{
  "knowledge": {
    "enabled": true,
    "auto_retrieve": true
  }
}
```

| 设置 | 说明 |
|------|------|
| `enabled` | 是否启用知识库 |
| `auto_retrieve` | 对话时自动搜索知识 |

---

## 网关设置

网页界面和端口设置：

```json
{
  "gateway": {
    "port": 18790
  }
}
```

---

## AI 服务配置

不同 AI 服务需要配置对应的密钥：

### DeepSeek

```json
{
  "providers": {
    "deepseek": {
      "api_key": "你的密钥"
    }
  }
}
```

环境变量：`DEEPSEEK_API_KEY`

### OpenAI

```json
{
  "providers": {
    "openai": {
      "api_key": "你的密钥"
    }
  }
}
```

环境变量：`OPENAI_API_KEY`

### 通义千问

```json
{
  "providers": {
    "dashscope": {
      "api_key": "你的密钥"
    }
  }
}
```

环境变量：`DASHSCOPE_API_KEY`

### Ollama 本地模型

```json
{
  "providers": {
    "ollama": {
      "api_base": "http://localhost:11434/v1"
    }
  }
}
```

本地模型无需 API 密钥。

---

## 配置编辑器

在聊天中按 `Ctrl+O` 或输入 `/config` 打开配置界面：

-分组显示各项设置
- 可直接编辑修改
- 自动验证格式
- 按 `q` 保存退出

---

## 网页界面配置

在网页界面点击设置按钮：

- 查看所有配置项
- 实时编辑保存
- 分组折叠显示

---

## 常见问题

### 配置错误怎么办？

删除配置文件重新初始化：

```bash
rm ~/.tinybot/config.json
uv run tinybot onboard
```

### 如何快速切换模型？

在配置编辑器中修改 `model` 参数。

### API 密钥泄露风险？

使用环境变量而不是直接写在配置文件中。

---

## 下一步

- [AI 服务配置](providers.md) - 各服务详细说明
- [快速开始](quickstart.md) - 开始使用
