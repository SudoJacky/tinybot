分析以下Agent对话，提取可复用的问题解决经验。

## 对话内容
{conversation}

## 工具执行状态
{tool_events}

## 输出要求
分析对话中的问题解决过程，输出以下格式的经验记录：

```
SUMMARY: <问题场景描述，一句话概括用户遇到的问题类型>
例如："文件路径问题：相对路径找不到文件，改用绝对路径解决"
---
EXPERIENCE:
tool_name: <工具名称，如 read_file, exec>
error_type: <错误类型，成功时填"success">
category: <问题分类: path|permission|encoding|network|api|config|dependency|general>
tags: <场景标签，逗号分隔，如 "workspace,相对路径,配置文件">
resolution: <解决方案，具体、可操作，不超过500字>
confidence: <0.3-1.0，成功=0.7，解决失败=0.8>
---
EXPERIENCE:
...
```

## SUMMARY 编写原则
**重点描述问题场景，而非工具名**：
- "路径问题：找不到配置文件" ← 好
- "read_file工具失败" ← 不好（太工具化）

示例：
- "路径问题：工作区外的文件无法直接访问，需要使用绝对路径"
- "权限问题：Windows下执行命令需要管理员权限"
- "编码问题：读取UTF-8文件时BOM头导致解析失败"
- "网络问题：API请求超时，需要增加重试机制"

## category 分类标准
- **path**: 文件路径、目录、工作区访问问题
- **permission**: 权限、认证、访问控制问题
- **encoding**: 编码、字符集、格式解析问题
- **network**: 网络、API、连接超时问题
- **api**: API调用、参数、响应处理问题
- **config**: 配置文件、环境变量、设置问题
- **dependency**: 依赖、包管理、版本问题
- **general**: 其他通用问题

## tags 编写原则
提取3-5个关键词标签，描述具体场景：
- 使用英文或中文，保持一致性
- 包含关键实体（如"workspace"、"配置文件"）
- 包含关键操作（如"相对路径"、"绝对路径"）

## 提取原则
- 只提取有价值的经验：失败后解决、重要成功模式、踩坑教训
- 跳过普通成功（无特殊模式的执行）
- resolution要具体可操作，而非泛泛而谈
- confidence反映经验的可复用程度

## 示例输出
```
SUMMARY: 文件路径问题：相对路径找不到配置文件，改用绝对路径解决
---
EXPERIENCE:
tool_name: read_file
error_type: FileNotFoundError
category: path
tags: workspace,相对路径,配置文件
resolution: 当相对路径失败时，检查文件是否在工作区外，尝试使用workspace绝对路径拼接
confidence: 0.8
---
```

如果没有有价值的经验可提取，输出：
```
SUMMARY: <简要描述对话内容>
SKIP: 无特殊经验需要记录
```
