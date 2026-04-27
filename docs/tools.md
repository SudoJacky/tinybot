# 工具系统

## 内置工具

Tinybot 提供丰富的内置工具，Agent 可以根据任务需要自动调用。

### 文件操作

| 工具 | 描述 |
|------|------|
| `read` | 读取文件内容 |
| `write` | 写入文件 |
| `edit` | 编辑文件（字符串替换） |
| `glob` | 搜索文件（模式匹配） |
| `grep` | 搜索文件内容 |

### Shell 执行

| 工具 | 描述 |
|------|------|
| `exec` | 执行 Shell 命令 |
| `python` | 执行 Python 代码 |

### Web 工具

| 工具 | 描述 |
|------|------|
| `web_search` | 网络搜索 |
| `web_fetch` | 获取网页内容 |

### 系统工具

| 工具 | 描述 |
|------|------|
| `cron` | 定时任务管理 |
| `mcp` | MCP 协议工具 |

### 知识库工具

| 工具 | 描述 |
|------|------|
| `knowledge_query` | 查询知识库 |
| `knowledge_add` | 添加文档 |

### 经验工具

| 工具 | 描述 |
|------|------|
| `query_experience` | 搜索经验 |
| `save_experience` | 保存经验 |
| `feedback_experience` | 反馈经验有效性 |

## 工具配置

### Web 工具配置

```json
{
  "tools": {
    "web": {
      "enabled": true,
      "proxy": "http://127.0.0.1:7890",
      "search_provider": "duckduckgo"
    }
  }
}
```

| 参数 | 描述 |
|------|------|
| `enabled` | 是否启用 Web 工具 |
| `proxy` | HTTP/SOCKS5 代理 |
| `search_provider` | 搜索引擎 |

### 搜索引擎选项

| Provider | 描述 |
|----------|------|
| `duckduckgo` | DuckDuckGo（无需 API Key） |
| `brave` | Brave Search |
| `tavily` | Tavily API |
| `searxng` | SearXNG 实例 |
| `jina` | Jina AI Reader |

### Exec 工具配置

```json
{
  "tools": {
    "exec": {
      "enabled": true,
      "timeout": 120,
      "restrict_workspace": true
    }
  }
}
```

| 参数 | 描述 |
|------|------|
| `enabled` | 是否启用 Exec 工具 |
| `timeout` | 执行超时（秒） |
| `restrict_workspace` | 是否限制在工作区目录 |

## 浏览器自动化

### 安装 OpenCLI

```bash
npm install -g @jackwener/opencli
```

### 安装浏览器扩展

1. 从 [GitHub Releases](https://github.com/jackwener/opencli/releases) 下载扩展
2. 解压后在 `chrome://extensions` 加载

### 验证安装

```bash
opencli doctor
```

### 使用示例

```markdown
用户: 打开百度搜索 Tinybot

Agent 会调用 browser 工具：
1. 打开浏览器
2. 导航到百度
3. 输入搜索词
4. 返回结果
```

## MCP 工具

MCP (Model Context Protocol) 支持连接外部工具服务器。

### 配置 MCP

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "command": "mcp-server-filesystem",
        "args": ["--path", "/workspace"]
      }
    ]
  }
}
```

### MCP 工具特性

- **原生工具封装** - MCP 工具作为原生工具使用
- **多服务器支持** - 同时连接多个 MCP 服务器
- **自动发现** - 自动发现并注册可用工具

## 定时任务

### 使用 cron 工具

```python
# 创建定时任务
cron_create("0 9 * * *", "每天早上9点提醒检查代码")

# 查看任务列表
cron_list()

# 删除任务
cron_delete(task_id)
```

### Cron 表达式

```
┌───────────── 分钟 (0 - 59)
│ ┌───────────── 小时 (0 - 23)
│ │ ┌───────────── 日 (1 - 31)
│ │ │ ┌───────────── 月 (1 - 12)
│ │ │ │ ┌───────────── 星期 (0 - 6)
│ │ │ │ │
* * * * *

示例:
0 9 * * *     - 每天 9:00
*/5 * * * *   - 每 5 分钟
0 9 * * 1-5   - 工作日 9:00
```

## 工作区限制

启用 `restrict_workspace` 后：

- 文件操作限制在工作区目录
- Shell 命令限制在工作区目录
- 防止意外访问系统敏感文件

## 最佳实践

1. **限制工作区** - 生产环境启用 `restrict_workspace`
2. **合理超时** - 设置适当的 Exec 超时时间
3. **代理配置** - 需要外网访问时配置代理
4. **MCP 扩展** - 通过 MCP 获取更多工具能力
