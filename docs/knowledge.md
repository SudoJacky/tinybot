# 知识库 (RAG)

## 简介

Tinybot 的知识库系统基于向量存储，支持混合检索、Rerank 重排序，可以在对话中自动注入相关知识。

## 功能特性

| 特性 | 描述 |
|------|------|
| **混合检索** | Dense + Sparse (BM25) 组合检索 |
| **Rerank 重排序** | 可选的重排序提高检索精度 |
| **自动检索模式** | 对话中自动注入相关知识 |
| **本地 Embedding** | 无需外部 API |

## 配置

### 启用知识库

在 `config.json` 中配置：

```json
{
  "knowledge": {
    "enabled": true,
    "auto_retrieve": true,
    "max_chunks": 5,
    "chunk_size": 500,
    "chunk_overlap": 100,
    "retrieval_mode": "hybrid"
  }
}
```

### 配置项说明

| 参数 | 类型 | 描述 |
|------|------|------|
| `enabled` | bool | 是否启用知识库 |
| `auto_retrieve` | bool | 是否自动检索 |
| `max_chunks` | int | 返回的最大片段数 |
| `chunk_size` | int | 文本分块大小 |
| `chunk_overlap` | int | 分块重叠大小 |
| `retrieval_mode` | string | 检索模式：`hybrid`/`dense`/`sparse` |

### Rerank 配置

```json
{
  "knowledge": {
    "rerank_enabled": true,
    "rerank_model": "qwen3-rerank",
    "rerank_api_key_env_var": "DASHSCOPE_API_KEY",
    "rerank_api_base": "https://dashscope.aliyuncs.com/compatible-api/v1",
    "rerank_top_n": 3
  }
}
```

## Embedding 配置

### 本地 Embedding（推荐）

```json
{
  "embedding": {
    "provider": "local",
    "model_name": "all-MiniLM-L6-v2"
  }
}
```

本地模型无需 API Key，首次使用会自动下载。

### 外部 Embedding API

```json
{
  "embedding": {
    "provider": "openai",
    "model_name": "text-embedding-3-small",
    "api_key": "your-api-key",
    "api_base": "https://api.openai.com/v1"
  }
}
```

支持的 Provider：
- `local` - 本地模型
- `openai` - OpenAI API
- `azure` - Azure OpenAI
- `custom` - 自定义 API

## 添加文档

### 通过 WebUI

1. 打开知识库面板
2. 点击"添加"按钮
3. 填写文档信息：
   - 名称
   - 分类（可选）
   - 标签（可选）
   - 内容

### 通过 API

```bash
curl -X POST http://127.0.0.1:18790/api/knowledge/docs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "项目说明",
    "category": "guide",
    "tags": ["tutorial", "setup"],
    "content": "文档内容..."
  }'
```

### 上传文件

支持上传 `.txt` 和 `.md` 文件：

1. 在 WebUI 点击"上传"按钮
2. 选择文件
3. 文件内容自动添加到知识库

## 查询知识库

### 通过 WebUI

1. 打开知识库面板
2. 在查询输入框输入问题
3. 选择检索模式（混合/密集/稀疏）
4. 设置 top_k 值
5. 点击"查询"

### 检索模式对比

| 模式 | 描述 | 适用场景 |
|------|------|------|
| `hybrid` | Dense + Sparse 组合 | 通用场景，平衡语义和关键词 |
| `dense` | 仅向量检索 | 语义相似性搜索 |
| `sparse` | 仅 BM25 | 精确关键词匹配 |

## 管理文档

### 查看文档列表

- WebUI: 知识库面板 → 文档列表
- API: `GET /api/knowledge/docs`

### 删除文档

- WebUI: 点击文档旁的删除按钮
- API: `DELETE /api/knowledge/docs/{doc_id}`

### 重建索引

当文档内容变更后，需要重建索引：

- WebUI: 点击"重建索引"按钮
- API: `POST /api/knowledge/rebuild`

## 自动检索模式

当 `auto_retrieve` 启用时：

1. 用户发送消息
2. 系统自动检索相关知识
3. 将知识注入到 Agent 上下文
4. Agent 基于知识回答问题

### 使用场景

```
用户: 项目的任务调度是怎么工作的？

系统: [自动检索 tasks.md 相关内容]

Agent: 根据文档，任务调度系统的工作原理是...
       [引用知识库内容]
```

## 经验工具

Agent 可以主动管理学习经验：

| 工具 | 描述 |
|------|------|
| `query_experience` | 搜索过去的问题解决经验 |
| `save_experience` | 保存新的解决方案 |
| `feedback_experience` | 标记经验是否有帮助 |
| `delete_experience` | 删除过期或错误的经验 |

### 经验记录结构

```json
{
  "id": "exp_86788c0e",
  "tool_name": "exec",
  "error_type": "argument error",
  "outcome": "resolved",
  "resolution": "解决方案描述...",
  "confidence": 0.7,
  "category": "api",
  "tags": ["opencli", "参数错误"]
}
```

## 最佳实践

1. **合理分块** - `chunk_size` 500-1000 字符效果较好
2. **使用 Rerank** - 对精确度要求高时启用
3. **定期重建** - 文档更新后及时重建索引
4. **分类管理** - 使用 category 和 tags 组织文档
5. **经验积累** - 让 Agent 从错误中学习
