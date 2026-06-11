# TS Runtime Migration Progress

更新时间：2026-06-11

本文档用于跟踪 `overall.md` 中建议的 TypeScript runtime migration 推进顺序。推进方式按依赖层分批完成，而不是逐个设计文档从 Phase 1 做到最后。

## Status Legend

- `todo`：尚未开始
- `active`：正在推进
- `blocked`：等待前置依赖或决策
- `verify`：实现大概率完成，但需要按验收项复核
- `done`：已实现并通过必要验证

## Current Focus

- 当前批次：Batch 1，native core 基座已通过本地复核，shared support Phase 1 纯 TS helper 基座已基本建立；正在推进 config canonical schema/selectors。
- 当前业务优先级：`add-source-traceable-knowledge-indexing` 与 knowledge/RAG 相关，但应在 tool/context/session/approval 等前置层稳定后再完整接入。
- 总体路径：`native core -> shared/config -> agent/tool/session/context -> approval/provider -> skills/memory/knowledge/MCP -> command/task -> cowork -> webui/channel/API -> heartbeat`

## Batch Plan

### Batch 0: Foundation Verification

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 1 | done | [ts_native_core.md](ts_native_core.md) | 确认 full-duplex `WorkerConnection`、协议、Rust RPC 基座可用 | `rust-native-core-worker-migration` 为 complete；`cargo test` 158/158 passed |

### Batch 1: Shared Inputs And Minimum Agent Loop

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 2 | verify | [ts_shared_support_runtime_migration_design.md](ts_shared_support_runtime_migration_design.md) | 建立 prompt/template/token/status/evaluator 等公共能力 | 已建立 runtime/token/message/status/template/evaluator support helper 起点，并让 `AgentRunner`、message content 消费 shared helper |
| 3 | active | [ts_config_runtime_migration_design.md](ts_config_runtime_migration_design.md) | 建立 canonical config schema/selectors | 已建立 read-only TS defaults/schema/selectors、default fixture parity、config masking 与 worker snapshot 防御性脱敏 |
| 4 | todo | [ts_agent_loop_design.md](ts_agent_loop_design.md) | 先做 fake-provider `AgentRunner` skeleton | 形成 TS agent 最小执行闭环 |

### Batch 2: Execution, Persistence, And Context

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 5 | todo | [ts_tool_runtime_migration_design.md](ts_tool_runtime_migration_design.md) | 建立 tool schema、registry、prepare/execute metadata | approval、MCP、memory、knowledge、task 的基座 |
| 6 | todo | [ts_session_turn_lifecycle_migration_design.md](ts_session_turn_lifecycle_migration_design.md) | 明确 persistence/checkpoint/resume 语义 | 支撑 approval/form、第二轮对话、background task |
| 7 | todo | [ts_context_builder_migration_design.md](ts_context_builder_migration_design.md) | 接入 deterministic context assembly | 在 AgentRunner 和 session projection 后推进，再挂 memory/RAG/skills |

### Batch 3: Safety And Real Model Runtime

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 8 | todo | [ts_security_approval_migration_design.md](ts_security_approval_migration_design.md) | 建立 approval gate 和安全边界 | 放在 Tool Runtime 之后、副作用能力全面接入之前 |
| 9 | todo | [ts_model_provider_runtime_migration_design.md](ts_model_provider_runtime_migration_design.md) | 让 TS worker 承担真实 chat 后端 | 依赖 ContextBuilder、Tool Runtime、Session/Turn、Approval |

### Batch 4: User Memory, Knowledge, Skills, And External Tools

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 10 | todo | [ts_skills_runtime_migration_design.md](ts_skills_runtime_migration_design.md) | 先解决 prompt 行为 parity，再做 CRUD | 放在 ContextBuilder 之后、WebUI skills routes 切换之前 |
| 11 | todo | [ts_memory_notes_migration_design.md](ts_memory_notes_migration_design.md) | 迁移 memory/notes persistent data 能力 | 依赖 tool/context/session，建议在 approval gate 后推进 |
| 12 | todo | [ts_knowledge_rag_migration_design.md](ts_knowledge_rag_migration_design.md) | 先做 TS types/formatting/tool bridge 和 sparse retrieval | semantic/GraphRAG 后置；当前相关 OpenSpec in-progress |
| 13 | todo | [ts_mcp_runtime_migration_design.md](ts_mcp_runtime_migration_design.md) | 接入 MCP 外部动态工具层 | 应在 Tool Runtime + Approval + Config 稳定后做 |

### Batch 5: Commands, Background Work, And Cowork

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 14 | todo | [ts_command_cli_runtime_migration_design.md](ts_command_cli_runtime_migration_design.md) | 先接 `CommandRouter` 和基础命令 | `/stop`、`/restart`、`/status`、`/help` 可较早插入 AgentLoop |
| 15 | todo | [ts_task_cron_background_runtime_migration_design.md](ts_task_cron_background_runtime_migration_design.md) | 迁移 task/cron/background agent turn | 依赖 Tool Runtime、Security/Approval、Provider Runtime |
| 16 | todo | [ts_cowork_runtime_migration_design.md](ts_cowork_runtime_migration_design.md) | 先做 snapshot/store/blueprint/mutations/mailbox | scheduler/agent runtime 等前置稳定后再接 |

### Batch 6: Transports, Facades, And Upper-Layer Runtime

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 17 | todo | [ts_webui_transport_migration_design.md](ts_webui_transport_migration_design.md) | 做 bootstrap/status/session/WebSocket 最小闭环 | 可在 Cowork 后或与 Cowork 基础 snapshot 并行 |
| 18 | todo | [ts_channel_bus_runtime_migration_design.md](ts_channel_bus_runtime_migration_design.md) | 迁移 channel bus | 完整迁移应放在 WebUI/command 后 |
| 19 | todo | [ts_api_runtime_migration_design.md](ts_api_runtime_migration_design.md) | 作为上层 facade 收口 | Phase 1 OpenAI-compatible API 可提前，完整 domain routes 靠后 |
| 20 | todo | [ts_heartbeat_runtime_migration_design.md](ts_heartbeat_runtime_migration_design.md) | 最后接背景调度和通知组合能力 | 依赖 config、agent loop、context、channel、task/cron、API diagnostics |

## Work Log

| Date | Update |
| --- | --- |
| 2026-06-11 | 根据 `overall.md` 创建初始跟踪文档和分批推进顺序。 |
| 2026-06-11 | 复核 `rust-native-core-worker-migration`：OpenSpec 17/17 complete，`cargo test` in `apps/desktop/src-tauri` 158/158 passed。 |
| 2026-06-11 | 推进 Batch 1 shared support：新增 TS `support/runtimeHelpers`、`support/tokenEstimator`，并从 `AgentRunner` 抽出 finalization、tool result normalization、blank text 和 usage estimate helper。 |
| 2026-06-11 | 继续推进 Batch 1 shared support：新增 TS `support/messageHelpers`、`support/statusFormatter`，覆盖 current time、text block、split/truncate、assistant message、think stripping、runtime status formatting，并让 `agent/messageContent` 复用 shared text block helper。 |
| 2026-06-11 | 补齐 Batch 1 shared support Phase 1 纯 TS helper：新增 `support/templates` 覆盖当前 bundled templates 使用的 Jinja 子集，并新增 `support/evaluator` 覆盖 background notification evaluator prompt/tool decision parsing。 |
| 2026-06-11 | 启动 Batch 1 config canonical schema/selectors：新增 TS read-only config defaults/schema/selectors，覆盖 AgentDefaults、Providers、Tools、Knowledge、Gateway、Channels，并让 provider runtime 通过 selectors 读取 provider/profile/defaults。 |
| 2026-06-11 | 继续 Batch 1 config Phase 1：新增 TS `configMasking`，覆盖 public RPC null masking、UI placeholder masking、sensitive path/key 判定，并让 `NativeConfigBridge.snapshotPublic()` 在进入 provider runtime 前做防御性脱敏。 |
| 2026-06-11 | 继续 Batch 1 config Phase 1：新增 Python `Config().model_dump(mode="json", by_alias=True)` 生成的 `tests/fixtures/config/default_config.json`，并让 TS schema 测试完整解析该 fixture 后与 `defaultTinybotConfig()` 对齐。 |

## Next Checklist

- [x] 复核 `ts_native_core.md` 对应实现和 `rust-native-core-worker-migration` 完成状态。
- [x] 为 Batch 1 拆出第一个可实现任务：shared support runtime 的最小公共 helper/API。
- [x] 继续补齐 shared support Phase 1：template renderer、evaluator parser。
- [x] 迁移 shared support Phase 1 的 status/message helpers。
- [x] 确认 config canonical schema/selectors 的第一阶段边界：先做 read-only schema/defaults/selectors，不替换 load/save/patch。
- [x] 继续 config Phase 1：补齐 config masking 与 worker snapshot 防御性脱敏消费点。
- [x] 继续 config Phase 1：补齐 Python default fixture parity。
- [ ] 继续 config Phase 1：补齐更多 selectors 与后续 snapshot/patch 复用点。
- [x] 在 Batch 1 shared support Phase 1 完成后更新 `Current Focus` 和对应状态。
