# 配置系统

## 配置文件位置

配置文件存储在 `~/.tinybot/config.json`

```bash
# 查看配置路径
uv run tinybot config show

# 编辑配置
uv run tinybot config edit
```

## 配置编辑器

在交互模式下按 `Ctrl+O` 或输入 `/config` 打开全屏配置编辑器。

### 功能

- 分组显示配置项
- 实时编辑和保存
- 验证配置格式
- 查看当前值

## 配置结构

```json
{
  "agent": {
    "workspace": "path/to/workspace",
    "model": "gpt-4o",
    "provider": "auto",
    "temperature": 0.7,
    "max_tokens": 4096,
    "context_window": 128000,
    "max_tool_iterations": 50
  },
  "providers": {
    "openai": {
      "api_key": "sk-...",
      "api_base": "https://api.openai.com/v1"
    }
  },
  "tools": {
    "web": {
      "enabled": true,
      "proxy": "",
      "search_provider": "duckduckgo"
    },
    "exec": {
      "enabled": true,
      "timeout": 120,
      "restrict_workspace": true
    }
  },
  "knowledge": {
    "enabled": true,
    "auto_retrieve": true,
    "max_chunks": 5
  },
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18790
    }
  },
  "gateway": {
    "host": "127.0.0.1",
    "port": 18790
  }
}
```

## 配置分组

### Agent 配置

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `workspace` | string | `./workspace` | 工作区目录 |
| `model` | string | - | 模型名称 |
| `provider` | string | `auto` | Provider 类型 |
| `temperature` | float | `0.7` | 温度参数 |
| `max_tokens` | int | `4096` | 最大输出长度 |
| `context_window` | int | `128000` | 上下文窗口 |
| `max_tool_iterations` | int | `50` | 最大工具调用次数 |
| `reasoning_effort` | string | - | 推理强度 |
| `timezone` | string | `Asia/Shanghai` | 时区 |

### Provider 配置

| 参数 | 类型 | 描述 |
|------|------|------|
| `api_key` | string | API 密钥 |
| `api_base` | string | API 地址 |

### Tools 配置

#### Web 工具

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `enabled` | bool | `true` | 启用 Web 工具 |
| `proxy` | string | - | 代理地址 |
| `search_provider` | string | `duckduckgo` | 搜索引擎 |

#### Exec 工具

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `enabled` | bool | `true` | 启用 Exec 工具 |
| `timeout` | int | `120` | 超时时间（秒） |
| `restrict_workspace` | bool | `true` | 限制在工作区 |

### Knowledge 配置

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `enabled` | bool | `false` | 启用知识库 |
| `auto_retrieve` | bool | `false` | 自动检索 |
| `max_chunks` | int | `5` | 最大片段数 |
| `chunk_size` | int | `500` | 分块大小 |
| `chunk_overlap` | int | `100` | 分块重叠 |
| `retrieval_mode` | string | `hybrid` | 检索模式 |

### Channels 配置

| 参数 | 类型 | 描述 |
|------|------|------|
| `enabled` | bool | 启用频道 |
| `host` | string | 监听地址 |
| `port` | int | 监听端口 |

### Gateway 配置

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `host` | string | `127.0.0.1` | 监听地址 |
| `port` | int | `18790` | 监听端口 |

## 环境变量

配置中的环境变量支持：

```json
{
  "providers": {
    "openai": {
      "api_key_env_var": "OPENAI_API_KEY"
    }
  }
}
```

系统会读取环境变量 `OPENAI_API_KEY` 作为 API 密钥。

## 安全性

### API 密钥保护

- API 密钥在 WebUI 中显示为密码字段
- 建议使用环境变量而非直接配置

### 工作区限制

启用 `restrict_workspace` 后：

- 文件操作限制在工作区
- Shell 命令限制在工作区
- 防止意外操作

## WebUI 配置管理

在 WebUI 中点击设置按钮可以：

- 查看所有配置项
- 实时编辑并保存
- 分组折叠展开
- 验证配置格式

## 最佳实践

1. **使用环境变量** - API Key 使用环境变量存储
2. **限制工作区** - 生产环境启用 `restrict_workspace`
3. **合理温度** - 根据任务类型设置 temperature
4. **定期检查** - 检查配置是否过期
