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

- 当前批次：Batch 2：native core/shared/config/AgentRunner 最小闭环已进入 verify；tool runtime 已开始推进并收紧 approval-aware policy；session/turn lifecycle 正在推进，已建立 persisted-message 清洗边界、dedupe/truncate、versioned checkpoint helper、`session.persist_turn` RPC 起点、Rust `session.get_history` legal projection、`agent.done.payload.lifecycle` 可观测元数据，以及 `TurnLifecycle.finalizeTurn()` / checkpoint write-clear / restore materialization / approval-form resume projection 抽象；ContextBridge -> ContextBuilder -> AgentRunSpec 的 run_input projection 已抽出，且 context metadata 已进入 persist-turn 边界；下一步继续补更完整的连续会话验收。
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
| 3 | verify | [ts_config_runtime_migration_design.md](ts_config_runtime_migration_design.md) | 建立 canonical config schema/selectors | Phase 1 已复核；Phase 2 已建立 TS migration、path resolver、load diagnostics 与 Rust/native file I/O 起点；Phase 3 已建立 TS config patch/validate、native patch-result bridge、side-effect planning、受控 write RPC、store-aware 持久化、TS patch 输入桥接与桌面 settings native-first 保存路径 |
| 4 | verify | [ts_agent_loop_design.md](ts_agent_loop_design.md) | 先做 fake-provider `AgentRunner` skeleton | TS `AgentRunner` / worker 最小执行闭环已具备，覆盖 final response、tool loop、usage、checkpoint/session append/clear、awaiting input、restore/resume 与 cancel；等待按 agent loop 验收项复核 |

### Batch 2: Execution, Persistence, And Context

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 5 | active | [ts_tool_runtime_migration_design.md](ts_tool_runtime_migration_design.md) | 建立 tool schema、registry、prepare/execute metadata | 已具备 schema casting/validation、registry/runtime/native proxy 起点；本轮补齐 approval-aware policy，approval-gated 工具要求 `approval.request` 并限制在可交互通道 |
| 6 | active | [ts_session_turn_lifecycle_migration_design.md](ts_session_turn_lifecycle_migration_design.md) | 明确 persistence/checkpoint/resume 语义 | 已建立 `persistedMessages` 起点和 Rust/TS `session.persist_turn` RPC；AgentWorker 在可用时优先通过 `TurnLifecycle.finalizeTurn()` 写 completed turn，并通过 `TurnLifecycle.writeCheckpoint()` / `clearCheckpoint()` / `restoreCheckpoint()` 收敛 checkpoint write-clear 与 restore materialization；`checkpoint.ts` 已承载 approval/form resume projection helper；`agent.done.payload.lifecycle` 暴露 persisted/saved/checkpoint/omitted side-effect metadata；已补齐 TS persistence helper 的 Python-key dedupe/tool truncate、versioned checkpoint helper，以及 Rust `session.get_history` 的 user/tool legal boundary projection；真实 TS worker 连续两轮可读取上一轮 persisted history |
| 7 | active | [ts_context_builder_migration_design.md](ts_context_builder_migration_design.md) | 接入 deterministic context assembly | 已有 deterministic `contextBuilder.ts`、`NativeContextBridge` 与 `agent.run_input` product path；已新增 `runInputContext.ts`，把 ContextBridge 输出投影为 AgentRunSpec 和 context metadata；本轮补齐 run_input context metadata -> TurnLifecycle persist-turn 传递，下一步补连续会话 round-trip 验收，再挂 memory/RAG/skills |

### Batch 3: Safety And Real Model Runtime

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 8 | active | [ts_security_approval_migration_design.md](ts_security_approval_migration_design.md) | 建立 approval gate 和安全边界 | Phase 1 TS classifier/fingerprint complete. Phase 2 Rust pending store started. Phase 3 TS `NativeApprovalBridge.requestApproval()` added. Phase 4 TS `ApprovalRuntime` now gates `ToolRuntime.execute()` before risky side effects, and AgentRunner's existing `requiresApproval` path emits the same fingerprint/classification contract. Phase 5 native once/session scope reuse now allows matching requests, consumes once approvals, and keeps session approvals scoped to the original session. |
| 9 | active | [ts_model_provider_runtime_migration_design.md](ts_model_provider_runtime_migration_design.md) | 让 TS worker 承担真实 chat 后端 | 已有 provider catalog/runtime/model-listing、OpenAI request builder、stream parser、retry helper 与 native secret bridge 起点；已补齐 native config patch 后 provider secret snapshot 同步、OpenAI-compatible prompt caching request trait 的 cache_control marker 注入、stream idle timeout、stream interruption terminal error delta、retry-after body unit parsing、Retry-After HTTP-date parsing、provider response body error extraction、lazy provider config reload、provider retry wait event、run_input provider retry default projection、live model discovery refresh，以及 `provider.catalog.list` / `provider.runtime.resolve` / `provider.models.list` / `provider.model.validate` worker RPC 起点。 |

### Batch 4: User Memory, Knowledge, Skills, And External Tools

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 10 | active | [ts_skills_runtime_migration_design.md](ts_skills_runtime_migration_design.md) | 先解决 prompt 行为 parity，再做 CRUD | Started TS Skills Runtime prompt parity: pure runtime now covers workspace-over-builtin discovery, frontmatter/tinybot/openclaw metadata, requirements availability, XML summary, always-skill selection, optional ContextBuilder injection, native `skills.list`, `agent.run_input` skills context loading, Python-compatible WebUI list/detail projection, and desktop native-first Skills list/detail/create/update/delete/validate routing through the TS worker. |
| 11 | active | [ts_memory_notes_migration_design.md](ts_memory_notes_migration_design.md) | 迁移 memory/notes persistent data 能力 | 已启动 TS/native Memory Notes recall 与显式操作面；`memory.search/save/trace/reject/supersede` 已具备 Rust RPC 与 TS native tools 起点；`memory.recall` 已由 Rust/native 生成 bounded recall context、notes、references，并由 TS `NativeContextBridge` 优先用于 `agent.run_input` context；`memory.capture_evidence/list_evidence` 已建立 native conversation evidence JSONL/cursor 起点，并由 TS TurnLifecycle 在 persist-turn 后调用；后续补 Dream extraction/consolidation/profile hooks |
| 12 | active | [ts_knowledge_rag_migration_design.md](ts_knowledge_rag_migration_design.md) | 先做 TS types/formatting/tool bridge 和 sparse retrieval | Phase 1 tool/formatting contract is in place. Phase 2 now has Rust `WorkerKnowledgeRpc`, `knowledge.read/write` capabilities, JSONL `documents/chunks` persistence, document CRUD, markdown-section parent chunks, child retrieval chunks, sparse `knowledge.query` returning parent context with matched child snippets, a native `knowledge.stats` readiness/count payload, and `knowledge.context` model-facing `[RELEVANT KNOWLEDGE]` context consumed by TS `NativeContextBridge`/`ContextBuilder`; `query_rag` remains as a workspace-file compatibility alias. |
| 13 | active | [ts_mcp_runtime_migration_design.md](ts_mcp_runtime_migration_design.md) | 接入 MCP 外部动态工具层 | Started MCP runtime migration: Phase 1 config/schema contract normalizes server settings, transport auto-detection, allowlists, wrapped names, and nullable JSON Schema; Phase 2 has `mcpToolWrapper`; Phase 3 now has a fake-client `McpRuntimeManager` plus a native MCP bridge enabled in the real TS worker entrypoint that discovers native fixture tools through `mcp.list_tools`, registers dynamic `mcp_<server>_<tool>` wrappers before runs, reports skipped/unmatched/failed/collision diagnostics, preserves high-risk approval, forwards approved calls to `mcp.call_tool`, tolerates discovery failures without blocking normal runs, and replaces MCP registrations on reconnect while preserving non-MCP tools. |

### Batch 5: Commands, Background Work, And Cowork

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 14 | active | [ts_command_cli_runtime_migration_design.md](ts_command_cli_runtime_migration_design.md) | 先接 `CommandRouter` 和基础命令 | Continued Command Runtime Phase 1: `/help`, priority `/stop`, priority `/status`, and priority `/restart` now run inside AgentWorker before provider execution. `/stop` cancels active runs for the current session; `/status` reports active run counts; `/restart` calls the injected native restart bridge. Richer CLI/new/approval/dream commands remain later. |
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
| 2026-06-11 | 继续 Batch 1 config Phase 1：新增 `selectProviderRuntimeInput(config, model?)` 聚合 selector，覆盖 profile 优先级、explicit provider 和 model override，并让 provider runtime 消费该 selector。 |
| 2026-06-11 | 继续 Batch 1 config Phase 1：新增 TS `configSnapshot`，复用 masking/path 规则实现 public snapshot 构造、public path read、invalid/sensitive path 拒绝，并让 `NativeConfigBridge.snapshotPublic()` 消费该复用层。 |
| 2026-06-11 | 复核 Batch 1 config Phase 1 验收项后进入 Phase 2 起点：新增 TS `configMigrations`，对齐 Python `_migrate_config()` 的 `tools.exec.restrictToWorkspace` 到 `tools.restrictToWorkspace` 迁移，并让 `parseTinybotConfig()` 消费迁移结果。 |
| 2026-06-11 | 继续 Batch 1 config Phase 2：新增 TS `configPaths` 纯函数起点，对齐 Python `paths.py` 的 config data dir、media/cron/logs/knowledge、workspace、CLI history、bridge、legacy sessions 路径派生；暂不做目录创建或替换 Rust ConfigStore。 |
| 2026-06-11 | 继续 Batch 1 config Phase 2：新增 TS `configLoad` 纯函数起点，覆盖 missing config defaults、invalid JSON/invalid config diagnostics fallback、migration-backed load，以及 canonical camelCase JSON serialization；暂不直接读写文件。 |
| 2026-06-11 | 继续 Batch 1 config Phase 2：新增 Rust/native `config_store` 文件 I/O 起点，覆盖 missing/invalid/non-object config diagnostics fallback 与 pretty JSON save；同时修复 TS worker 入口中 Node strip-only 不支持的 constructor parameter properties。 |
| 2026-06-11 | 启动 Batch 1 config Phase 3：新增 TS `configPatch` 起点，覆盖 deep partial merge、masked secret placeholder skip、全量 schema revalidation rollback 与 `updatedFields` 叶子路径输出，为后续 Rust/native `config.patch` 桥接提供稳定结果结构。 |
| 2026-06-11 | 继续 Batch 1 config Phase 3：新增 Rust/native `ConfigPatchBridgeResult` 和 `apply_validated_patch_result()`，消费 TS patch/validate 结果，成功时更新 snapshot 并落盘，失败时保留内存与文件，为后续受控 `config.patch` RPC/host action 铺路。 |
| 2026-06-11 | 继续 Batch 1 config Phase 3：扩展 TS `configPatch` side-effect planning，按 updated fields 规划 provider runtime、embedding、MCP、SSRF、channel、knowledge 热更新，以及 workspace reload/gateway restart warnings。 |
| 2026-06-11 | 继续 Batch 1 config Phase 3：新增 Rust worker RPC `config.apply_patch_result`，要求 `config.write` capability，消费 TS patch result，更新 native in-memory config snapshot 并返回脱敏 config、updatedFields 与 sideEffects；默认 agent worker 仍不授予 `config.write`。 |
| 2026-06-11 | 继续 Batch 1 config Phase 3：为 Rust `WorkerRpcRouter` 增加可选 `ConfigStore` 持久化路径，`config.apply_patch_result` 在有 store 时先校验 `config.write` 再落盘，并同步后续 `config.get` snapshot；同时新增 TS `NativeConfigBridge.applyPatch()`，用 TS schema/patch validate 生成 patch result 后交给 native。 |
| 2026-06-11 | 完成 Batch 1 config Phase 3 的 desktop settings 保存切换：新增前端 `applyNativeConfigPatch()` / `saveDesktopSettingsConfig()`，保存时优先通过 Tauri `apply_config_patch_result` 写入 Rust `ConfigStore`，native 不可用时保留 Python gateway `PATCH /api/config` fallback。 |
| 2026-06-11 | 推进 Batch 1 agent loop 并进入 verify：TS worker 恢复路径 `runResumedSpec()` 登记 active run 并传递 cancel state，使 `agent.submit_form` / `agent.resume_approval` 恢复后的长请求也能被 `agent.cancel` 命中；补充 resumed form cancellation 回归测试。 |
| 2026-06-11 | 启动 Batch 2 tool runtime：收紧 `toolPolicy`，要求 `requiresApproval` 工具同时具备 `approval.request` capability，并让 `request_approval` / approval-gated 工具像 `request_form` 一样只在 `agent_ui` 通道注册。 |
| 2026-06-11 | 启动 Batch 2 session/turn lifecycle：新增 `persistedMessages` 持久化清洗边界，让 `agent.run_input` 写回 session 时剥离 runtime context，并过滤 system prompt 与无工具调用的空 assistant 消息。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：新增 Rust `session.persist_turn` RPC 和 TS `NativeSessionBridge.persistTurn()`，AgentWorker 在 completed turn 持久化时优先使用 persist-turn，返回 saved/cleared/omitted side-effect metadata 起点。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：将 persist-turn 结果接入 `agent.done.payload.lifecycle`，报告 sessionId/runId/stopReason、checkpointCleared、persisted、savedMessageCount、awaitingInput 与 omittedSideEffects。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：补齐 `persistedSessionMessages()` 的 Python session-key dedupe 与 tool result truncate，并让 AgentWorker session persistence 按 `toolResultBudget` 应用清洗规则。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：补齐 Rust `session.get_history` 的 Python-style history projection，覆盖 last-consolidated/limit 后的 user 起点、tool legal boundary、progress/task event 过滤，并增加真实 TS worker 连续两轮读取上一轮 persisted history 的集成测试。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：新增 TS `runtime/checkpoint.ts`，把 AgentRunner checkpoint 转成 versioned session checkpoint payload，并保留 camelCase/snake_case aliases 供 native/Python resume 路径消费；AgentWorker checkpoint 持久化改为使用该 helper。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：新增 TS `runtime/turnLifecycle.ts`，把 completed-turn persistence、清洗后的 append fallback 与 lifecycle metadata 从 AgentWorker 抽出，并覆盖 persist-turn、fallback append、awaiting-input checkpoint 保留路径。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：把 runner checkpoint write 和 terminal clear 委托给 `TurnLifecycle.writeCheckpoint()` / `clearCheckpoint()`，让 AgentWorker 不再直接构造 session checkpoint payload；后续继续收敛 restore/resume materialization。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：新增 `TurnLifecycle.restoreCheckpoint()`，把 interrupted checkpoint materialization、pending-tool interrupted transcript、awaiting-input keep-checkpoint 规则从 AgentWorker 收敛到 lifecycle；后续继续抽取 approval/form resume projection。 |
| 2026-06-11 | 继续 Batch 2 session/turn lifecycle：在 `runtime/checkpoint.ts` 增加 approval/form resume projection helpers，覆盖 approved operation extraction、approved result replacement、denied approval 与 submitted form spec projection，并让 AgentWorker 复用这些 helper。 |
| 2026-06-11 | 启动 Batch 2 context/session 组合边界：新增 `runtime/runInputContext.ts`，把 ContextBridge load result 经 ContextBuilder 投影为 AgentRunSpec、context metadata 与 TurnLifecycle 持久化所需的 `_contextSessionAppendMessages`。 |
| 2026-06-12 | 继续 Batch 2 context/session 组合边界：让 `agent.run_input` 的 context metadata 传入 `TurnLifecycle.finalizeTurn()`，使 `session.persist_turn` 能收到 history/bootstrap/bridge metadata，而不仅返回给调用方。 |
| 2026-06-12 | Closed the native persist-turn boundary for run input context metadata: Rust `session.persist_turn` now accepts snake_case/camelCase metadata, stores it on the persisted session turn, and clears stale metadata when absent. |
| 2026-06-12 | Started TS Memory Notes recall in `agent.run_input`: `NativeContextBridge` now reads active notes through native `memory.search`, `ContextBuilder` injects Python-style `[MEMORY RECALL]` system context, and context metadata carries `_memory_references`. |
| 2026-06-12 | Extended TS/native Memory Notes operations: Rust worker RPC now supports `memory.trace`, `memory.reject`, and `memory.supersede`, and TS native tools expose `trace_memory_note`, `reject_memory_note`, and `supersede_memory_note`. |
| 2026-06-12 | Started Security/Approval Phase 1: added TS approval classification and fingerprint helpers aligned with Python approval behavior, including MCP read-only approval, request_form exemption, safe exec detection, and session/once fingerprint rules. |
| 2026-06-12 | Started Security/Approval Phase 2: Rust native `approval.request` now keeps an in-memory pending approval record with operation, classification, summary, fingerprint, and session fingerprint; `approval.resolve` consumes that record and rejects missing pending approvals. |
| 2026-06-12 | Started Security/Approval Phase 3/4 TS path: `NativeApprovalBridge` now supports `requestApproval`, `ApprovalRuntime` gates `ToolRuntime.execute()` before risky side effects, `request_approval` forwards classification/fingerprint fields, and AgentRunner's existing approval path now emits the same contract. |
| 2026-06-12 | Continued Security/Approval Phase 5: Rust `approval.request` now honors approved once/session fingerprints, consumes once approvals, limits session approval reuse to the same session, and TS `ApprovalRuntime` treats native `decision: "allow"` as permission to execute the original tool. |
| 2026-06-12 | Started Batch 3 Provider Runtime hardening: `config.apply_patch_result` now refreshes the native provider secret resolver snapshot after successful config patches, so `provider.resolve_secret` observes newly saved provider API keys while public config reads remain redacted. |
| 2026-06-12 | Continued Batch 3 Provider Runtime request parity: `buildOpenAIChatRequest()` now honors `supportsPromptCaching` by adding Python-style ephemeral `cache_control` markers to the system message, recent context message, and final tool definition. |
| 2026-06-12 | Continued Batch 3 Provider Runtime stream parity: `collectChatCompletionStream()` and `OpenAIProvider.complete()` now support `streamIdleTimeoutMs`, returning a model-visible error when a provider stream stalls while preserving already emitted deltas. |
| 2026-06-12 | Continued Batch 3 Provider Runtime config reload: `worker.provider.reload` now clears the TS worker lazy provider cache so the next run reloads native config and provider secrets while active runs keep their existing provider instance. |
| 2026-06-12 | Continued Batch 3 Provider Runtime model listing contract: `provider.models.list` now resolves provider metadata from native public config plus the narrow secret bridge, returns merged curated/profile/manual model sources, and keeps API keys out of the worker response. |
| 2026-06-12 | Continued Batch 3 Provider Runtime settings contract: `provider.catalog.list`, `provider.runtime.resolve`, and `provider.model.validate` now expose catalog metadata, safe resolved runtime status, and model/provider mismatch validation through the TS worker without exposing provider API keys. |
| 2026-06-12 | Continued Batch 3 Provider Runtime retry observability: `AgentRunner` now forwards `providerRetryMode` to model providers and emits `agent.provider_retry` protocol events from provider retry wait callbacks, including `provider_retry_mode` parsing for direct and run-input requests. |
| 2026-06-12 | Continued Batch 3 Provider Runtime config parity: native `agent.run_input` now reads `agents.defaults.provider_retry_mode` from `config.snapshot_public` and uses it when the caller does not provide an explicit provider retry mode, matching the Python `AgentLoop.from_config()` default flow. |
| 2026-06-12 | Continued Batch 3 Provider Runtime model discovery: `provider.models.list` with `refresh_live` now probes OpenAI-compatible `/models` endpoints through the TS discovery path, includes live model sources, preserves fallback base URL warnings, and keeps provider secrets out of the response. |
| 2026-06-12 | Continued Batch 3 Provider Runtime stream parity: interrupted provider streams now emit a terminal tool-call delta with `status: "error"` for any buffered tool calls before returning the model-visible stream error response. |
| 2026-06-12 | Continued Batch 3 Provider Runtime retry parity: TS retry-after extraction now matches Python body patterns for milliseconds, minutes, and `retry_after` text keys instead of treating every numeric hint as seconds. |
| 2026-06-12 | Continued Batch 3 Provider Runtime retry header parity: TS retry-after extraction now accepts HTTP-date `Retry-After` headers and converts them to positive retry delays like the Python provider. |
| 2026-06-12 | Continued Batch 3 Provider Runtime error parity: OpenAI-compatible stream creation failures now surface nested `response.body` text, matching the Python provider's broader provider-error body extraction. |
| 2026-06-12 | Started Batch 4 Skills Runtime prompt parity: TS now has a testable `SkillsRuntime` for Python-style discovery precedence, frontmatter metadata, requirements, XML summaries, always-skill filtering, and ContextBuilder can inject real active skills/skills summaries instead of only the deferred placeholder. |
| 2026-06-12 | Continued Batch 4 Skills Runtime native bridge: Rust now exposes read-only `skills.list` with workspace-over-builtin precedence, and `NativeContextBridge` loads enabled skills plus PATH/env requirement probes into `agent.run_input` context. |
| 2026-06-12 | Continued Batch 4 Skills Runtime WebUI contract: TS `SkillsRuntime` now projects Python-compatible `/api/skills` list/detail payloads, including enabled/available/always flags, missing requirements, stripped content, raw content, frontmatter metadata, and tinybot/openclaw metadata. |
| 2026-06-12 | Continued Batch 4 Skills Runtime desktop read migration: TS worker now exposes `skills.webui_list` / `skills.webui_detail`, Rust/Tauri exposes `worker_skills_list` / `worker_skills_detail`, and desktop gateway clients prefer native Skills list/detail reads with Python gateway fallback for compatibility. |
| 2026-06-12 | Continued Batch 4 Skills Runtime CRUD migration: TS worker now handles WebUI skill create/update/delete/validate through native workspace RPC, Rust/Tauri exposes matching `worker_skills_*` commands, and desktop gateway clients prefer native Skills write/validate operations with Python gateway fallback. |
| 2026-06-12 | Continued Batch 4 Memory Notes recall: Rust worker RPC now exposes `memory.recall` with bounded native `[MEMORY RECALL]` context, notes, and references, and TS `NativeContextBridge` consumes that native-owned recall payload for `agent.run_input`. |
| 2026-06-12 | Continued Batch 4 Memory Notes evidence capture: Rust worker RPC now exposes `memory.capture_evidence` / `memory.list_evidence` with daily JSONL evidence files and cursor sequencing, and TS `TurnLifecycle` captures clean persisted turn messages after `session.persist_turn`. |
| 2026-06-12 | Started Batch 4 Knowledge/RAG bridge: TS now exposes `query_knowledge` with normalized knowledge result formatting, Rust worker RPC accepts `knowledge.query` and maps the existing sparse native RAG scan into knowledge-style results while keeping `query_rag` available as a compatibility alias. |
| 2026-06-12 | Continued Batch 4 Knowledge/RAG Phase 2: added Rust `WorkerKnowledgeRpc` with `knowledge.read/write`, JSONL document/chunk store, add/list/get/delete document RPCs, sparse parent-chunk query payloads, and TS model-facing add/list/get/delete Knowledge tools with approval-gated writes. |
| 2026-06-12 | Continued Batch 4 Knowledge/RAG sparse retrieval: native Knowledge documents now split markdown headings into readable parent chunks and child retrieval chunks, and sparse `knowledge.query` aggregates child matches back to parent context with matched child snippets. |
| 2026-06-12 | Continued Batch 4 Knowledge/RAG readiness contract: Rust `knowledge.stats` now returns Python-compatible document/chunk/category counts plus retrieval/semantic/graph readiness flags and sparse stage coverage for desktop workbench/API migration. |
| 2026-06-12 | Continued Batch 4 Knowledge/RAG context injection: Rust `knowledge.context` renders bounded `[RELEVANT KNOWLEDGE]` persistent evidence context and TS `NativeContextBridge`/`ContextBuilder` consume native knowledge references for `agent.run_input`. |
| 2026-06-12 | Started Batch 4 MCP Runtime Phase 1: added TS MCP config/schema pure modules for transport auto-detection, allowlist aliases, wrapped-name sanitization, and Python-style nullable schema normalization, then wired `parseTinybotConfig()` through the same MCP config contract. |
| 2026-06-12 | Continued Batch 4 MCP Runtime Phase 2: added `mcpToolWrapper` over a fake session, including wrapped `mcp_<server>_<tool>` names, normalized schemas, model-visible MCP content formatting, timeout/cancel/failure text, and high-risk MCP approval metadata. |
| 2026-06-12 | Continued Batch 4 MCP Runtime Phase 3: added fake-client `McpRuntimeManager` with allowlist filtering, raw/wrapped allowlist matching, per-server diagnostics, failure isolation, and close-time unregister/cleanup of registered `mcp_` tools. |
| 2026-06-12 | Continued Batch 4 MCP Runtime Phase 3 hardening: `McpRuntimeManager` now reports wrapped-name collisions without overwriting existing tools and reconnects by replacing prior MCP registrations while preserving non-MCP tools. |
| 2026-06-12 | Continued Batch 4 MCP Runtime Phase 3 integration: Rust worker RPC now exposes `mcp.list_tools` for configured fixture tools, and TS `NativeMcpBridge` can discover/register gated dynamic MCP wrappers before agent runs while forwarding execution context to `mcp.call_tool`. |
| 2026-06-12 | Continued Batch 4 MCP Runtime Phase 3 entrypoint wiring: the real TS worker now enables native MCP discovery while the reusable server factory keeps discovery opt-in for tests/embeds, and discovery failures are logged without blocking normal agent runs. |
| 2026-06-12 | Started Batch 5 Command Runtime Phase 1: added pure TS `CommandRouter` semantics for priority/exact/prefix/interceptor dispatch and wired AgentWorker to answer backend `/help` before invoking the model provider. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 1: registered priority `/stop` and `/status` in the TS command router, with AgentWorker-backed session cancellation and active-run status snapshots before provider execution. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 1: registered priority `/restart` as a TS command contract that requests restart through an injected native bridge and returns Python-compatible `Restarting...` text without calling the provider. |

## Next Checklist

- [x] 复核 `ts_native_core.md` 对应实现和 `rust-native-core-worker-migration` 完成状态。
- [x] 为 Batch 1 拆出第一个可实现任务：shared support runtime 的最小公共 helper/API。
- [x] 继续补齐 shared support Phase 1：template renderer、evaluator parser。
- [x] 迁移 shared support Phase 1 的 status/message helpers。
- [x] 确认 config canonical schema/selectors 的第一阶段边界：先做 read-only schema/defaults/selectors，不替换 load/save/patch。
- [x] 继续 config Phase 1：补齐 config masking 与 worker snapshot 防御性脱敏消费点。
- [x] 继续 config Phase 1：补齐 Python default fixture parity。
- [x] 继续 config Phase 1：补齐 provider runtime 聚合 selector 并接入 provider runtime。
- [x] 继续 config Phase 1：补齐 public snapshot/path read 复用点。
- [x] 继续 config Phase 1：复核 Phase 1 验收项并进入 config Phase 2。
- [x] 继续 config Phase 2：推进 path resolver 起点。
- [x] 继续 config Phase 2：推进 ConfigStore load/save/diagnostics 的 TS 纯函数起点。
- [x] 继续 config Phase 2：推进 Rust/native ConfigStore 文件 I/O 起点。
- [x] 继续 config Phase 3：推进 TS config patch/validate 纯函数起点。
- [x] 继续 config Phase 3：推进 Rust/native ConfigStore 与 TS `config.patch` 结果桥接。
- [x] 继续 config Phase 3：推进 config patch side-effect planning 起点。
- [x] 继续 config Phase 3：推进受控 `config.apply_patch_result` RPC 起点。
- [x] 继续 config Phase 3：推进 host action 持久化到 ConfigStore / 真实 `config.patch` patch 输入桥接起点。
- [x] 继续 config Phase 3：将 desktop settings 保存路径从 Python gateway `PATCH /api/config` 切到 native host action，并保留 Python fallback。
- [x] 在 Batch 1 shared support Phase 1 完成后更新 `Current Focus` 和对应状态。
