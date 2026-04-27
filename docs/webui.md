# WebUI 使用指南

## 启用 WebUI

### 1. 配置 WebSocket 频道

编辑配置文件 `~/.tinybot/config.json`，添加以下内容：

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

### 2. 启动 Gateway

```bash
uv run tinybot gateway
```

### 3. 访问界面

打开浏览器访问 `http://127.0.0.1:18790`

## 界面布局

WebUI 采用三栏布局：

| 区域 | 功能 |
|------|------|
| **左侧边栏** | 会话列表、系统状态 |
| **中间区域** | 聊天消息、输入框 |
| **右侧面板** | 工具、知识库、技能、工作区 |

## 功能说明

### 聊天功能

- **实时流式对话** - 支持 Markdown 渲染和代码高亮
- **会话管理** - 新建、切换、清空、删除会话
- **快捷键** - `Ctrl+O` 打开配置，`/help` 显示命令

### 工具面板

点击工具面板可以查看所有可用工具及其参数定义。

### 知识库管理

- **文档列表** - 查看已添加的文档
- **添加文档** - 上传或手动添加文本内容
- **知识查询** - 测试检索功能
- **重建索引** - 更新向量索引

### 技能管理

- **查看技能** - 浏览所有可用技能
- **创建技能** - 在界面中编写新的 SKILL.md
- **启用/禁用** - 切换技能状态
- **验证格式** - 检查技能定义是否符合规范

### 工作区编辑

- 选择工作区中的 Markdown 文件进行编辑
- 实时保存修改

### 设置管理

- 直接在界面修改所有配置项
- Agent、Provider、Tools、Gateway 等配置分组

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/sessions` | GET | 获取所有会话列表 |
| `/api/sessions/{key}/messages` | GET | 获取会话消息 |
| `/api/sessions/{key}` | DELETE/PATCH | 删除/更新会话 |
| `/api/sessions/{key}/clear` | POST | 清空会话历史 |
| `/api/config` | GET/PATCH | 获取/更新配置 |
| `/api/tools` | GET | 获取可用工具 |
| `/api/skills` | GET | 获取所有技能 |
| `/ws` | WebSocket | 实时聊天连接 |

## WebSocket 事件

### 客户端发送

| 事件 | 描述 |
|------|------|
| `new_chat` | 创建新会话 |
| `attach` | 连接到已有会话 |
| `message` | 发送消息 |
| `interrupt` | 停止 AI 生成 |
| `ping` | 心跳 |

### 服务端发送

| 事件 | 描述 |
|------|------|
| `delta` | 流式文本片段 |
| `stream_end` | 流结束 |
| `message` | 完整消息 |
| `file_updated` | 工作区文件变更 |

## 主题切换

WebUI 支持亮色/暗色主题：

- 点击右下角的主题切换按钮
- 设置自动保存到 localStorage

## 多语言支持

- 点击语言按钮切换中/英文
- 界面文本自动更新
