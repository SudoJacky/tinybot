# TS Runtime Migration Progress

## 2026-06-14 Progress Note

- Continued API Runtime Knowledge validation parity: TS-native direct add-document now rejects whitespace-only content with Python-compatible 400 invalid-request envelopes before provider/native storage dispatch.

- Continued API Runtime Knowledge async-add parity: TS-native `POST /v1/knowledge/documents` now honors `async_index` from query params or a true JSON body flag and returns Python-compatible `202` completed job envelopes for deferred indexing.

- Continued API Runtime Knowledge provider-error parity: TS-native Knowledge provider failures for list/query/stats/graph/GraphRAG/rebuild/document/job routes now return Python-compatible 500 server-error envelopes instead of worker protocol errors.

- Continued API Runtime Knowledge error-envelope parity: TS-native Knowledge store-unavailable, malformed-body, missing-field, upload validation, document not-found, and job not-found errors now use Python-compatible invalid-request envelopes.

- Continued API Runtime Knowledge validation parity: TS-native Knowledge graph, GraphRAG, and rebuild-index validation failures now return Python-compatible 400 invalid-request error envelopes instead of simple route errors.

- Continued Command Runtime bridge durability: TS-native `/status`, `/restart`, and `/approvals` now catch native bridge failures and return command-specific text results instead of leaking bridge/RPC exceptions through the agent run.

- Continued Command Runtime Phase 3 Dream command durability: TS-native `/dream-log` and `/dream-restore` now return command-specific text failures when the Dream bridge raises, instead of leaking bridge/RPC exceptions through the agent run.

- Continued Command Runtime parity: TS-native slash command results now preserve inbound message metadata like Python while keeping command-owned `command` and `render_as: text` fields authoritative over bridge metadata.

- Continued Command Runtime Phase 3 Dream command parity: TS-native `/dream` now catches Dream bridge failures and returns Python-compatible `Dream failed: ...` command output instead of leaking the provider/runtime exception.

- Continued Command Runtime Phase 3 Dream provider parity: TS-native `/dream` provider extraction now coerces Memory Operation note type and scope like Python before applying provider notes through the native bridge.

- Continued Command Runtime Phase 3 Dream provider parity: TS-native `/dream` provider extraction now fills Python-compatible default Memory Operation confidence and `dream` tags before applying provider notes through the native bridge.

- Continued Command Runtime Phase 3 Dream provider parity: TS-native `/dream` provider extraction now accepts a single JSON Memory Operation object like Python and ignores unsupported operation actions instead of saving them as default notes.

- Continued Cowork observability durability parity: TS-native AgentRunner now appends Python-compatible trace span event-log records for completed and failed agent spans, preserving replayable `trace.span_recorded` entries alongside snapshot updates.

- Continued Cowork observability durability parity: TS-native AgentRunner tool and browser observations now append Python-compatible observation event-log records, preserving replayable `tool_observation.recorded` and `browser_observation.recorded` entries alongside snapshot updates.

- Continued Cowork observability durability parity: TS-native AgentRunner completion and failure paths now append Python-compatible `agent_step.finished` observation event-log records after persisting the final agent step snapshot.

- Continued Cowork observability parity: TS-native AgentRunner steps now finish with Python-compatible structured summaries, including purpose, bounded input/outcome text, next-effect hints, full-detail metadata, and failure outcomes instead of plain summary strings.

- Continued Cowork observability parity: TS-native AgentRunner tool observations now sanitize parameter summaries like Python, redacting secret/token/password/API key fields and compacting list/object parameters instead of persisting raw tool-call arguments.

- Continued Cowork agent-runtime failure parity: TS-native `CoworkAgentRuntime` now catches AgentRunner/provider exceptions like Python, persists failed agent/task state, records failed step/trace observability, and returns a failed agent result instead of leaking the runner exception.

- Continued Cowork lead-synthesis trace parity: TS-native scheduler lead synthesis now runs the lead agent with Python-compatible standalone agent trace linkage instead of inheriting the scheduler run/round ids.

- Continued Cowork scheduler trace parity: TS-native swarm scheduler round trace spans now include Python-compatible `runtime_state.swarm_metrics` alongside selected agents and candidate scores.

- Continued Cowork scheduler convergence parity: TS-native `CoworkScheduler` now mirrors Python by checking the next ready agents when convergence is reached and reporting `idle` if self-activation limits filter them all out, instead of always stopping as `convergence`.

- Continued Cowork scheduler round execution parity: TS-native `CoworkScheduler` now starts all agents selected for the same round concurrently like Python's `asyncio.gather`, preserving team/swarm parallel-width semantics instead of serializing same-round agent work.

- Continued Cowork agent readiness parity: TS-native ready-agent selection now refreshes mailbox expiry and stale-blocker escalation before choosing active agents, matching Python's scheduler pre-selection mailbox maintenance for team and swarm sessions.

- Continued Cowork agent readiness parity: TS-native team ready-agent selection now treats delivered/read `requires_reply` mailbox records as pending direct work and applies Python-compatible mailbox pressure to readiness scores even when the agent inbox is empty.

- Continued Cowork agent readiness parity: TS-native team ready-agent selection now mirrors Python readiness scoring before applying scheduler limits, including direct/shared work, waiting/current-task state, and team/generator-verifier profile boosts.

- Continued Cowork scheduler budget-usage parity: TS-native `CoworkScheduler` now mirrors Python by recording round and lead-synthesis agent-call usage during the run, so later scheduler decisions see updated session budget remaining instead of stale initial limits.

- Continued Cowork scheduler profile-limit parity: TS-native `CoworkScheduler` now mirrors Python's one-agent effective round limit for orchestrator, generator-verifier, and peer-handoff profiles while preserving wider scheduling for swarm/team modes.

- Continued Cowork scheduler completion-output parity: TS-native `CoworkScheduler` now mirrors Python by including `Session completed.` when an agent round completes the session, and final run metrics refresh Python-compatible message/task/artifact counts.

- Continued Cowork scheduler assessment parity: TS-native `CoworkScheduler` now refreshes Python-style completion decisions after agent rounds and lead synthesis, stopping at `ready_to_finish` when completed task output is sufficient, and records elapsed `wall_time_seconds` in budget usage at run finish.

- Continued Cowork scheduler self-activation parity: TS-native `CoworkScheduler` now mirrors Python's repeated self-activation guard by skipping agents after three consecutive self-selected runs and recording `scheduler.self_activation_limited`.

- Continued Cowork scheduler parity: TS-native `CoworkScheduler` now mirrors Python by stopping with `ready_to_finish` after a round when the session completion decision is ready and no active agents remain, instead of falling through to `max_rounds`.

- Continued Cowork internal task mutation parity: TS-native `cowork_internal add_task` now leaves omitted/invalid assignees in the shared task pool like Python, and `assign_task` now rejects terminal task statuses while using Python-shaped success responses, events, and trace spans without emitting extra messages.

- Continued Cowork internal lifecycle metadata parity: TS-native `cowork_internal` now mirrors Python fallbacks for retire reasons, spawned-agent source envelope ids, and generated mailbox draft ids from `_tool_call_id`.

- Continued Cowork internal reply lifecycle parity: TS-native `cowork_internal send_message` now infers reply context for responses to pending mailbox requests like Python, reusing the original thread/correlation and marking the source envelope as replied.

- Continued Cowork internal mailbox parity: TS-native `cowork_internal send_message` now delivers through the migrated `CoworkMailbox`, creating Python-style mailbox records, queued/delivered events, trace spans, correlation/lineage ids, wake decisions, and reply metadata instead of bypassing the mailbox with a raw message write.

- Continued Cowork internal tool schema parity: TS-native `cowork_internal` now exposes Python-compatible mailbox envelope fields and agent action aliases such as `wake_recipients`, `priority`, `deadline_round`, correlation/reply ids, `expected_output_schema`, `blocking_task_id`, `escalate_after_rounds`, `agent_id`, and `reason`.

- Continued Cowork internal-tool message parity: TS-native `cowork_internal send_message` preserves Python-style envelope metadata through mailbox delivery, including reply-question kind, topic/event type, request type, and clamped priority.

- Continued Cowork internal-tool parity: TS-native `cowork_internal retire_agent` now honors Python's `agent_id` target alias before falling back to the sender, and `spawn_agent` uses `content` as the delegated goal when `goal` is omitted.

- Continued Cowork tool start traceability parity: TS-native `cowork start` now saves a normalized generated blueprint for goal/planner starts like Python, keeping later blueprint export and diagnostics tied to the actual created agents and tasks.

- Continued Cowork tool start parity: TS-native `cowork start` now mirrors Python by folding planner-generated tasks into a single `lead_start` delegation task for non-swarm workflows, while preserving raw planner tasks for swarm sessions.

- Continued Cowork model-facing tool schema parity: TS-native `cowork` now rejects `workflow_mode` values outside Python's declared workflow enum while preserving the legacy `hybrid` alias, keeping invalid model tool calls from reaching the TS service layer.

- Continued Cowork model-facing tool parity: TS-native `cowork` tool parameters now expose Python-compatible `topic` / `event_type` fields and enforce bounded integer scheduler limits for `max_rounds`, `max_agents`, and `max_agent_calls`, preserving Python schema casting/validation before scheduler execution.

- Continued WebUI/API Knowledge GraphRAG parity: TS-native `/v1/knowledge/graphrag` now uses the configured `knowledge.graphragCommunityLevel` default when the request omits `level`, matching Python's store-backed GraphRAG default resolution while preserving explicit query overrides.

- Continued Command Runtime router parity: TS prefix slash commands now require an argument separator like Python, so bare `/approve` / `/deny` no longer get consumed by prefix handlers before fallback/model handling.

- Continued Command Runtime router parity: TS command interceptors now mirror Python by preserving multiple fallback handlers and trying them in registration order instead of overwriting earlier interceptors.

- Continued Command Runtime router parity: TS exact slash commands now require whole-line matches like Python, so `/new extra` and other parameterized exact commands no longer bypass fallback/model handling.

- Continued Task/Cron background runtime parity: TS-native `cron` now mirrors Python truthiness for `deliver`, preserving falsey structured inputs when scheduling silent agent-turn jobs.

- Continued Task/Cron background runtime parity: TS-native `task` boolean arguments now mirror Python truthiness for `auto_execute`, `parallel`, and `subtask_parallel_safe`, preserving compatibility for non-boolean JSON/RPC inputs.

- Continued Task/Cron background runtime parity: TS-native cron job creation now resolves the default timezone from native `agents.defaults.timezone` before interpreting cron expressions and naive `at` schedules, matching the configured-timezone behavior used by the Python runtime.

- Continued Task/Cron background runtime parity: TS-native `cron action=list` now formats `Last run`, `Next run`, and one-shot `at` timestamps in the job/default timezone with Python-style ISO offsets instead of UTC-only strings.

- Continued Task/Cron background runtime parity: TS-native `spawn` now exposes a model-facing background subagent tool over `SubagentRuntime`, registered in the real worker with approval/capability gating and an isolated AgentRunner tool registry.

- Continued Task/Cron background runtime parity: TS-native `task action=resume` completed-plan guidance now renders the actual `plan_id` in the suggested `task action=summary` command, avoiding unusable literal placeholders.

- Continued Cowork scheduler budget parity: TS-native budget state snapshots now preserve Python-compatible `remaining.parallel_width` in service budget updates and scheduler budget-stop diagnostics.

- Continued API Runtime OpenAI-compatible parity: TS-native chat completion session locks now use Python-style stringification for truthy non-string `session_id` values, so distinct object/list ids do not collapse into JavaScript `[object Object]` keys.

- Continued API Runtime OpenAI-compatible parity: TS-native chat completion session selection now ignores camel-case `sessionId` like Python and only uses truthy `session_id` for non-default API session locks.

- Continued API Runtime OpenAI-compatible parity: TS-native chat completion request validation now mirrors Python's stream-rejection ordering after the single-message shape check and before user-role validation.

- Continued API Runtime OpenAI-compatible parity: TS-native multimodal chat content extraction now preserves Python-compatible empty text segments in content arrays, keeping separator behavior aligned when text parts omit `text`.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now mirrors Python shared-memory merging by ignoring non-list non-string structured memory bucket fields while preserving string/list values and structured answers.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now recognizes Python-compatible Chinese delivery-goal markers for artifact gating, so Chinese file/code/document goals do not auto-complete without confirmed artifact paths.

- Continued Cowork mailbox parity: TS-native mailbox completion decisions now include Python-compatible failed-task priority inside nested `goal_review`, so failed task review remains the primary blocker even when completed tasks also report open questions.

- Continued Cowork mailbox parity: TS-native mailbox completion decisions now order nested `goal_review` blockers like Python, reporting unresolved review gates before completed-task open questions when both are present.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now applies Python-compatible completion-review blockers for artifact-oriented goals, unmerged fanout work, and disagreement signals, and refreshes final drafts from completed task results before deciding whether a session can finish.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now applies Python-compatible goal review for incomplete review-required task outputs, keeping sessions active until completed review gates pass or are waived.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now applies Python-compatible goal review for completed task results with open questions and skipped-only sessions, keeping the session active with a `review_goal_completion` decision instead of auto-completing.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now falls back from blank structured `output_dir` to string `workspace_dir` when merging task artifacts, matching Python's `output_dir or workspace_dir` behavior.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now ignores non-list non-string top-level artifact fields when merging structured task results, matching Python artifact extraction.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now ignores non-string structured `output_dir` / `workspace_dir` values when merging task artifacts, preserving Python's workspace directory update boundary.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now treats missing or blank structured `confidence` values as unset like Python, instead of coercing them to zero.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now leaves plain-text task completion confidence unset like Python instead of coercing missing structured confidence to zero.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now keeps plain-text task completion `result_data` empty like Python, while preserving structured JSON result extraction for confidence/artifact handling.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now preserves Python-compatible `skipped` task completion status, including task events, trace spans, and final session completion handling.

- Continued Cowork runtime parity: TS-native `cowork_internal complete_task` now applies Python-compatible non-swarm completion state when the final task finishes with no unresolved reply requests, marking the session completed, agents done, and recording the completion decision.

- Continued Task/Cron background runtime parity: TS-native manual subtask result updates now publish Python-compatible progress events and persist owning-session task progress cards after completed, failed, or skipped updates.

- Continued Task/Cron background runtime parity: TS-native manual failed subtask updates now pause the owning plan with Python-compatible exhausted-retry context when retry counts have already reached the configured limit.

- Continued Task/Cron background runtime parity: TS-native manual subtask result updates now complete the owning plan when all subtasks are completed or skipped, matching Python TaskManager's update-result completion transition.

- Continued Task/Cron background runtime parity: TS-native subtask spawn prompts now build Python-compatible completed-task context, separating dependency results from bounded "other completed steps" for chained subagent execution.

- Continued Task/Cron background runtime parity: TS-native task runtime now truncates stored subtask results with Python's 1500-character context cap before summaries and chained subagent context reuse.

- Continued Task/Cron background runtime parity: TS-native task control now mirrors Python pause/cancel semantics, resetting in-progress subtasks on pause and marking unfinished subtasks skipped with failed/cancelled plan state on cancel.

- Continued Task/Cron background runtime parity: TS-native subagent runtime now uses Python-compatible default concurrency of five background subagents before queueing, preserving Task auto-execution throughput when no explicit native limit is configured.

- Continued Task/Cron background runtime parity: TS-native cron job creation now derives channel/chat delivery context from active desktop/WebUI session keys, so scheduled agent-turn deliveries target the original session instead of storing a synthetic native channel with the full session key as chat id.

- Continued Task/Cron background runtime parity: TS-native task completion now detects blocked plans after a completed/skipped subtask leaves only non-executable pending work, pausing the plan, recording a Python-compatible blocked-dependency error, and notifying the owning session instead of leaving the chain stuck in `executing`.

- Continued Task/Cron background runtime parity: TS-native task completion callbacks now notify the owning session when retry exhaustion pauses a plan, matching Python's paused-plan announce path so the main agent can report failure context and completed results instead of silently stopping after the failed subagent.

- Continued Task/Cron background runtime parity: TS-native task completion callbacks now apply Python-style retry handling for failed subtasks, requeueing failures until `maxRetries` is exhausted and pausing the plan with an error once retries are spent instead of leaving the task chain stuck in `executing`.

- Continued Task/Cron background runtime parity: TS-native task plan creation now preserves the active desktop/WebUI session key and derives channel/chat context from it, so task progress cards, background subagents, and completion notifications target the original session instead of a synthetic `native:*` session.

- Continued WebUI/API route diagnostics parity: TS `webui.route_specs` now returns `route_diagnostics` entries with `owner: "ts-worker"` and stable `route_group` values while preserving the legacy `routes` shape, giving the desktop/Rust gateway the route-owner visibility called out by the migration docs before Python fallback can be fully retired.

- Continued Context Builder/Skills prompt parity: TS system prompts now omit the old `Active Skills` deferred placeholder by default when no skills context is available, matching Python's empty-skills behavior while preserving explicit opt-in coverage for the placeholder.

- Continued Task/Cron background runtime parity: TS-native `task add_subtask` now returns Python-compatible dependency warnings after DAG validation, so newly introduced missing/cyclic dependency issues are visible immediately in the tool response.

- Continued WebUI transport Phase 5 Skills update parity: native TS skill updates now use Python's stricter frontmatter boundary matching, so malformed or newline-less closing frontmatter markers fall back to legacy-content wrapping instead of being partially consumed.

- Continued WebUI transport Phase 5 Skills update parity: native TS skill updates now mirror Python fallback frontmatter assembly for legacy skills without frontmatter, coercing explicit non-string descriptions and truthy `always` values instead of dropping them.

- Continued WebUI transport Phase 5 Skills delete parity: native TS skill deletion now wraps workspace delete failures as Python-compatible 500 `failed to delete skill: ...` responses while preserving missing and builtin skill guards.

- Continued WebUI transport Phase 5 Skills validation parity: native TS skill validation now checks the workspace skill directory before reading `SKILL.md`, returning Python-compatible 404 `skill not found` for missing skill directories while preserving invalid `SKILL.md not found` results for existing directories.

- Continued WebUI transport Phase 5 Skills update parity: native TS skill updates now reject non-string `content` payloads before writing, matching Python's update-route string concatenation failure boundary instead of stringifying invalid bodies.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now rejects truthy non-string `content` values through the same create-error and best-effort cleanup boundary Python reaches during `SKILL.md` assembly, instead of silently writing TODO body content.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now mirrors Python create-route coercion for truthy non-string `name`, explicit `description`, and truthy `always` values while keeping skill body content string-bounded.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now only treats existing workspace skills as duplicates, allowing workspace skills to override builtin skills like Python's workspace-directory existence check.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now wraps skill file write failures in Python-compatible create errors and best-effort cleanup, so partial parent directories do not survive failed `SKILL.md` writes.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now cleans up partially-created workspace skill directories when resource directory creation fails, matching Python's best-effort rollback before returning a create error.

- Continued WebUI transport Phase 5 Skills create parity: native TS skill creation now creates requested `scripts/`, `references/`, and `assets/` resource directories through a dedicated `workspace.create_dir` bridge, matching Python's create route while ignoring unsupported resource names.

- Continued WebUI transport Phase 5 Skills validation parity: native TS skill validation now allows root-level symlink entries like Python WebUI validation while continuing to reject ordinary unexpected root files or directories outside `SKILL.md`, `scripts/`, `references/`, and `assets/`.

- Continued WebUI transport Phase 5 Skills route parity: native TS WebUI skill routes now return Python-compatible JSON status responses for invalid create/update bodies, missing skill detail, duplicate skill creation, and protected/missing delete paths instead of leaking worker-level protocol failures.

- Continued Command Runtime approval parity: TS `/approve` and `/deny` now schedule resumed approval checkpoint execution after resolving a pending approval, matching Python's command path that retries the paused operation instead of only updating approval state.

- Continued Command Runtime router parity: TS slash command routing now matches Python priority command semantics by requiring exact full-line matches for `/stop`, `/restart`, and `/status`, and approval scope parsing now accepts `once` / `session` case-insensitively like Python.

- Continued Command Runtime restart parity: desktop TS agent worker startup now installs a native restart handler that asynchronously restarts the stdio WorkerManager with a fresh router after `runtime.restart`, preserving full-duplex worker RPC after `/restart`.

- Continued Command Runtime restart parity: native `runtime.restart` host RPC now invokes an injected Rust restart callback with normalized run/session context before acknowledging, giving the app layer a controlled restart hook instead of a no-op acknowledgement.

- Continued Command Runtime restart parity: the default TS worker server now wires `/restart` through a native `runtime.restart` host RPC, and the Rust worker RPC router acknowledges the controlled restart request instead of leaving restart unavailable outside manually injected tests.

- Continued Task/Cron background runtime parity: TS-native `cron.run_due` now routes the protected Dream system cron job through the existing Dream bridge instead of skipping all `system_event` jobs, while preserving skipped diagnostics for unknown system events.

- Continued Task/Cron background runtime parity: TS-native `cron` add now rejects conflicting schedule sources instead of silently prioritizing one, matching the migration contract that exactly one of `every_seconds`, `cron_expr`, or `at` is required.

- Continued Task/Cron background runtime parity: native Cron bridge normalization now preserves Python-compatible `run_history` / `runHistory` records instead of dropping job execution history from listed jobs.

- Continued Task/Cron background runtime parity: TS-native `cron` one-shot `at` schedules now interpret naive ISO datetimes in the configured default timezone instead of the worker process timezone, matching Python CronTool behavior.

- Continued Task/Cron background runtime parity: TS-native `cron` add now mirrors Python's session-context guard, rejecting schedule creation when no delivery session context is available instead of silently targeting the worker run id.

- Continued Task/Cron background runtime parity: TS-native `cron` now blocks nested job creation from cron-triggered sessions and formats protected system jobs, including the Dream system job removal explanation, like the Python CronTool.

- Continued Task/Cron background runtime parity: TS-native task resume no longer depends on list-plan projections before validating DAG state, and native task-subagent coverage now verifies resumed subtasks run through the isolated AgentRunner tool registry to completion.

- Continued Knowledge/RAG tool-output traceability parity: TS-native `query_knowledge` formatting now preserves Python-compatible source snippets, claims, relation evidence, conflict metadata, and derived projection sections after retrieved content while keeping evidence-first ordering.

- Continued API Runtime OpenAI-compatible parity: TS-native `/v1/chat/completions` now retries an empty final agent response once at the API facade boundary with the original user content before returning the empty-response fallback, matching Python `handle_chat_completions`.

- Continued API Runtime OpenAI-compatible parity: TS-native `/v1/chat/completions` now mirrors Python truthiness for `session_id`, so truthy non-string API session ids map to distinct `api:<value>` locks instead of falling back to `api:default`.

- Continued API Runtime OpenAI-compatible parity: TS-native `/v1/chat/completions` now mirrors Python `body.get("stream", False)` truthiness, rejecting truthy non-boolean stream requests with the same OpenAI-shaped 400 before agent execution.

- Continued API Runtime OpenAI-compatible parity: TS-native `/v1/chat/completions` now treats truthy non-string `model` request values like Python's `body.get("model")` guard, returning the configured-model 400 instead of falling through to agent execution.

- Continued WebUI transport Batch 6 Cowork event parity: the native root-WebUI WebSocket shim now subscribes to TS worker Cowork update/state/stream events and forwards them as legacy WebUI frames, while TS-native Cowork session creation emits Python-compatible update/state worker events for websocket-origin sessions.

- Continued WebUI transport Batch 6 Cowork route parity: TS worker WebUI route specs now expose `/api/cowork/*` wildcard routes and `webui.handle_request` delegates those requests through the existing native Cowork route dispatcher.

- Continued WebUI transport Batch 6 upload fallback parity: desktop session temporary uploads now keep extractor-dependent formats such as PDF on the HTTP/Python gateway path instead of sending raw `File.text()` payloads to the native TS route, while plain text/Markdown uploads still prefer native.

- Continued Command Runtime `/new` cleanup parity: TS backend `/new` now clears native session temporary knowledge through the existing `knowledge.session_clear` bridge after clearing the session, and returns `temporary_files_cleared` command metadata when cleanup runs.

- Continued Command Runtime status parity: TS backend `/status` now reuses the Python-compatible status formatter when recent run usage/context data is available, so native slash status reports model, token usage, context window, session message count, and uptime instead of only active-run counts.

- Continued Channel Bus Phase 5 foundation: `AgentWorker` and the stdio worker server now accept an injected native `ChannelManager` and expose `channel.start`, `channel.status`, and `channel.stop` RPCs for TS-managed channel lifecycle control.

- Continued Channel Bus Phase 5 foundation: Rust/Tauri and the desktop native transport facade now expose TS worker channel lifecycle commands, allowing native hosts to start, inspect, and stop TS-managed channel adapters without Python bridge control.

- Continued Channel Bus Phase 5 foundation: the default TS agent worker server now constructs an internal `MessageBus` and `ChannelManager`, so native lifecycle RPCs work in normal worker runs even when no external native channel connectors are injected yet.

- Continued Channel Bus Phase 5 foundation: `channel.dispatch_inbound` now republishes agent replies onto the worker's shared channel bus while preserving Python bridge response payloads, allowing the TS `ChannelManager` dispatcher to deliver replies for native-managed channels.

- Continued Channel Bus Phase 5 foundation: desktop bootstrap now starts the TS-managed native channel runtime after the gateway is ready, so the shared channel bus dispatcher is active during normal native desktop sessions while startup failures remain non-blocking.

- Continued Channel Bus Phase 5 foundation: the default stdio worker channel lifecycle can now assemble native text adapters from canonical channel config when the host provides connector implementations, while keeping the empty-manager path for hosts that still rely on the Python bridge.

- Continued Channel Bus Phase 5 foundation: added an explicit TS host-RPC connector bridge for native text channel adapters, mapping start/stop/send text/send delta/send usage onto stable `channel.connector.*` worker-host methods without changing the default Python bridge fallback path.

- Continued Channel Bus Phase 5 foundation: Rust worker-host RPC now recognizes `channel.connector.start/stop/send_text/send_delta/send_usage` behind a dedicated `channel.connector` capability and returns an explicit unavailable bridge result until real platform connectors are installed.

- Continued Channel Bus Phase 5 foundation: TS host-RPC channel connectors now treat `handled: false` host responses as connector failures, so unavailable Rust/native connectors surface as `ChannelManager` startup or delivery diagnostics instead of marking channels as successfully running.

- Continued Channel Bus Phase 5 foundation: native text channel adapters can now be instantiated from canonical enabled channel config plus host-provided connector registry, skipping channels without native connectors so Python bridge fallback can remain explicit during migration.

- Continued Channel Bus Phase 5 foundation: added a reusable TS `NativeTextChannel` adapter boundary for native platform connectors, sharing `BaseChannel` allow-list/inbound normalization while forwarding outbound text, stream delta, usage, and lifecycle calls without the Python bridge.

- Continued Heartbeat runtime Phase 4: native desktop now listens for TS worker `heartbeat.delivery` frontend events and projects approved external heartbeat notifications into the target chat as assistant messages without requiring an active agent run.

- Continued Heartbeat runtime Phase 4: native stdio heartbeat scheduling now emits approved external heartbeat notifications as `heartbeat.delivery` worker events with Python-compatible channel/chat/content payloads, closing the server wiring gap with Python `on_heartbeat_notify`.

- Continued Heartbeat runtime Phase 4: TS `HeartbeatRuntime` now uses the shared Python-compatible background evaluator by default before scheduled notifications, sharing the evaluator prompt/tool schema with Cron and preserving Python's failure-default-to-notify behavior.

- Continued Cowork Phase 10 desktop default-route parity: desktop branch-result select-final requests now carry target-branch architecture when known, and the gateway keeps explicit non-swarm branch final-result selections on the mutation rollout gate instead of forcing every branch-scoped select-final call through the swarm/Python fallback path.

- Continued Cowork Phase 10 desktop default-route parity: desktop branch-select requests now carry target-branch architecture when known, and the gateway keeps explicit non-swarm branch selections on the mutation rollout gate instead of forcing every branch select through the swarm/Python fallback path.

- Continued Cowork Phase 10 desktop default-route parity: desktop Cowork recipientless message action requests now carry selected-session architecture when known, and the gateway keeps explicit non-swarm group messages on the mutation rollout gate instead of forcing them through the swarm/Python fallback path.

- Continued Cowork Phase 10 desktop default-route parity: desktop Cowork run action requests now carry the selected session architecture/workflow mode when known, so swarm sessions triggered from the native pane still hit the desktop gateway swarm rollout gate and can preserve Python fallback when swarm TS routing is disabled.

- Continued Cowork Phase 10 desktop default-route parity: desktop gateway Cowork run rollout gates now treat explicit swarm architecture/mode aliases in run request bodies as swarm-bound, preserving Python fallback when the swarm rollout gate is disabled instead of routing those runs to the TS scheduler path.

- Continued Channel Bus retry parity: TS `ChannelManager` now treats adapter `AbortError` / cancellation errors like Python `asyncio.CancelledError`, propagating cancellation out of send retry instead of converting it into a final `send_failed` diagnostic, while the background dispatcher exits cleanly on cancellation.

- Continued Channel Bus lifecycle parity: TS `ChannelManager.stopAll()` now isolates per-channel stop failures like Python `stop_all()`, continues stopping healthy adapters, clears running status, and exposes `stop_failed` diagnostics instead of aborting shutdown.

- Continued Channel Bus lifecycle parity: TS `ChannelManager.startAll()` now isolates per-channel startup failures like Python `_start_channel()`, continuing to start healthy adapters while exposing failed adapter diagnostics instead of aborting the whole channel runtime.

- Continued Channel Bus dispatcher parity: TS `ChannelManager` now waits on the outbound `MessageBus` with a cancellable timeout, so messages published after startup wake the dispatcher immediately like Python's blocking outbound consumer instead of waiting for the idle poll interval.

- Continued Channel Bus manager lifecycle parity: TS `ChannelManager.startAll()` now starts a Python-like outbound dispatcher loop that drains the outbound `MessageBus` without manual `dispatchAvailable()` calls, and `stopAll()` stops the loop before stopping channel adapters.

- Continued Channel Bus manager parity: TS `ChannelManager` now treats `sendMaxRetries` as Python does for `channels.send_max_retries`: a total delivery-attempt count including the initial send, decoupled from the retry delay table.

- Continued Channel Bus manager parity: TS `ChannelManager` now mirrors Python `BaseChannel.send_delta()` no-op fallback by swallowing stream, reasoning, and stream-end frames when an adapter has no `sendDelta`, instead of sending partial stream frames as ordinary channel messages.

- Continued Cowork Phase 10 desktop rollout coverage: gateway default-route regression tests now cover Python-compatible create-session architecture precedence when a truthy numeric `architecture` value appears before a later swarm `workflow_mode`, keeping the request on the native default path instead of falling through to Python fallback.

- Continued Cowork Phase 10 desktop rollout parity: desktop gateway create-session scheduler gates now treat either `autoRun` or Python `auto_run` truthy values as scheduler-bound, preserving Python fallback when TS scheduler routing is disabled and mixed-alias request bodies would otherwise slip to the native create route.

- Continued Cowork Phase 10 native route parity: TS worker create-session auto-run now treats either `autoRun` or Python `auto_run` truthy values as scheduler-bound, so mixed-alias desktop/native request bodies still launch the migrated Cowork scheduler.

- Continued Cowork Phase 10 native route parity: TS worker Cowork run routes now treat either camel or Python snake-case `run_until_idle` / `stop_on_blocker` truthy values as scheduler flags, preserving Python-compatible run behavior for mixed-alias desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker Cowork run routes now skip blank/unparseable camel-case numeric aliases before honoring Python snake-case `max_rounds`, `max_agents`, and `max_agent_calls` values, while preserving Python zero-value default fallback semantics.

- Continued Cowork Phase 10 native route parity: TS worker blueprint create auto-run now still honors Python `rounds` fallback when blank/unparseable camel-case `maxRounds` appears in mixed-alias desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker assign-task routes now preserve Python `assigned_agent_id` precedence when blank direct-worker `agentId` aliases appear in mixed desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker add-task routes now preserve Python `assigned_agent_id` precedence when blank camel-case `assignedAgentId` aliases appear in mixed desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker task-review routes now preserve Python `reviewer_agent_id` precedence when blank camel-case `reviewerAgentId` aliases appear in mixed desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker branch-derive routes now preserve Python snake-case text field precedence when blank camel-case aliases appear for `target_architecture`, `derivation_reason`, and inherited context summaries.

- Continued Cowork Phase 10 native route parity: TS worker branch final-result select routes now preserve Python `result_id` precedence when blank camel-case `resultId` aliases appear in mixed desktop/native request bodies.

- Continued Cowork Phase 10 native route parity: TS worker final-result merge routes now preserve Python `branch_ids` precedence when blank camel-case `branchIds` aliases appear in mixed desktop/native request bodies.

- Continued Cowork Phase 10 create-session route parity: TS-native create-session architecture alias selection now mirrors Python truthy text coercion for `architecture` / `workflow_mode` / `mode`, so truthy numeric primary aliases are preserved before service normalization instead of falling through to later aliases.

- Continued Cowork Phase 10 direct/default-route parity: TS-native blueprint validate/preview now mirror Python route text coercion for `default_goal`, preserving truthy numeric fallback goals before blueprint normalization.

- Continued Cowork Phase 10 direct RPC parity: direct TS read-only observability RPCs now mirror Python route text coercion for agent activity and observation detail ids, preserving truthy numeric `agent_id`, `detail_id`, and requester aliases through Cowork service lookups.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.deliver_envelope` RPCs now mirror Python route text coercion for envelope sender/content and metadata fields, preserving truthy numeric values through delivered mailbox records instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS mailbox read RPCs now mirror Python route text coercion for `agent_id`, letting truthy numeric agent ids reach mailbox service handling instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS work-unit action RPCs now mirror Python route text coercion for target `work_unit_id`, letting truthy numeric work-unit ids reach service-level validation instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.send_message` RPCs now mirror Python route text coercion for `sender_id`, preserving truthy numeric sender ids in message records instead of silently falling back to `user`.

- Continued Cowork Phase 10 direct RPC parity: direct TS task mutation RPCs now mirror Python route text coercion for target `task_id`, letting truthy numeric task ids reach service-level validation for assign/retry/review instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.add_task` RPCs now mirror Python route text coercion for direct-only `expected_output`, `fanout_group_id`, and `merge_task_id` metadata, preserving truthy numeric values through task state and swarm projections.

- Continued Cowork Phase 10 direct RPC parity: direct TS work-unit action RPCs now mirror Python route text coercion for `reason`, preserving truthy numeric retry/skip/cancel reasons through work-unit state, task results, and trace metadata.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.emergency_stop_session` RPCs now mirror Python route text coercion for `reason`, preserving truthy numeric stop reasons in scheduler agent-step output instead of falling back to the default stop explanation.

- Continued Cowork Phase 10 direct RPC parity: direct TS branch/final-result RPCs now mirror Python route text coercion for `branch_id`, preserving truthy numeric branch ids through service validation instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.select_branch_result` RPCs now mirror Python route text coercion for `result_id`, preserving truthy numeric result ids in validation instead of silently selecting the branch's default result.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.merge_branch_results` RPCs now mirror Python route text coercion for merge `summary`, preserving truthy numeric summaries instead of generating a default branch merge summary.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.derive_branch` RPCs now mirror Python route text coercion for branch derivation metadata, preserving truthy numeric `reason`/`title`/`inherited_context_summary` fields instead of generating default branch metadata.

- Continued Cowork Phase 10 create-session route parity: TS-native Cowork session creation now mirrors Python route text coercion for `goal` and `title`, accepting truthy numeric JSON values while still rejecting falsy/missing goals.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.request_task_review` RPCs now mirror Python route text coercion for `reviewer_agent_id`, preserving truthy numeric reviewer ids before reviewer-task assignment fallback.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.assign_task` RPCs now mirror Python route text coercion for `assigned_agent_id`, preserving truthy numeric assignee ids through service slug normalization instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.add_task` RPCs now mirror Python route text coercion for optional `assigned_agent_id`, preserving truthy numeric assignee ids through service slug normalization instead of dropping assignment.

## 2026-06-13 Progress Note

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.add_task` RPCs now mirror Python route text coercion for optional task `description`, preserving truthy numeric JSON descriptions instead of falling back to the task title.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.add_task` RPCs now mirror Python route text coercion for required task `title`, accepting truthy numeric JSON values as task titles while still rejecting falsy/blank titles.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.send_message` RPCs now mirror Python route text coercion for required message `content`, accepting truthy numeric JSON values as message text while still rejecting falsy/blank content.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.send_message` RPCs now mirror Python route text coercion for optional message metadata, preserving truthy numeric `thread_id`, `topic`, and `event_type` values instead of dropping them before mailbox/thread projection.

- Continued Cowork Phase 10 direct RPC parity: direct TS `cowork.create_session` RPCs now honor Python-compatible `auto_run` scheduling and numeric run limits, reusing the migrated scheduler instead of returning an unrunnable freshly-created session.

- Continued Cowork Phase 10 task-review route parity: TS-native review-task routes now mirror Python route text coercion for `reviewer_agent_id`, preserving truthy numeric reviewer ids before reviewer assignment fallback.

- Continued Cowork Phase 10 add-task route parity: TS-native add-task routes now mirror Python's narrower route payload boundary, ignoring direct worker RPC-only fields such as review/fanout/merge metadata instead of persisting them through HTTP route requests.

- Continued Cowork Phase 10 message route metadata parity: TS-native message routes now mirror Python route text coercion for `thread_id`, `topic`, and `event_type`, preserving truthy numeric JSON metadata through mailbox/thread projections.

- Continued Cowork Phase 10 work-unit route parity: TS-native work-unit retry/skip/cancel routes now mirror Python route text coercion for `reason`, preserving truthy numeric JSON reasons in retry priority boosts and skip/cancel task results.

- Continued Cowork Phase 10 final-result select route parity: TS-native final-result select routes now mirror Python route text coercion for `branch_id` and `result_id`, letting truthy numeric JSON ids reach the migrated Cowork service as strings instead of failing at the worker protocol boundary.

- Continued Cowork Phase 10 branch-derive route parity: TS-native derive-branch routes now mirror Python route text coercion for `title`, `reason`/`derivation_reason`, `inherited_context_summary`, and related architecture/source aliases, preserving truthy numeric JSON fields instead of falling back to generated branch metadata.

- Continued Cowork Phase 10 final-result route parity: TS-native branch-result merge routes now mirror Python route text coercion for `summary`, preserving truthy numeric JSON summaries such as `404` instead of dropping them and generating a default merge summary.

- Continued Channel Bus Phase 4 bridge diagnostics: exported `PythonChannelBridge` now ingests Python channel inbound JSON into the TS `MessageBus`, preserves the shared bridge schema, and converts malformed payloads, closed-bus delivery, and inbound queue pressure into host-safe diagnostics instead of throwing through the bridge boundary.

- Continued Heartbeat runtime Phase 3 timezone parity: native stdio worker heartbeat decisions now format `Current Time` from the current `agents.defaults.timezone` config instead of a raw UTC ISO timestamp, matching the Python heartbeat prompt contract.

- Continued Command Runtime Phase 3 provider-backed Dream prompt parity: native `memory.dream_pending` now returns current Memory Notes plus `MEMORY.md` / `SOUL.md` / `USER.md` view text, and TS provider-backed Dream prompts include that context before asking the provider for JSON Memory Operations.

- Continued Command Runtime Phase 3 provider-backed Dream extraction: TS `/dream` now wraps the native Dream bridge with a provider-backed path, parses Python-compatible JSON Memory Operations for deferred evidence/history batches, applies save/reject/supersede operations through native `memory.dream_apply`, and leaves Dream cursors unchanged on invalid provider JSON.

- Continued Command Runtime Phase 3 provider-backed Dream preparation: Rust now exposes internal `memory.dream_pending` / `memory.dream_apply` RPCs so TS can read deferred Dream batches and apply provider-generated notes with `capture_origin: dream` while advancing the matching evidence/history cursor; `NativeDreamBridge` now has typed hooks for those RPCs.

- Continued Command Runtime Phase 3 native Dream consolidation parity: Rust `memory.dream_run` now defers pending conversation evidence and legacy history records that lack explicit memory intent instead of advancing `.evidence_cursor` / `.dream_cursor`, preserving those records for the follow-up provider-backed LLM summarization path.

- Continued Cowork Phase 10 runtime route regression coverage: TS worker route tests now explicitly cover Python-compatible invalid-body handling for work-unit `skip` and `cancel` routes while retaining the existing permissive `retry` route behavior.

- Continued Cowork Phase 10 run/create route parity: TS-native Cowork run parsing now mirrors Python's zero-value fallback for `max_agents` / `parallel_width` and `max_agent_calls`, treating `0` string/number values as absent instead of clamping them to one.

- Continued Cowork Phase 10 desktop rollout parity: desktop gateway scheduler rollout gates now mirror Python truthiness for string-form `auto_run` values, keeping Python fallback active when scheduler routing is disabled instead of sending those requests down the TS-native default path.

- Continued Cowork Phase 10 desktop rollout parity: desktop gateway swarm rollout gates now mirror Python truthiness when selecting create and branch-derive architecture aliases, so falsy primary fields fall through to Python-compatible fallback aliases before deciding TS-native versus Python routing.

- Continued Cowork Phase 10 desktop rollout parity: desktop gateway recipient-less swarm message gates now mirror Python truthiness for `recipient_ids`, keeping null/empty recipient payloads on the Python fallback path when swarm routing is disabled instead of misclassifying them as direct native messages.

- Continued Cowork Phase 10 create-session route parity: TS-native Cowork session creation now mirrors Python's `architecture` before `workflow_mode` precedence on the worker route itself, including skipping falsy string aliases before choosing the session workflow mode.

- Continued Cowork Phase 10 message/task route parity: TS-native message content and task title validation now mirror Python route `str(payload.get(...) or "").strip()` handling, accepting truthy numeric JSON values as text while still rejecting falsy/blank values.

- Continued Cowork Phase 10 add-task route parity: TS-native add-task routes now apply the same Python route text coercion to optional `description` and assignee fields before invoking the migrated service, preserving numeric JSON descriptions instead of falling back to the task title.

- Continued Cowork Phase 10 emergency-stop route parity: TS-native emergency-stop routes now apply Python route text coercion to `reason` bodies, preserving truthy numeric JSON reasons in scheduler agent-step output instead of falling back to the default stop explanation.

- Continued Cowork Phase 10 assign-task route parity: TS-native assign-task routes now apply Python route text coercion to assigned agent ids, preserving truthy numeric JSON `assigned_agent_id` values in route-level service errors instead of falling back to the empty-id slug.

- Continued Cowork Phase 10 summary route parity: TS-native summary routes now mirror Python `CoworkTool` missing-session responses by returning a `summary` error string with HTTP 200 instead of a route-level 404.

- Continued Cowork Phase 10 message route parity: TS-native message routes now mirror Python `CoworkTool` missing-session responses after JSON/content validation, returning a Python-shaped `result` error with `session: null` instead of a route-level 404.

- Continued Cowork Phase 10 add-task route parity: TS-native add-task routes now mirror Python `CoworkTool` missing-session responses, returning a Python-shaped `result` error with `session: null` after title validation instead of a route-level 404.

- Continued Cowork Phase 10 control route parity: TS-native pause/resume routes now mirror Python `_simple_tool_action` missing-session responses, returning a Python-shaped `result` error with `session: null` instead of a route-level 404.

- Continued Cowork Phase 10 create-session route parity: TS-native session creation now mirrors Python's blueprint type guard, ignoring non-object `blueprint` values and falling through to goal-based creation instead of failing blueprint validation.

- Continued Cowork Phase 10 budget route parity: TS-native budget update routes now mirror Python's `budgets` field precedence, ignoring malformed sibling `budget` values when the Python-compatible `budgets` payload is present.

- Continued Cowork Phase 10 queues route parity: TS-native `/queues` routes now return Python-shaped `cowork.swarm_queues.v1` empty queue projections for non-swarm sessions instead of inheriting the session snapshot's gated `{}` summary field.

- Continued Cowork Phase 10 trace route parity: TS-native Cowork trace routes now return Python-sized `scheduler_decisions[-80:]` history instead of inheriting the shorter session snapshot window.

- Continued Cowork Phase 10 route parity: TS-native agent activity routes now parse `limit` query values with Python `int(...)` semantics, defaulting malformed values such as `2.5` before the shared 1..80 clamp instead of truncating them through JavaScript `parseInt`.

- Continued Cowork Phase 10 route parity: TS-native blueprint create auto-run now mirrors Python's `rounds` alias for `max_rounds`, keeping blueprint launch scheduling limits aligned with the fallback route.

- Continued Cowork Phase 10 route parity: TS-native Cowork create-session routes now mirror Python truthiness for string-form `auto_run` flags before dispatching auto-run sessions through the migrated scheduler.

- Continued Cowork Phase 10 route parity: TS-native Cowork run routes now mirror Python truthiness for `run_until_idle` and `stop_on_blocker` JSON values, preserving Python fallback behavior for string-form route flags on the default worker route.

- Continued Cowork Phase 10 desktop/default-route parity: TS-native Cowork message dispatch now preserves Python-compatible `thread_id`, `topic`, and `event_type` fields through direct worker RPC and desktop action request builders instead of dropping route metadata before mailbox/thread projection.

- Continued Cowork Phase 10 desktop default-route parity: desktop Cowork action request builders and bootstrap dispatch now preserve Python-compatible emergency-stop `reason` bodies through the default UI path before calling the native-first gateway client.

- Continued Cowork Phase 10 desktop default-route parity: desktop gateway `cowork.action("emergency-stop")` now forwards Python-compatible JSON bodies such as `reason` through native-first routes instead of dropping them before the TS worker route handler.

- Continued session turn lifecycle parity cleanup: TS worker server integration coverage now matches the native `session.persist_turn` atomic checkpoint-clear contract instead of expecting a separate legacy `session.clear_checkpoint` RPC after final-response checkpoints.

- Continued Batch 5 Task/Cron background runtime parity: TS native `cron` add now mirrors Python's `cron_expr` timezone validation by rejecting unknown IANA timezone names before creating jobs.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` resume now mirrors Python's pre-spawn guards for DAG errors, blocked plans, all-subtasks-complete plans, and no-ready-subtask plans.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` resume now mirrors Python's completed/executing plan guards instead of re-entering background execution for terminal or already-running plans.

- Continued Batch 5 Task/Cron background runtime parity: TS native task status/create summaries now mirror Python's plan-summary details, including created timestamps, DAG error rows, status icons, and result ellipses.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` create results now mirror Python's user-facing creation prompt and `auto_execute` handoff into background subtask execution.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` resume and delete-not-found results now mirror Python's user-facing messages, including the background-start wording and delete missing-plan punctuation.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` add/remove subtask actions now mirror Python's user-facing success and failure messages for subtask mutation results.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task` pause/cancel actions now mirror Python's user-facing control messages, including plan titles and the pause resume hint.

- Continued Batch 5 Task/Cron background runtime parity: TS native `task action=list` now mirrors Python's active-plan list output by showing `Active task plans:` entries with `[completed/total]` progress counts.

- Continued Cowork Phase 10 route parity: TS-native Cowork run/create auto-run routes now parse Python-compatible numeric string limits for `max_rounds`, `max_agents` / `parallel_width`, and `max_agent_calls` instead of silently falling back to default scheduler budgets.

- Continued Cowork Phase 10 snapshot route parity: TS swarm gate final-deliverable summaries now mirror Python truthy `ready_to_finish` readiness semantics.

- Continued Cowork Phase 10 snapshot route parity: TS swarm gate evaluation summaries now mirror Python `blocking_ids` placeholders by preserving empty ids from blocking/error evaluations.

- Continued Cowork Phase 10 snapshot route parity: TS swarm gate projections now mirror Python truthy `required` handling for pending reviewer/reducer gate configuration.

- Continued Cowork Phase 10 snapshot route parity: TS large-swarm summaries now mirror Python workstream ordering by preserving first-seen order when groups have equal unit counts.

- Continued Cowork Phase 10 snapshot route parity: TS swarm blocker extraction now mirrors Python whitespace handling by ignoring blank dependency/blocker IDs before projecting blocker summaries and workstream risk.

- Continued Cowork Phase 10 snapshot route parity: TS swarm workstream risk projection now mirrors Python completed-workstream behavior by keeping completed groups at `low` risk even when dependency/blocker metadata is present.

- Continued Cowork Phase 10 snapshot route parity: TS swarm workstream risk projection now mirrors Python by keeping active/running workstreams at `low` risk unless blockers are present.

- Continued Cowork Phase 10 snapshot route parity: TS swarm organization projections now embed Python-compatible parallel metrics instead of returning an empty `metrics` object.

- Continued Cowork Phase 10 snapshot route parity: TS Cowork graph, swarm queue, swarm metrics, large-swarm summary, and swarm-organization projections now populate Python-compatible `generated_at` timestamps instead of empty strings.

- Continued Cowork Phase 10 snapshot route parity: TS swarm critical-path metrics now mirror Python's cycle handling by treating recursive dependency visits as depth `1`, preserving Python-compatible `critical_path_depth` for malformed/cyclic swarm plans.

- Continued Cowork Phase 10 snapshot route parity: TS swarm reducer-coverage metrics now mirror Python by reading `source_work_unit_ids` from any reducer task with a `swarm_reducer:` source event, regardless of whether the reducer task has already completed.

- Continued Cowork Phase 10 snapshot route parity: TS swarm parallel metrics now mirror Python's trace-derived observed fanout width and empty reducer-coverage baseline, counting unique `Work unit started` trace work-unit ids and reporting `reducer_coverage=0` until completed fanout units are cited.

- Continued Cowork Phase 10 snapshot route parity: TS swarm session snapshots now project Python-compatible scheduler queue and parallel-metric payloads instead of empty `swarm_queues` / `swarm_metrics` objects, keeping desktop/default queues routes backed by the migrated TS snapshot contract.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now mirrors Python's ready-before-failed-retry queue ordering, keeping fresh ready work ahead of retry candidates even when retry units have higher priority.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now mirrors Python retry behavior for failed source tasks, allowing failed/needs-revision work units to reselect agents even when the source task is failed.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now includes Python-compatible failed-retry units, selecting failed/needs-revision work units while retry attempts remain.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now mirrors Python's duplicate work-unit signature guard, skipping ready units whose title/description/input/schema signature is already running or selected.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now respects Python's parallel-width slot calculation, withholding new swarm workers when existing active workers already saturate the session budget.

- Continued Cowork Phase 10 scheduler parity: TS swarm active-agent selection now mirrors Python's direct swarm selector return, avoiding a fallback to team readiness when no swarm work units are ready.

- Continued Cowork Phase 10 scheduler parity: TS active-agent selection now mirrors Python's inactive-session guard, returning no candidates for paused/completed/blocked sessions before team or swarm scheduling.

- Continued Cowork Phase 10 scheduler parity: TS active-agent and swarm selection now mirror Python terminal-agent filtering, excluding `done` / `failed` / `retired` agents and retired lifecycle records even if stale inbox work remains.

- Continued Cowork Phase 10 scheduler parity: TS active-agent selection now mirrors Python shared-task slot consumption for unassigned ready tasks, preventing multiple idle agents from being scheduled for the same shared task and exposing the Python-compatible shared-task candidate score.

- Continued Cowork Phase 10 mailbox parity: TS mailbox readiness scoring now preserves Python shared-state open-question pressure, boosting shared-state agents when shared memory contains non-empty open-question text.

- Continued Cowork Phase 10 mailbox parity: TS mailbox readiness scoring now preserves Python message-bus subscription pressure, boosting subscribed agents when live mailbox records match their topic/event/request/kind subscriptions.

- Continued Cowork Phase 10 mailbox parity: TS mailbox readiness scores and activation reasons now preserve Python lead synthesis readiness, adding the lead-only synthesis boost when completed task work still needs user-visible finalization.

- Continued Cowork Phase 10 mailbox parity: TS mailbox readiness activation reasons now include Python-compatible `shared_task_claim` for claimable pending tasks, including unassigned shared-pool tasks and tasks already assigned to the agent when dependencies are complete.

- Continued Cowork Phase 10 mailbox parity: TS mailbox completion-decision refresh now preserves Python review gate blockers for review-required completed/failed tasks, returning `resolve_review_gates` before pending reply blockers or summarize readiness.

- Continued Cowork Phase 10 mailbox parity: TS mailbox completion-decision refresh now mirrors Python goal-review readiness for completed task results, returning `summarize` with `ready_to_finish=true` when completed tasks have sufficient structured/user-visible output and no higher-priority blockers remain.

- Continued Cowork Phase 10 mailbox parity: TS mailbox completion-decision refresh now honors Python convergence review priority ahead of unread inbox work and emits `no_progress_rounds` / `convergence_limit` decision metadata.

- Continued Cowork Phase 10 mailbox parity: TS mailbox completion-decision refresh now honors Python's failed-task priority ahead of pending reply blockers, so failed tasks surface as `review_failed_tasks` even when new mailbox reply requests are delivered.

- Continued Cowork Phase 10 mailbox parity: TS mailbox delivery now refreshes Python-compatible completion decisions for pending reply blockers after delivered/read `requires_reply` records, exposing `resolve_blockers` decisions with blocker summaries instead of leaving stale or empty decision payloads.

- Continued Cowork Phase 10 mailbox parity: TS mailbox user-message reopen now resets stale completed-session readiness decisions to Python-compatible `run_next_round` with `ready_to_finish=false`, matching the post-delivery `assess_session()` behavior instead of preserving old completion state.

- Continued session turn lifecycle parity: `AgentWorker` now leaves completed-turn checkpoint clearing to `TurnLifecycle.finalizeTurn()` instead of clearing once before lifecycle finalization and again during append fallback, matching the Python lifecycle owner boundary and restoring full worker checkpoint-clear test coverage.

- Continued Channel Bus command parity: TS `ChannelRuntime` now handles channel slash commands before ordinary agent dispatch, and the worker `channel.dispatch_inbound` path reuses the backend command router so `/stop` over external channels cancels active runs for the same session without loading agent context or calling the provider.

- Continued Cowork internal delegation parity: TS `cowork_internal` `spawn_agent` and `spawn_subteam` now honor explicit spawned-agent budget exhaustion with Python-compatible guardrail records, `spawn_budget_exhausted` stop state, delegation-denied events, and no accidental sub-agent creation.

- Continued Cowork Phase 10 desktop route parity: selecting a Cowork agent in either the legacy desktop inspector or native Vue inspector now exposes an Activity action that dispatches `loadAgentActivity` into the existing native-first Cowork facade.

- Continued Cowork Phase 10 desktop default-route parity: selected-agent Activity actions from both desktop inspectors now carry the default activity `limit` through the native action event and bootstrap handler, preserving the migrated TS-native `/activity?limit=...` route instead of dropping the query option.

- Continued Cowork Phase 10 rollout parity: desktop gateway branch-select requests now follow the swarm rollout gate alongside branch-result/final-result routes, so disabling TS swarm routing preserves the Python fallback for branch selection.

- Continued Cowork Phase 10 rollout parity: desktop gateway Cowork session creation now follows Python's `architecture` before `workflow_mode` precedence when applying swarm rollout gates, so non-swarm architecture overrides no longer fall back to Python and swarm architecture overrides still preserve Python fallback while TS swarm routing is disabled.

- Continued Cowork Phase 10 rollout parity: desktop auto-run swarm session creation now requires both TS scheduler and swarm rollout gates before using the native route, preserving Python fallback when either side of the Python create-and-run behavior is disabled.

- Continued Cowork Phase 10 desktop route parity: desktop Cowork cockpit branch rows now consume Python/TS snapshot `branches` with nested `branch_result` data when top-level `branch_results` are absent, keeping branch select/derive/merge controls wired to native-first route actions for newly derived branches.

- Continued Cowork Phase 10 route parity: TS-native branch derive routes now accept Python-compatible `architecture` aliases as target architectures, so desktop/default-route branch derivation no longer silently falls back to `adaptive_starter` when callers use the Python body shape.

- Continued Cowork Phase 10 route parity: TS-native branch derive routes now preserve Python-compatible `derivation_reason` aliases in branch, stage, and event records, keeping default-route branch derivation metadata aligned with Python fallback requests.

- Continued Cowork Phase 10 route parity: TS-native message routes now preserve Python-compatible `thread_id` and `topic` request fields when creating new discussion threads, keeping desktop/default-route message threading aligned with Python fallback behavior.

- Continued Cowork Phase 10 route parity: TS-native message routes now deliver non-swarm API messages through the Cowork mailbox envelope path, preserving Python-compatible delivered mailbox records and `event_type` metadata while retaining message/thread responses.

- Continued Cowork Phase 10 mailbox parity: TS mailbox delivery now expires overdue records before delivering new envelopes, matching Python mailbox behavior so native message routes do not keep stale blockers active.

- Continued Cowork Phase 10 route parity: TS-native Cowork mutation routes that mirror Python `_json_body()` now reject missing request bodies with `invalid json body` instead of treating them as empty objects.

- Continued Cowork Phase 10 desktop observability parity: selected-agent inspectors now expose the latest tool/browser observation detail action when agent activity includes a `detail_ref`, and both legacy and Vue desktop paths send `loadObservation` with requester `agent_id` into the existing TS-native observation route.

- Continued Cowork Phase 10 desktop route parity: the native Vue Cowork inspector now emits derive-branch, select-final-result, and merge-final-result events for selected branches, keeping the Vue island action surface aligned with the migrated TS-native route facade.

- Continued session turn lifecycle evidence durability: native `session.persist_turn` now returns the exact `saved_messages` it appended, and TS `TurnLifecycle` uses that contract for memory evidence capture instead of guessing from `savedMessageCount`, so partial duplicate turns capture only newly persisted messages.

- Continued Cowork Phase 10 desktop route parity: desktop `buildDesktopCoworkActionRequest()` now preserves Python-compatible `limit` query options for agent-activity requests, keeping root/native action requests aligned with the native-first gateway facade.

- Continued session turn lifecycle evidence durability: TS `TurnLifecycle.finalizeTurn()` now skips conversation evidence capture when native `session.persist_turn` reports a duplicate-only turn with `savedMessageCount=0`, preventing repeated persisted turns from generating duplicate memory evidence.

- Continued session turn lifecycle evidence durability: the `session.append_messages` fallback path now applies the same saved-message evidence filter, so duplicate-only append results also skip memory evidence capture.

- Continued Cowork scheduler Python parity: TS `CoworkScheduler` now emits Python-compatible `scheduler.agent_budget_exhausted` / `scheduler.budget_exhausted` events and blocked stop trace status for budget-limit stops, preserving native observability semantics without Python fallback.

- Continued Cowork Phase 10 rollout parity: desktop gateway recipient-less swarm message classification now follows the TS worker parser's `recipientIds` before `recipient_ids` alias precedence, keeping rollout fallback aligned with native route behavior.

- Continued Cowork Phase 10 rollout parity: desktop gateway blueprint-based Cowork session creation now gives blueprint architecture precedence over top-level create mode while applying swarm rollout gates, matching Python create-session routing.

- Continued Cowork Phase 10 rollout parity: desktop gateway auto-run swarm session creation now checks the swarm rollout gate before scheduler routing, so disabling TS swarm routing preserves Python fallback for create-and-run swarm starts.

- Continued Cowork Phase 10 rollout parity: desktop gateway swarm-create rollout classification now uses Python/TS-style architecture normalization, so case/whitespace variants such as `Swarm` still preserve Python fallback when TS swarm routing is disabled.

- Continued Cowork Phase 10 rollout parity: desktop gateway Cowork session creation now also classifies nested blueprint swarm modes under the swarm rollout gate, preserving Python fallback for blueprint-driven swarm starts when TS swarm routing is disabled.

- Continued Cowork Phase 10 rollout parity: desktop gateway Cowork session creation that explicitly targets `swarm` via `workflow_mode` / `workflowMode` / `architecture` / `mode` now follows the swarm rollout gate, preserving Python fallback when TS swarm routing is disabled.

- Continued Cowork Phase 10 rollout parity: desktop gateway Cowork session creation with `auto_run` / `autoRun` is now classified under the scheduler rollout gate, so disabling TS scheduler routing sends create-and-run requests to the Python fallback instead of accidentally invoking the native TS scheduler path.

- Continued config/provider preview durability: TS provider-model preview now falls back to an empty public config when native snapshots are unavailable but request-scoped `api_key` / `api_base` / manual models are supplied, preserving live/manual model discovery without native secret resolution.

- Continued config/provider bridge durability: `modelProviderConfigFromNativeConfig()` legacy fallback now treats native `provider=auto` as eligible for `provider.resolve_secret`, so snapshot-unavailable workers can still resolve configured OpenAI secrets without env keys.

- Continued TS worker packaging/build boundary: `apps/desktop` now has a `typecheck:worker` gate backed by a dedicated `workers/ts-agent-worker/tsconfig.json` plus a Node source-runtime smoke check, and the main desktop build runs it before Vite packaging so worker type/runtime syntax regressions are no longer hidden by the app-only `tsconfig`.

- Continued session turn lifecycle durability: native Rust `session.persist_turn` now deduplicates incoming persisted messages using Python-compatible user/assistant/tool message keys and reports real saved/duplicate message counts, so repeated TS worker persistence cannot grow session history with already-saved turn messages.

- Continued config/provider native handoff parity: TS WebUI `/api/provider-models` and worker `provider.models.list` now accept temporary `api_key` / `api_base` overrides and pass them only into live model discovery, matching the Python settings-preview flow without persisting or echoing secrets.

- Continued session turn lifecycle durability: native Rust `session.append_messages` now shares the same Python-compatible user/assistant/tool duplicate-message protection as `session.persist_turn`, keeping checkpoint restore and fallback append paths from growing session history with already-saved messages.

- Continued session turn lifecycle fallback parity: TS `TurnLifecycle.finalizeTurn()` now explicitly clears terminal checkpoints when it must fall back to low-level `session.append_messages`, so fallback persistence no longer reports `checkpointCleared=true` without actually clearing the native session checkpoint.

- Continued session turn lifecycle evidence durability: TS `TurnLifecycle.finalizeTurn()` now uses native append fallback session sizes as the conversation-evidence start index when `session.persist_turn` is unavailable, keeping evidence cursors aligned for existing sessions on downgrade paths.

- Continued session history projection parity: native Rust `session.get_history` now preserves both snake_case and camelCase model-history fields for tool calls, tool call ids, reasoning content, and thinking blocks, so mixed TS/Rust session records stay usable for the next TS turn.

- Continued session legal-boundary parity: native Rust history projection now treats camelCase `toolCalls` / `toolCallId` as legal tool-call boundary signals alongside Python/OpenAI-style snake_case fields, preventing valid mixed TS/Rust tool-call turns from being trimmed out of the next TS context.

- Continued session persistence dedupe parity: native Rust `session.append_messages` and `session.persist_turn` now normalize OpenAI-style `tool_calls` and TS `toolCalls` into the same assistant-message duplicate key, preventing equivalent mixed-shape tool-call turns from being saved twice.

- Continued config/provider bridge durability: TS `modelProviderConfigFromNativeConfig()` legacy fallback now resolves OpenAI secrets through the native `provider.resolve_secret` bridge when env keys are absent, preserving env-key priority while removing the old env-only dependency for snapshot-unavailable native paths.

- Continued Batch 5 Task/Cron background runtime parity: TS `cron.run_due` now runs Python-compatible evaluator gating for `deliver=true` cron results, suppresses routine responses, emits `cron.delivery` for notify decisions, records delivery decisions in per-job run records, and preserves Python's fail-open notify behavior when evaluator calls fail.

- Continued Heartbeat runtime Phase 2 worker bridge: TS worker now exposes `heartbeat.trigger_now` and `heartbeat.status` request methods over the worker protocol, delegating to the injected `HeartbeatRuntime` while preserving explicit unavailable-runtime errors for native host callers.

- Continued Heartbeat runtime Phase 2 native server wiring: `createAgentWorkerServer()` now injects a real `HeartbeatRuntime` backed by native `workspace.read_file`, `config.snapshot_public`, and `session.list_metadata` bridges so `heartbeat.trigger_now` can execute through the stdio worker path.

- Continued Heartbeat runtime Phase 2 session trimming: native `session.trim` now retains a Python-compatible recent legal suffix, and the TS heartbeat runtime trims the fixed `heartbeat` session after execution using the current `gateway.heartbeat.keep_recent_messages` config value.

- Continued Heartbeat runtime Phase 2 lifecycle wiring: TS worker now exposes `heartbeat.start` and `heartbeat.stop`, and `createAgentWorkerServer()` starts scheduling from native `gateway.heartbeat.enabled` / `interval_s` config snapshots.

- Continued Heartbeat runtime Phase 3 diagnostics exposure: TS `/api/status` now includes heartbeat scheduler diagnostics from the injected runtime, refreshing native heartbeat enabled/interval config before returning the status payload.

- Continued Heartbeat runtime Phase 3 config hot update: TS-native `/api/config` PATCH now refreshes the injected heartbeat runtime after native config-store apply, so enabled/interval changes take effect without waiting for gateway restart or a status poll.

- Continued MCP/WebUI config hot update parity: TS-native `/api/config` PATCH now reconnects native MCP discovery when MCP server fields change, mirroring Python WebUI config side effects without a gateway restart.

- Continued MCP diagnostics durability: the native MCP bridge now caches the latest discovery diagnostics and TS `/api/status` exposes connected/failed server diagnostics after MCP reconnects, making dynamic MCP tool state observable from the migrated WebUI route.

- Continued MCP config contract parity: TS native MCP reconnect now applies the updated `tools.mcpServers` allowlist and timeout config from WebUI config patches before registering discovered native tools, preserving dynamic discovery while preventing unallowlisted tools from entering the worker registry.

- Continued Heartbeat runtime Phase 3 host lifecycle ownership: the native desktop host now starts TS heartbeat scheduling during app setup and stops it on window close through the experimental TS worker, with Node-runtime import/syntax fixes verified by real stdio `heartbeat.start` / `heartbeat.stop` responses.

更新时间：2026-06-12

本文档用于跟踪 `overall.md` 中建议的 TypeScript runtime migration 推进顺序。推进方式按依赖层分批完成，而不是逐个设计文档从 Phase 1 做到最后。

## Status Legend

- `todo`：尚未开始
- `active`：正在推进
- `blocked`：等待前置依赖或决策
- `verify`：实现大概率完成，但需要按验收项复核
- `done`：已实现并通过必要验证

## Current Focus

- Current batch: Batch 6 WebUI transport has started after Cowork route/facade parity; `GET /health`, `GET /v1/models`, `POST /v1/chat/completions`, `GET /webui/bootstrap`, `POST /webui/refresh-token`, `GET /api/status`, `GET /api/tools`, `GET /api/skills`, `POST /api/skills`, `GET /api/skills/{name}`, `PATCH /api/skills/{name}`, `DELETE /api/skills/{name}`, `POST /api/skills/{name}/validate`, `GET /api/config`, `PATCH /api/config`, `GET /api/providers`, `POST /api/provider-models`, `GET /api/approvals`, `POST /api/approvals/{approval_id}/approve`, `POST /api/approvals/{approval_id}/deny`, `POST /api/agent-ui/forms/{form_id}/submit`, `POST /api/agent-ui/forms/{form_id}/cancel`, `GET /api/workspace/files`, `GET /api/workspace/files/{path:.+}`, `PUT /api/workspace/files/{path:.+}`, `GET /api/sessions`, `GET /api/sessions/{key}/messages`, `GET /api/sessions/{key}/profile`, `GET /api/sessions/{key}/temporary-files`, `POST /api/sessions/{key}/temporary-files`, `PATCH /api/sessions/{key}`, `DELETE /api/sessions/{key}`, and `POST /api/sessions/{key}/clear` now have TS worker control-route handlers, Rust `worker_webui_route`, and desktop native facade fallback paths where the route can safely use structured native payloads; desktop near-expiry gateway token refresh now prefers the native refresh-token route before HTTP fallback. WebSocket work now has TS-owned Python-compatible outbound frame mapping, inbound client-frame mapping, worker RPCs for both directions, Rust `worker_transport_gateway_frame` / `worker_transport_websocket_message`, a Rust `worker_transport_dispatch_websocket_message` path that maps inbound message frames into `agent.run_input`, desktop native transport facades, and a root-WebUI native WebSocket shim for same-origin `/ws` that subscribes to TS worker stream events and projects content/reasoning, usage/error/done, cancellation, tool progress, task progress, memory references, browser frames, awaiting form, and awaiting approval events into legacy WebUI frames while preserving dispatch-result fallback behavior, stream-end reference metadata, and browser `source_command`.

- API Runtime Phase 1 now routes the native-supported Knowledge API subset (`GET/POST /v1/knowledge/documents`, including Python-shaped async add-document job envelopes, structured txt/md/markdown/json/csv `POST /v1/knowledge/documents/upload` with Python-shaped async job envelopes, native upload-job `GET /v1/knowledge/jobs/{job_id}` polling, native bm25/all `POST /v1/knowledge/rebuild-index` completed job envelopes plus `kjob_rebuild_bm25` / `kjob_rebuild_all` polling, native semantic `POST /v1/knowledge/rebuild-index` completed unavailable/skipped job envelopes plus `kjob_rebuild_semantic` polling, native `GET /v1/knowledge/graph` readiness/empty projection, native `GET /v1/knowledge/graphrag` Python-compatible empty GraphRAG index projection, `GET/DELETE /v1/knowledge/documents/{doc_id}`, `POST /v1/knowledge/query`, `GET /v1/knowledge/stats`) through TS worker route adapters backed by native `knowledge.*` RPCs, with desktop gateway methods preferring `worker_webui_route` before HTTP fallback; desktop GraphRAG facade calls now preserve Python-compatible query options such as `doc_id`, `level`, `include_reports`, and `include_covariates` on the native path. Extractor-dependent upload types such as PDF remain on HTTP fallback until their native extraction contracts are migrated.

- Cowork Phase 3/4/5 now has minimal TS `CoworkService` create/list/get/delete plus blueprint materialization wired through `AgentWorker` RPCs and the real stdio server's native `cowork_store.*` bridge. Message/task mutations now include `send_message`, `add_task`, `assign_task`, `retry_task`, and `request_task_review`; session control/budget mutations now include `pause_session`, `resume_session`, `emergency_stop_session`, and `update_budget`; branch/final-result mutations now include `derive_branch`, `select_branch`, `select_branch_result`, and `merge_branch_results` with persisted source-branch capture, branch result creation, stage records, selected final results, and merged final candidates; Phase 4 now has a pure TS `CoworkMailbox` for routing, record/message delivery, wake/reopen rules, read/reply lifecycle, deadline expiration, stale blocker escalation, and active dedup with `CoworkService.deliverEnvelope()` / `markMailboxMessagesRead()` / `expireMailboxRecords()` / `escalateStaleBlockers()` persistence plus Worker RPCs for those mailbox lifecycle operations; read-only facade RPCs now include `export_blueprint`, `get_graph`, `get_trace`, `get_agent_activity`, `get_observation_detail`, `get_summary`, `get_dag`, `get_artifacts`, `get_organization`, and `get_queues`; `cowork.route_request` now maps Python-compatible `/api/cowork/...` blueprint/session/message/task/session-control/budget/observability/branch/final-result/work-unit lifecycle routes to the TS service, including desktop `buildDesktopCoworkActionRequest()` path shapes and Python API compatibility paths for blueprint export, branch listing, branch-id derive, budget update, final-result select/merge aliases, and work-unit retry/skip/cancel. Phase 6 has started with an agent-facing TS `cowork` tool facade registered in the native worker for start/list/status/send_message/add_task/assign_task/pause/resume/summary/export_blueprint over the same `CoworkService`, plus a provider-backed TS `CoworkTeamPlanner` for goal-only starts with deterministic coordinator/reviewer fallback. Phase 7 now has a minimal TS `CoworkScheduler` plus `CoworkAgentRuntime`: scheduler records paused/completed/idle/max-round/blocker stop reasons, run metrics, scheduler decisions, and trace spans over the same native store bridge; when an agent runtime is configured it reselects ready agents across multiple rounds, unlocks dependent tasks after completed-task progress, honors `stopOnBlocker` for unresolved mailbox/review/fanout blockers, runs AgentRunner-backed cowork rounds up to round and agent-call limits, injects a TS `cowork_internal` tool for `send_message`, `create_thread`, `add_task`, `assign_task`, `claim_task`, `spawn_agent`, `spawn_subteam`, `retire_agent`, `update_status`, and agent-owned `complete_task`, parses progress JSON, completes tasks, updates agent state/private summary, records agent steps and agent trace spans, and persists the final scheduler stop state. `cowork action=run`, `cowork.run_session`, and desktop `/api/cowork/sessions/{id}/run` use the native TS path first and fall back to Python on native route errors. Remaining stream hooks, lead synthesis, advanced budget/convergence behavior, and deeper swarm-aware run behavior remain follow-up work.

- Cowork Phase 10 desktop action parity continues: `buildDesktopCoworkActionRequest()` and the desktop Cowork action UI now expose native route shapes for blueprint export, trace, DAG, artifacts, organization, queues, and branch listing; `handleNativeCoworkAction()` dispatches those read-only actions through the native-first `gatewayApi.cowork` facade so root/native desktop actions can target the migrated TS `cowork.route_request` observability endpoints without Python-only request construction.

- Cowork Phase 10 desktop route parity continues: `buildDesktopCoworkActionRequest()` now also covers the migrated TS-native budget update, source-branch derive, final-result select, and final-result merge route shapes, matching the native-first `gatewayHttpClient` Cowork facade paths; desktop budget update actions now default to the documented `PATCH /budget` route while the gateway facade preserves POST compatibility for older Python-shaped callers.

- Cowork Phase 10 desktop default-route coverage continues: desktop Cowork action controls now emit budget update plus source-branch derive/final-result select/final-result merge events, and `handleNativeCoworkAction()` dispatches them through the native-first `gatewayApi.cowork` facade instead of leaving those TS-native mutation routes as request-builder-only coverage. Agent activity and observation-detail desktop actions now also flow through the native-first Cowork facade, including requester `agent_id` query propagation for sensitive observation authorization.

- Channel Bus Phase 1/2 has started with TS-native `InboundMessage` / `OutboundMessage` envelopes, Python-compatible session key derivation, an async in-memory `MessageBus`, inbound/outbound publish-consume, batch consumption with timeout, close/unblock semantics, queue backlog diagnostics, and a small exported `bus` module surface. The first TS-native `BaseChannel` now covers Python-compatible `allow_from` semantics, streaming intent metadata, and inbound envelope publication. `ChannelManager` outbound dispatcher now covers Python-compatible ordinary sends, usage sends, stream/reasoning/end delta sends, progress/tool-hint filtering, consecutive stream-delta coalescing, unknown-channel diagnostics, retry/final-failure diagnostics, start/stop lifecycle, enabled channel listing, status projection, and Python-compatible restart completion notice delivery from `tinybot_RESTART_*` env markers. Channel registry/config foundations now expose built-in WebSocket/Feishu/DingTalk/Weixin descriptors, Python-compatible default config payloads, delivery-option selectors, and enabled-channel selection with default merging. `ChannelRuntime` now has the first pure TS inbound bridge from channel envelopes to `AgentRunInput`, preserving session keys, streaming intent, media, sender metadata, final response outbound publication, websocket usage outbound publication, and Python-compatible agent failure fallback replies. It now also handles channel slash commands before ordinary agent dispatch, allowing `channel.dispatch_inbound` to reuse the backend command router so `/stop` over external channels cancels same-session active runs without loading agent context or calling the provider for the command message. The worker now exposes `channel.dispatch_inbound` so native/Python channel bridges can submit a Python-compatible inbound envelope through the same `agent.run_input` context, runner, lifecycle, usage, and outbound-message path for non-command messages. Rust/Tauri now exposes `worker_channel_dispatch_inbound`, and the desktop native transport facade can invoke it for generic external channel envelopes. `pythonChannelBridge` now provides the shared schema normalization/projection layer for Python channel inbound JSON and outbound snake_case bridge JSON while preserving metadata, media, and session override fields, and its exported ChannelAdapter factory now lets `ChannelManager` deliver ordinary replies, usage frames, and stream deltas as Python-compatible outbound JSON for external channel adapters. The exported `PythonChannelBridge` ingress helper now publishes valid Python inbound JSON into the TS `MessageBus` while turning malformed payloads, closed-bus delivery, and inbound queue pressure into bridge diagnostics so Python external channels can keep using the migrated TS bus without throwing through the host boundary.

- 当前批次：Batch 5：commands、task/cron/background 已具备 TS/native 起点；Cowork runtime 已开始推进，blueprint validate/preview 已接入 worker RPC；Phase 1 已补上 TS session types、legacy serde/default hydration、`cowork_store.*` native bridge contract，以及 read-only `coworkSessionSnapshot()`/graph/trace/task DAG/artifact index projection；Phase 2 已启动 architecture normalize/label/fallback diagnostic、default policy registry 与 projection-only topology/organization capability，并接入 snapshot projection。
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
| 6 | active | [ts_session_turn_lifecycle_migration_design.md](ts_session_turn_lifecycle_migration_design.md) | 明确 persistence/checkpoint/resume 语义 | 已建立 `persistedMessages` 起点和 Rust/TS `session.persist_turn` RPC；AgentWorker 在可用时优先通过 `TurnLifecycle.finalizeTurn()` 写 completed turn，并通过 `TurnLifecycle.writeCheckpoint()` / `clearCheckpoint()` / `restoreCheckpoint()` 收敛 checkpoint write-clear 与 restore materialization；`checkpoint.ts` 已承载 approval/form resume projection helper；`agent.done.payload.lifecycle` 暴露 persisted/saved/checkpoint/omitted side-effect metadata；已补齐 TS persistence helper 的 Python-key dedupe/tool truncate、versioned checkpoint helper、append fallback evidence cursor alignment、partial-duplicate `saved_messages` evidence capture contract，以及 Rust `session.get_history` 的 user/tool legal boundary projection；真实 TS worker 连续两轮可读取上一轮 persisted history |
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
| 11 | active | [ts_memory_notes_migration_design.md](ts_memory_notes_migration_design.md) | 迁移 memory/notes persistent data 能力 | 已启动 TS/native Memory Notes recall 与显式操作面；`memory.search/save/trace/reject/supersede` 已具备 Rust RPC 与 TS native tools 起点；`memory.recall` 已由 Rust/native 生成 bounded recall context、notes、references，并由 TS `NativeContextBridge` 优先用于 `agent.run_input` context；`memory.capture_evidence/list_evidence` 已建立 native conversation evidence JSONL/cursor 起点，并由 TS TurnLifecycle 在 persist-turn 后调用；Dream extraction 已覆盖 explicit native heuristic 与 provider-backed JSON Memory Operations，且 provider prompt 已包含当前 Memory Notes / MEMORY.md / SOUL.md / USER.md context；后续补 consolidation/profile hooks |
| 12 | active | [ts_knowledge_rag_migration_design.md](ts_knowledge_rag_migration_design.md) | 先做 TS types/formatting/tool bridge 和 sparse retrieval | Phase 1 tool/formatting contract is in place. Phase 2 now has Rust `WorkerKnowledgeRpc`, `knowledge.read/write` capabilities, JSONL `documents/chunks` persistence, document CRUD, markdown-section parent chunks, child retrieval chunks, sparse `knowledge.query` returning parent context with matched child snippets, a native `knowledge.stats` readiness/count payload, and `knowledge.context` model-facing `[RELEVANT KNOWLEDGE]` context consumed by TS `NativeContextBridge`/`ContextBuilder`; Phase 3 session temporary knowledge now exposes native `knowledge.session_upload`, `knowledge.session_list`, and `knowledge.session_clear` aliases over the session upload store, TS WebUI temporary-file list/upload/clear now consumes the Knowledge session RPC surface, and the desktop gateway facade prefers the native clear route with HTTP fallback; `query_rag` remains as a workspace-file compatibility alias. |
| 13 | active | [ts_mcp_runtime_migration_design.md](ts_mcp_runtime_migration_design.md) | 接入 MCP 外部动态工具层 | Started MCP runtime migration: Phase 1 config/schema contract normalizes server settings, transport auto-detection, allowlists, wrapped names, and nullable JSON Schema; Phase 2 has `mcpToolWrapper`; Phase 3 now has a fake-client `McpRuntimeManager` plus a native MCP bridge enabled in the real TS worker entrypoint that discovers native fixture tools through `mcp.list_tools`, registers dynamic `mcp_<server>_<tool>` wrappers before runs, reports skipped/unmatched/failed/collision diagnostics, preserves high-risk approval, forwards approved calls to `mcp.call_tool`, tolerates discovery failures without blocking normal runs, replaces MCP registrations on reconnect while preserving non-MCP tools, reconnects native MCP discovery after WebUI config patches update MCP server fields, applies configured MCP allowlists/timeouts to native discovery results, and exposes latest MCP discovery diagnostics through TS `/api/status`. |

### Batch 5: Commands, Background Work, And Cowork

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 14 | active | [ts_command_cli_runtime_migration_design.md](ts_command_cli_runtime_migration_design.md) | 先接 `CommandRouter` 和基础命令 | Continued Command Runtime Phase 1/3: `/help`, priority `/stop`, priority `/status`, priority `/restart`, exact `/new`, exact `/approvals`, prefix `/approve`, prefix `/deny`, exact `/dream`, prefix `/dream-log`, and prefix `/dream-restore` now run inside AgentWorker before provider execution. `/new` has a native `session.clear` bridge, clears native session temporary knowledge, and captures clear-before session user/assistant messages into native conversation evidence so Dream/provider extraction can still process cleared conversation content; approvals use native `approval.list_pending` / `approval.resolve`; `/status`, `/restart`, `/approvals`, and Dream commands return command-specific failure text when their native bridges raise; Dream commands use the provider-backed native Dream bridge; Rust `memory.dream_log` now reads git-backed native memory history, Rust `memory.dream_restore` now lists recent Dream commits and creates safety revert commits for selected changes, Rust `memory.dream_run` handles no-work/explicit heuristic/deferred states, and deferred `/dream` batches now route through the TS provider with Python-compatible JSON Memory Operations plus current memory context before native apply. Full provider-backed `/new` summary archive remains later. |
| 15 | active | [ts_task_cron_background_runtime_migration_design.md](ts_task_cron_background_runtime_migration_design.md) | 迁移 task/cron/background agent turn | Started Task/Cron background migration with the pure TS Task foundation: Python-compatible task/subtask status types, snake_case plan normalization, DAG validation, ready-subtask/completed/blocked checks, Python-shaped progress payloads, a native TaskStore bridge contract for `task.store.load` / `task.plan.*`, a local TaskRuntime for list/progress/pause/cancel/delete/add/remove/update state operations, Rust native task store RPCs backed by `plans/store.json` with `task.read`/`task.write` capabilities, a model-facing TS `task` tool registered in the native worker for list/status/progress/pause/cancel/delete/add/remove/summary actions, provider-backed TS task planning through `submit_plan` with fallback single-subtask creation and native store persistence, TS `SubagentRuntime` concurrency/session/timeout/completion callback management around AgentRunner-backed restricted-tool subtask execution for `resume`/completion chaining, Python-compatible completed-plan summaries, a TS `cron` tool/bridge for add/list/remove over native `cron.job.*` RPCs, Rust native cron store RPCs backed by `cron/jobs.json` with `cron.read`/`cron.write` capabilities, a TS worker `cron.run_due` execution contract that runs due `agent_turn` jobs through AgentRunner using Python-style scheduled-task prompts, native `cron.job.due` / `cron.job.record_runs` store mutation RPCs with Python-compatible `lastStatus` / `runHistory` state and one-shot cleanup, a native host `worker_cron_dispatch_due` command that selects due jobs, calls TS `cron.run_due`, and records run outcomes, a Rust host cron timer loop that wakes on the earliest enabled job with capped polling and skips overlapping dispatches, active task subagent cancellation through plan metadata, abort signals, AgentRunner cancellation checks, and paused-plan completion guards, a capability-gated Rust background registry with TS subagent queued/running/completion emission over native RPC, native task completion notifications appended to the owning session through `session.append_messages`, background task progress worker events emitted for resume/subtask completion chaining, and persistent task progress cards upserted to the owning session through `session.task_progress.upsert` without appending duplicate per-plan cards. |
| 16 | active | [ts_cowork_runtime_migration_design.md](ts_cowork_runtime_migration_design.md) | 先做 snapshot/store/blueprint/mutations/mailbox | Started Cowork runtime migration with pure TS blueprint normalization/validation/preview, Python-compatible architecture aliasing, default agents/tasks/routes, budget normalization/clamping, graph preview, ready-work projection, and worker RPCs for `cowork.validate_blueprint` / `cowork.preview_blueprint`. Phase 1 TS session types, legacy store serde/default hydration, `hybrid` -> `adaptive_starter` normalization, default branch repair, shared-memory normalization, `NativeCoworkStoreBridge` for `cowork_store.*` RPCs, and read-only `coworkSessionSnapshot()` with desktop-compatible graph/trace/task DAG/artifact index projection are now in place. Phase 2 architecture helpers and projection-only default policy registry now resolve adaptive/team/generator-verifier/message-bus/shared-state/swarm policies and feed snapshot topology/projection. CoworkService mutations, mailbox, scheduler, and agent runtime remain follow-up work. |

Cowork row 16 update: Phase 3 now has a minimal TS `CoworkService` for Python-style create/list/get/delete, default agent tools/subscriptions, kickoff thread/message/lead inbox, `session.created` trace/event, blueprint compile materialization, memory-store tests, `AgentWorker` RPC handling for `cowork.list_sessions` / `cowork.get_session` / `cowork.create_session` / `cowork.delete_session`, and real server wiring through `NativeCoworkStoreBridge`. It now also covers `send_message`, `add_task`, `assign_task`, `retry_task`, `request_task_review`, `pause_session`, `resume_session`, `emergency_stop_session`, `update_budget`, `derive_branch`, `select_branch`, `select_branch_result`, and `merge_branch_results` service mutations plus worker RPCs with message inbox wakeups, task events, retry reset/wakeup behavior, review task reuse/creation, session/branch pause-resume state, emergency stop agent steps/stop reason, budget-state recalculation, branch state capture, branch result creation, stage records, selected final results, merged final candidates, and task/review/scheduler/branch/final-result events. Phase 4 has started with `CoworkMailbox.deliver()` and `CoworkService.deliverEnvelope()` covering Python-aligned lead/group/direct routing, message-bus subscription routing, delivered mailbox records, message/thread creation, wake/reopen rules, multi-recipient reply lifecycle, and active duplicate detection; `markMessagesRead()` / `expireRecords()` plus service persistence now cover inbox clearing, read receipt projection, and unanswered deadline expiration events; `escalateStaleBlockers()` now marks stale blockers once, targets reviewer-like agents before the lead, emits escalation messages, and records `mailbox.stale_blocker` events. `AgentWorker` now exposes matching mailbox lifecycle RPCs for `cowork.deliver_envelope`, `cowork.mark_messages_read`, `cowork.expire_mailbox_records`, and `cowork.escalate_stale_blockers`. Phase 5 read-only facade coverage now has TS service/worker RPCs for `cowork.export_blueprint`, `cowork.get_graph`, `cowork.get_trace`, `cowork.get_agent_activity`, `cowork.get_observation_detail`, `cowork.get_summary`, `cowork.get_dag`, `cowork.get_artifacts`, `cowork.get_organization`, and `cowork.get_queues`, using the persisted session snapshot as the source of truth. Work-unit lifecycle now has TS service/worker RPCs and route bridge support for `retry_work_unit`, `skip_work_unit`, and `cancel_work_unit`, including source task updates, Python-style result text, readiness recalculation for retried units, events/trace spans, and persisted snapshot writes. Phase 5 route bridge now has Worker `cowork.route_request` mapping Python-compatible `/api/cowork/...` calls for blueprint preview/validate/export, session create/list/get/delete, message/task creation, desktop `blueprint: null` create payloads, pause/resume/emergency-stop/budget controls, task assign/retry/review actions, work-unit retry/skip/cancel actions, agent activity, observation detail, read-only graph/trace/summary/dag/artifacts/organization/queues, branch list/derive/select, branch-id derive, branch result select-final, branch-results merge, and final-result select/merge aliases into the TS service. Phase 6 now has a TS `cowork` tool facade registered in `createAgentWorkerServer`, sharing the native `CoworkService` / `NativeCoworkStoreBridge` instance and covering start/list/status/send_message/add_task/assign_task/pause/resume/summary/export_blueprint; it also has a provider-backed `CoworkTeamPlanner` using the Python-style `submit_cowork_team` tool call contract, mode guidance, deterministic coordinator fallback, reviewer injection for risky goals, and lead-start task fallback. Phase 7 now has `CoworkScheduler.runSession()` and `CoworkAgentRuntime.runAgent()` over the same store bridge: paused/completed early exits, observable idle stops, blocker stop when requested, multi-round ready-agent selection, AgentRunner-backed round execution, dependency-unlock continuation after task completion, TS `cowork_internal` injection for `send_message`, `create_thread`, `add_task`, `assign_task`, `claim_task`, `spawn_agent`, `spawn_subteam`, `retire_agent`, `update_status`, and current-task `complete_task`, progress JSON parsing, completed-task result persistence, private summary/status updates, public note message append, agent steps, agent trace spans, run metrics, scheduler decisions, `cowork.run_session` Worker RPC, tool `action=run` / `auto_run`, and native-first desktop `/run` route fallback are in place. Remaining Phase 7 work includes stream hooks, lead synthesis, budget exhaustion beyond simple max-round/agent-call stop, convergence detection, and deeper swarm-aware scheduling.

### Batch 6: Transports, Facades, And Upper-Layer Runtime

| Order | Status | Document | Goal | Notes |
| --- | --- | --- | --- | --- |
| 17 | in_progress | [ts_webui_transport_migration_design.md](ts_webui_transport_migration_design.md) | 做 bootstrap/status/session/WebSocket 最小闭环 | Bootstrap route payload contract, refresh-token, status, tools list, skills list/detail/mutations, config get, provider catalog, provider model listing, approvals list/approve/deny, Agent UI forms, workspace file routes, session-list, session-messages, session-profile, session metadata PATCH, temporary-file list/upload, session-delete, and session-clear route starting points are wired through TS worker `webui.handle_request`, native bridges where needed, Rust `worker_webui_route`, and desktop native facade fallback where payload shape permits; WebSocket outbound frame mapping now has a TS transport helper, `transport.gateway_frame` worker RPC, Rust `worker_transport_gateway_frame` command, and desktop native transport facade for legacy message/delta/stream-end/usage/browser/approval/Agent UI frames; inbound client frame mapping now has TS helpers, `transport.websocket_message` worker RPC, Rust `worker_transport_websocket_message` command, Rust dispatch into `agent.run_input` for inbound user-message frames, desktop native transport facade coverage for `new_chat`, `attach`, `message`, `interrupt`, `ping`, and file subscription intent results, plus root-WebUI same-origin `/ws` interception through a native WebSocket shim that projects TS worker content/reasoning/usage/error/done, tool-call progress, `agent_ui_event` form requests, and approval-pending events into legacy WebUI frames. |
| 18 | active | [ts_channel_bus_runtime_migration_design.md](ts_channel_bus_runtime_migration_design.md) | 迁移 channel bus | Phase 1 started with TS message envelopes, session-key selector, async inbound/outbound queues, batch/timeout consumption, close semantics, backlog diagnostics, and exported bus module surface. |
| 19 | active | [ts_api_runtime_migration_design.md](ts_api_runtime_migration_design.md) | 作为上层 facade 收口 | Phase 1 OpenAI-compatible API now has TS worker `GET /health`, `GET /v1/models`, and non-stream `POST /v1/chat/completions` parity over `webui.handle_request`, including model guard, content-array text extraction, OpenAI error/response shape, TS AgentRunner dispatch, same-session serialization, and `api.timeout` 504 handling; empty final retry/fallback is covered by the shared `AgentRunner` path. Knowledge route adapters now return Python-compatible invalid-request envelopes for graph, GraphRAG, rebuild-index, store-unavailable, malformed-body, missing-field, upload validation, document not-found, and job not-found errors, and provider exceptions are wrapped as route-specific 500 server-error envelopes. |
| 20 | active | [ts_heartbeat_runtime_migration_design.md](ts_heartbeat_runtime_migration_design.md) | 最后接背景调度和通知组合能力 | Phase 1 pure core now has heartbeat decision parsing, target selection, start/stop interval lifecycle, manual trigger, status snapshots, and tick service orchestration; Phase 2 bridge foundation routes heartbeat tasks through `AgentRunner` with `sessionId="heartbeat"` and trim/notify callbacks; TS worker exposes `heartbeat.trigger_now`, `heartbeat.status`, `heartbeat.start`, and `heartbeat.stop`; `createAgentWorkerServer()` now injects a real runtime backed by native workspace/config/session RPCs, native `session.trim` retains Python-compatible legal heartbeat history suffixes using current `keep_recent_messages`, start refreshes native `gateway.heartbeat.enabled` / `interval_s`, `/api/status` exposes heartbeat scheduler diagnostics with a config refresh before returning, TS-native `/api/config` PATCH refreshes heartbeat enabled/interval after native config-store apply, native desktop host lifecycle starts/stops TS heartbeat scheduling, and heartbeat decision prompts use the configured `agents.defaults.timezone` for Python-compatible `Current Time` text. |

Channel Bus row 18 update: Phase 5 foundation now has a reusable TS `NativeTextChannel` adapter boundary for native platform connectors, preserving `BaseChannel` allow-list/inbound normalization and exposing outbound text, stream delta, usage, and lifecycle forwarding without using the Python bridge.

Channel Bus row 18 update: Phase 5 native adapter assembly now creates `NativeTextChannel` adapters from enabled canonical channel config and host-provided connector registry, with explicit missing-connector skips for channels still served by the Python bridge during migration.

Channel Bus row 18 update: Phase 5 worker lifecycle wiring now accepts an injected native `ChannelManager` and exposes `channel.start`, `channel.status`, and `channel.stop` worker RPCs so TS-managed adapters can be started, inspected, and stopped by the native host.

Channel Bus row 18 update: Phase 5 default stdio worker lifecycle now reads canonical native config and assembles host-provided native text connectors into `ChannelManager` adapters at channel startup, preserving the empty-manager fallback when no connectors are available.

Channel Bus row 18 update: Phase 5 now has an explicit TS host-RPC connector bridge for native text adapters, so host-provided connectors can be expressed as stable `channel.connector.start/stop/send_text/send_delta/send_usage` worker-host calls while Python bridge fallback remains opt-in by absence of connectors.

Channel Bus row 18 update: Rust now accepts the `channel.connector.*` worker-host RPC contract behind a dedicated `channel.connector` capability, returning a structured `native_connector_unavailable` bridge result while real platform connectors are not yet installed.

Channel Bus row 18 update: TS host-RPC connector bridges now reject `handled: false` results, allowing `ChannelManager` to record `start_failed` / send failure diagnostics instead of reporting unavailable host connectors as running.

Heartbeat row 20 update: Phase 4 now runs scheduled notifications through the shared Python-compatible evaluator, emits approved external notifications as `heartbeat.delivery` worker events, and projects those delivery events into target native desktop chats without requiring an active agent run.

API Runtime row 19 update: direct TS-native `POST /v1/knowledge/documents` now honors `async_index` query params or true JSON body flags and returns Python-compatible completed job envelopes for deferred indexing.

API Runtime row 19 update: direct TS-native add-document validation now rejects whitespace-only content with Python-compatible invalid-request envelopes before native provider dispatch.

## Work Log

| Date | Update |
| --- | --- |
| 2026-06-14 | Continued API Runtime Knowledge validation parity: native add-document route now rejects whitespace-only content with Python-compatible 400 invalid-request envelopes. |
| 2026-06-14 | Continued API Runtime Knowledge async-add parity: native add-document route now honors `async_index` and returns Python-compatible 202 completed job envelopes. |
| 2026-06-14 | Continued API Runtime Knowledge provider-error parity: native Knowledge API provider exceptions now return route-specific 500 server-error envelopes instead of worker protocol errors. |
| 2026-06-14 | Continued API Runtime Knowledge error-envelope parity: native Knowledge API unavailable, validation, and not-found routes now share Python-compatible invalid-request envelopes. |
| 2026-06-14 | Continued API Runtime Knowledge validation parity: graph, GraphRAG, and rebuild-index invalid query errors now return Python-compatible 400 invalid-request envelopes. |
| 2026-06-14 | Continued Command Runtime bridge durability: backend slash `/status`, `/restart`, and `/approvals` now return command-specific text failures when native bridge calls raise. |
| 2026-06-14 | Continued Command Runtime `/new` archive parity: backend slash `/new` now captures clear-before session user/assistant messages through native conversation evidence before clearing the session and temporary knowledge. |
| 2026-06-14 | Continued API Runtime Phase 1 text-like upload parity: desktop Knowledge `.markdown` uploads now canonicalize to native `md` payloads instead of falling back to the HTTP/Python gateway. |
| 2026-06-14 | Continued Command Runtime status parity: backend slash `/status` now reports Python-compatible runtime status content from recent native worker usage/context snapshots. |
| 2026-06-14 | Continued WebUI transport Batch 6 upload fallback parity: desktop session temporary uploads keep extractor-dependent formats such as PDF on HTTP/Python fallback while text/Markdown uploads continue using the native route. |
| 2026-06-14 | Continued Command Runtime `/new` cleanup parity: backend slash `/new` now clears native session temporary knowledge through `knowledge.session_clear` after session reset and reports `temporary_files_cleared` metadata. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: wired injected native `ChannelManager` lifecycle through `AgentWorker` and the stdio server via `channel.start/status/stop` RPCs. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: TS host-RPC channel connectors now convert `handled: false` host responses into channel lifecycle/delivery failures. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: Rust worker-host RPC now recognizes `channel.connector.*` behind a dedicated capability and returns explicit unavailable connector results. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: added an explicit host-RPC connector bridge for native text channel start/stop/send/delta/usage operations. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: default stdio worker channel lifecycle now assembles host-provided native text connectors from canonical channel config. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: added native text channel adapter factory from enabled channel config plus connector registry, preserving Python bridge fallback for channels without native connectors. |
| 2026-06-14 | Continued Channel Bus Phase 5 foundation: added reusable TS `NativeTextChannel` connector boundary for native platform adapters with BaseChannel allow-list/inbound semantics and outbound text/delta/usage forwarding. |
| 2026-06-14 | Continued Heartbeat runtime Phase 4: native desktop listens for `heartbeat.delivery` worker events and projects approved external heartbeat notifications into the target native chat without an active run id. |
| 2026-06-13 | Continued Heartbeat runtime Phase 3 timezone parity: heartbeat provider decision prompts now derive `Current Time` from native `agents.defaults.timezone` via the shared TS current-time formatter. |
| 2026-06-13 | Continued Command Runtime Phase 3 provider-backed Dream prompt parity: native pending Dream batches now expose current Memory Notes and rendered Memory Views, and TS provider prompts consume that context before producing JSON Memory Operations. |
| 2026-06-13 | Continued Command Runtime Phase 3 provider-backed Dream extraction: `ProviderBackedDreamBridge` now handles native deferred Dream batches with provider JSON Memory Operations and native apply semantics for save/reject/supersede. |
| 2026-06-13 | Continued session turn lifecycle parity: removed duplicate pre-finalize checkpoint clearing from `AgentWorker` so `TurnLifecycle.finalizeTurn()` is the single checkpoint-clear owner for direct and resumed runs. |
| 2026-06-13 | Continued Command Runtime Phase 3 native Dream consolidation parity: Rust `memory.dream_run` now defers non-explicit pending conversation evidence and legacy history without advancing native Dream cursors, leaving those records available for provider-backed LLM summarization. |
| 2026-06-13 | Continued Channel Bus command parity: channel slash commands now dispatch through the backend command router before ordinary agent context/provider execution, so `/stop` cancels same-session active runs over `channel.dispatch_inbound`. |
| 2026-06-13 | Continued Channel Bus Phase 4 bridge diagnostics: added exported `PythonChannelBridge` ingress helper for Python inbound JSON -> TS `MessageBus` delivery with malformed payload, closed-bus, and inbound backpressure diagnostics. |
| 2026-06-13 | Continued Cowork Phase 10 final-result route parity: branch-result merge routes now apply Python route text coercion to `summary`, preserving truthy numeric JSON summaries instead of falling back to generated summaries. |
| 2026-06-13 | Continued Cowork Phase 10 branch-derive route parity: derive-branch routes now apply Python route text coercion to title, reason aliases, inherited context, architecture aliases, and body source-branch aliases before invoking the migrated TS service. |
| 2026-06-13 | Continued Cowork Phase 10 final-result select route parity: final-result select routes now apply Python route text coercion to branch and result ids before invoking the migrated TS service. |
| 2026-06-13 | Continued Cowork Phase 10 work-unit route parity: work-unit retry/skip/cancel routes now apply Python route text coercion to `reason` before invoking the migrated TS service. |
| 2026-06-13 | Continued Cowork Phase 10 message route metadata parity: message routes now apply Python route text coercion to `thread_id`, `topic`, and `event_type` before invoking the migrated TS service. |
| 2026-06-13 | Continued Cowork Phase 10 add-task route parity: add-task routes now whitelist the Python route payload boundary and keep direct worker RPC-only review/fanout/merge metadata out of HTTP route-created tasks. |
| 2026-06-13 | Continued Cowork Phase 10 task-review route parity: review-task routes now apply Python route text coercion to `reviewer_agent_id` before invoking reviewer assignment fallback. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: legacy and Vue Cowork inspectors now expose selected-agent activity actions that dispatch through the migrated native-first agent-activity facade path. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: native Vue Cowork inspector branch controls now dispatch derive-branch, select-final-result, and merge-final-result events into the existing native-first handler/facade paths. |
| 2026-06-13 | Continued session turn lifecycle evidence durability: Rust `session.persist_turn` now returns exact `saved_messages`, TS `NativeSessionBridge` normalizes them, and `TurnLifecycle` captures evidence from those messages for partial-duplicate persisted turns. |
| 2026-06-13 | Continued session turn lifecycle evidence durability: duplicate-only append fallback results now skip memory evidence capture just like native persist-turn results. |
| 2026-06-13 | Continued session turn lifecycle evidence durability: duplicate-only native persist-turn results now skip memory evidence capture instead of recording evidence for messages that were not saved. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: agent-activity desktop action requests now preserve `limit` query options for the native-first Cowork facade. |
| 2026-06-13 | Continued config/provider bridge durability: legacy native config fallback now resolves OpenAI secrets for `provider=auto` when public config snapshots are unavailable and env keys are absent. |
| 2026-06-13 | Continued Cowork internal delegation parity: spawned-agent budget exhaustion now blocks TS `cowork_internal` spawn_agent/spawn_subteam with guardrail and denial observability. |
| 2026-06-13 | Continued Cowork scheduler Python parity: budget-limit stops now emit Python-compatible budget-exhausted event types and blocked trace status in the TS scheduler. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: recipient-less swarm message fallback classification now follows the worker recipient alias precedence. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: blueprint create architecture now takes precedence over top-level mode for swarm rollout fallback classification. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: auto-run swarm session creation now follows the swarm rollout gate before scheduler routing. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: normalized swarm create aliases now follow the swarm rollout gate for Python fallback when TS swarm routing is disabled. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: nested blueprint swarm session creation now follows the swarm rollout gate for Python fallback when TS swarm routing is disabled. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: swarm-targeted session creation now follows the swarm rollout gate, preserving Python fallback when TS swarm routing is disabled. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: auto-run session creation now follows the scheduler rollout gate, preserving Python fallback when TS scheduler routing is disabled. |
| 2026-06-13 | Continued config/provider preview durability: provider-model preview can use request-scoped key/base/manual model overrides when native public config snapshots are unavailable. |
| 2026-06-13 | Continued config/provider bridge durability: legacy native config fallback now uses `provider.resolve_secret` for OpenAI secrets when env keys are absent, while keeping env keys higher priority. |
| 2026-06-13 | Continued session persistence dedupe parity: Rust `session.append_messages` and `session.persist_turn` now dedupe equivalent OpenAI `tool_calls` and TS `toolCalls` assistant messages. |
| 2026-06-13 | Continued session turn lifecycle evidence durability: append fallback persistence now reports session sizes to `TurnLifecycle`, so memory evidence capture starts at the existing session history length when `session.persist_turn` is unavailable. |
| 2026-06-13 | Continued session legal-boundary parity: Rust `session.get_history` now recognizes camelCase `toolCalls` / `toolCallId` while finding legal tool-call history boundaries. |
| 2026-06-13 | Continued session history projection parity: Rust `session.get_history` now preserves snake_case and camelCase tool/reasoning model fields for mixed native TS session records. |
| 2026-06-13 | Continued session turn lifecycle fallback parity: `TurnLifecycle.finalizeTurn()` now clears terminal checkpoints after fallback `session.append_messages` persistence when `session.persist_turn` is unavailable. |
| 2026-06-13 | Continued session turn lifecycle durability: Rust `session.append_messages` now skips duplicate user/assistant/tool messages with the same Python-compatible keys used by `session.persist_turn`. |
| 2026-06-13 | Continued config/provider native handoff parity: TS `/api/provider-models` and `provider.models.list` now forward temporary `api_key` / `api_base` overrides to live model discovery like Python settings preview. |
| 2026-06-13 | Continued session turn lifecycle durability: Rust `session.persist_turn` now skips duplicate persisted user/assistant/tool messages with Python-compatible keys and returns accurate saved/duplicate message counts. |
| 2026-06-13 | Continued MCP config contract parity: TS native MCP reconnect now applies updated `tools.mcpServers` allowlists/timeouts before registering discovered native tools. |
| 2026-06-13 | Continued MCP diagnostics durability: native MCP discovery diagnostics are cached by the TS bridge and exposed through TS `/api/status` after reconnects. |
| 2026-06-13 | Continued MCP/WebUI config hot update parity: TS-native `/api/config` PATCH now reconnects native MCP discovery when MCP server fields change, matching Python config side effects. |
| 2026-06-13 | Continued Heartbeat runtime Phase 3 config hot update: TS-native `/api/config` PATCH now refreshes the injected heartbeat runtime after native config-store apply, so heartbeat enabled/interval changes take effect on the worker without a gateway restart. |
| 2026-06-13 | Continued Heartbeat runtime Phase 3 diagnostics exposure: WebUI `/api/status` now includes heartbeat scheduler diagnostics from the injected runtime, and the native stdio server status path refreshes heartbeat enabled/interval config before returning. |
| 2026-06-13 | Continued Heartbeat runtime Phase 2 lifecycle wiring: added config-refreshable scheduling, worker `heartbeat.start` / `heartbeat.stop` protocol handlers, and native config-backed server start coverage for `enabled` / `interval_s`. |
| 2026-06-13 | Continued Heartbeat runtime Phase 2 session trimming: added native `session.trim` with Python-compatible legal suffix retention, TS `NativeSessionBridge.trimSession()`, and server wiring so heartbeat execution trims the fixed `heartbeat` session using current config. |
| 2026-06-13 | Continued Heartbeat runtime Phase 2 native server wiring: `createAgentWorkerServer()` now injects a real `HeartbeatRuntime` using native `workspace.read_file`, `config.snapshot_public`, and `session.list_metadata` RPCs, with server-level coverage for `heartbeat.trigger_now`. |
| 2026-06-13 | Continued Heartbeat runtime Phase 2 worker bridge: added TS worker protocol methods `heartbeat.trigger_now` and `heartbeat.status`, with runtime delegation and explicit unavailable-runtime error responses for native host callers. |
| 2026-06-13 | Continued Heartbeat runtime bridge foundation: added TS `HeartbeatRuntime` to compose provider heartbeat decisions, `AgentRunner` execution using the fixed `heartbeat` session, execute-target metadata, keep-recent trim callback, evaluator-gated notification, notify-target re-selection, and CLI fallback suppression. |
| 2026-06-13 | Continued Heartbeat runtime Phase 1: added TS `HeartbeatService.start()`/`stop()` interval lifecycle with Python-compatible disabled guard, first-delay scheduling, immediate timer cancellation, no-overlap scheduled ticks, and expanded scheduler status fields. |
| 2026-06-13 | Started Heartbeat runtime Phase 1: added pure TS heartbeat decision prompt/tool schema parsing, target selection with explicit enabled-channel filtering/fallback, `HeartbeatService.tick()` orchestration for missing/empty file skip, run execution, evaluator-gated notification, silencing, evaluator fail-open notify behavior, manual `triggerNow()`, and status snapshots. |
| 2026-06-13 | Continued Channel Bus Phase 3 foundation: added TS-native `ChannelRuntime` to consume inbound channel envelopes, build `AgentRunInput` with Python-compatible session keys and streaming intent, publish final/usage outbound messages, and emit fallback error replies plus diagnostics on agent failures. |
| 2026-06-13 | Continued Channel Bus Phase 2: added TS-native channel registry descriptors/default configs for WebSocket, Feishu, DingTalk, and Weixin, plus channel delivery and enabled-channel config selectors that merge Python-compatible defaults. |
| 2026-06-13 | Continued Channel Bus Phase 2: added TS-native `BaseChannel` allow-list enforcement, streaming `_wants_stream` injection, inbound message normalization/publication, and `ChannelManager` start/stop plus enabled-channel/status projection. |
| 2026-06-13 | Continued Channel Bus Phase 1: added the TS-native `ChannelManager` outbound dispatch core with ordinary/usage/delta send routing, progress/tool-hint filtering, stream delta coalescing, unknown-channel diagnostics, send retry, and final-failure diagnostics. |
| 2026-06-13 | Started Channel Bus Phase 1: added TS-native `InboundMessage` / `OutboundMessage` envelopes, Python-compatible session key derivation, async inbound/outbound `MessageBus` queues, batch/timeout consumption, close/unblock behavior, backlog diagnostics, and an exported bus module surface. |
| 2026-06-13 | Continued API Runtime Phase 1: TS worker `POST /v1/knowledge/rebuild-index?type=all` now returns a native completed aggregate job with bm25 results and explicit semantic-unavailable metadata, `kjob_rebuild_all` polling returns the same completed envelope, and desktop `knowledge.rebuildIndex("all")` prefers the native WebUI route before HTTP fallback. |
| 2026-06-13 | Continued API Runtime Phase 1: TS worker `GET /v1/knowledge/graphrag` now returns a Python-compatible empty GraphRAG index projection over native Knowledge stats and query params, and desktop `knowledge.graphrag()` prefers the native WebUI route before HTTP fallback. |
| 2026-06-13 | Continued API Runtime Phase 1: TS worker `GET /v1/knowledge/graph` now returns a Python-compatible native graph readiness/empty projection over Knowledge stats, and desktop `knowledge.graph()` prefers the native WebUI route before HTTP fallback. |
| 2026-06-13 | Continued API Runtime Phase 1: non-stream `POST /v1/chat/completions` now applies `config.api.timeout` at the TS API facade boundary, cancels the active Worker run on timeout, and returns Python-compatible OpenAI-shaped `504 {"error": ...}` responses. |
| 2026-06-13 | Continued API Runtime Phase 1: TS worker `webui.handle_request` now exposes public non-stream OpenAI-compatible `POST /v1/chat/completions`, validates single user-message/model/stream constraints with OpenAI-shaped errors, extracts multimodal text parts, runs the prompt through the existing TS `AgentRunner` path, and serializes same-session API requests by `api:<session_id>`. |
| 2026-06-13 | Started API Runtime Phase 1: TS worker `webui.handle_request` now exposes public Python-compatible `GET /health` and OpenAI-compatible `GET /v1/models`, with the model list derived from the public config default model and `tinybot` as the fallback model id. |
| 2026-06-13 | Continued API Runtime Phase 1: desktop Knowledge uploads for `.json` and `.csv` files now use the native WebUI upload route with Python-shaped async job envelopes, keeping extractor-dependent formats such as PDF on HTTP/Python fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `PATCH /api/config` now routes through TS worker `webui.handle_request`, applies TS config patch validation before the native config-store writer, and desktop `config.patch()` prefers the native WebUI route before HTTP/Python fallback. |
| 2026-06-13 | Continued Cowork Phase 10 desktop default-route coverage: desktop Cowork agent-activity and observation-detail actions now dispatch through native-first `gatewayApi.cowork` methods, and observation request construction carries the Python-compatible requester `agent_id` query parameter for sensitive detail authorization. |
| 2026-06-13 | Continued Cowork Phase 10 desktop default-route coverage: desktop Cowork controls now emit and dispatch budget update, source-branch derive, final-result select, and final-result merge actions through native-first `gatewayApi.cowork` methods. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: `buildDesktopCoworkActionRequest()` now covers budget update, source-branch derive, final-result select, and final-result merge action requests, matching the TS-native `gatewayHttpClient` Cowork facade paths. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: desktop Cowork action controls now emit blueprint, trace, DAG, artifacts, organization, queues, and branch read-only actions, and `handleNativeCoworkAction()` dispatches them through native-first `gatewayApi.cowork` methods. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: `buildDesktopCoworkActionRequest()` now covers blueprint export, trace, DAG, artifacts, organization, queues, and branch-list read-only action requests, matching the TS-native `gatewayHttpClient` Cowork facade paths. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now projects TS worker `agent.cancelled` events into legacy `interrupted` frames and suppresses dispatch-result final-message fallback after cancellation. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now projects TS worker `agent.browser_frame` events into legacy `browser_frame` frames while preserving `source_command`, matching the Python browser snapshot frame contract. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now preserves `_memory_references` and `_recent_context_references` on TS worker `agent.done` stream-end frames, matching Python WebSocketChannel and TS stream-frame metadata behavior. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now subscribes to TS worker `agent.memory_reference` and `agent.task_progress` events, projecting memory references and task progress metadata into legacy `message` frames for root WebUI renderers. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now subscribes to TS worker `agent.awaiting_form` and `agent.awaiting_approval` events, projecting form requests as legacy `agent_ui_event` frames with run/chat/session correlation and approvals as `approval_pending` frames for root WebUI consumers. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now projects TS worker `agent.tool_call.delta`, `agent.tool.start`, and `agent.tool.result` events into legacy `_progress` tool message frames with `_tool_hint` / `_tool_detail` / `_tool_result` metadata, matching the Python WebSocketChannel progress contract for root WebUI consumers. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: the desktop native WebSocket shim now subscribes to TS worker stream events, buffers run events that arrive before dispatch results bind runId to chatId, projects content/reasoning deltas plus usage/error/done into legacy WebUI frames, and avoids duplicate synthetic final frames after streamed completion. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: desktop root WebUI same-origin `/ws` connections can now be handled by a native WebSocket shim backed by `worker_transport_dispatch_websocket_message`, preserving ready/chat-created/immediate frame behavior and synthetic final message frames without opening the Python gateway WebSocket. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: Rust/Tauri now exposes `worker_transport_dispatch_websocket_message`, mapping TS inbound WebSocket message envelopes into `agent.run_input` with websocket session/chat metadata and streaming intent, while immediate transport frames still return without starting an agent run. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: Rust/Tauri now exposes `worker_transport_websocket_message`, and the desktop native transport facade can invoke the TS inbound WebSocket client-frame mapper without going through Python. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS now owns Python-compatible inbound WebSocket client-frame mapping through `transport.websocket_message`, returning immediate gateway frames, attached-chat state, and inbound user-message envelopes for Rust gateway callers. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: Rust/Tauri now exposes `worker_transport_gateway_frame` to call the TS legacy WebSocket frame mapper, and desktop has a native transport facade for invoking that command without going through Python. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: legacy WebSocket outbound frame mapping now lives in TS transport helpers with a `transport.gateway_frame` worker RPC for Rust gateway callers, covering message, delta, stream-end, usage, browser snapshot, approval pending, and Agent UI frames. |
| 2026-06-13 | Continued WebUI transport Batch 6: `POST /api/sessions/{key}/temporary-files` now routes through the TS worker, native session bridge, and Rust session RPC, with desktop FormData uploads preferring the native WebUI route before HTTP fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `POST /webui/refresh-token` now has a TS worker route spec/handler with bearer-token refresh provider support, and desktop native WebUI route headers are preserved through the Rust worker route envelope. |
| 2026-06-13 | Continued WebUI transport Batch 6: workspace file list/read/write WebUI routes now map through a TS native workspace bridge over `workspace.list_files`, `workspace.read_file`, and `workspace.write_file`, with desktop gateway workspace actions preferring native WebUI routes before HTTP fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: Agent UI form submit/cancel WebUI routes now resume TS worker checkpoints from `session_key`/`session_id` correlation and desktop gateway Agent UI form actions prefer native WebUI routes before HTTP fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /api/tools` is now exposed through TS worker route specs/handler with Python-compatible `{tools}` projection and desktop `tools.list()` native WebUI fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /api/approvals` is now exposed through TS worker route specs/handler with Python-compatible `session_key` / `chat_id` query handling and desktop `tools.approvals()` native WebUI fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: approval approve/deny control routes now resolve through the TS worker/native approval bridge with Python-compatible payload validation, scope handling, and desktop native facade fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `POST /api/provider-models` now routes through the TS worker provider model list handler with Python-compatible response keys and desktop native facade fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /api/config` now routes through the TS worker config handler, native public config snapshot bridge, and desktop native facade fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /api/providers` now routes through the TS worker provider catalog handler and desktop native facade fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /webui/bootstrap` now has a TS worker route spec and provider-injected Python-compatible bootstrap payload handler while Rust remains the HTTP token/CORS owner. |
| 2026-06-13 | Continued WebUI transport Batch 6: `GET /api/skills` and `GET /api/skills/{name}` now route through the TS worker skills bridge with desktop native WebUI facade fallback before legacy skills/http fallback. |
| 2026-06-13 | Continued WebUI transport Batch 6: skills create/update/delete/validate WebUI routes now map to the TS worker skills bridge with desktop native WebUI facade fallback before legacy skills/http fallback. |
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
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 1: added exact `/new` with TS/native `session.clear`, resetting messages, `last_consolidated`, user profile, runtime checkpoint, and last-context metadata before returning Python-compatible `New session started.` text. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 1: added exact `/approvals` with TS/native `approval.list_pending`, rendering Python-compatible session-scoped pending approvals before provider execution. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 1: added prefix `/approve` and `/deny` with TS/native `approval.resolve`, including usage, missing-approval text, once/session approval output, and denied output before provider execution. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 3: added `/dream`, `/dream-log`, and `/dream-restore` TS command contracts through an injectable Dream bridge, and expanded `/help` from the registry-backed command list; native/Python Dream backend wiring remains follow-up work. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 3 native wiring: added `NativeDreamBridge`, wired real TS worker server `/dream-log` dispatch through `memory.dream_log`, and added Rust `memory.dream_run` / `memory.dream_log` / `memory.dream_restore` RPC placeholders returning explicit text instead of unknown-method errors. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 3 native Dream log parity: Rust `memory.dream_log` now detects uninitialized Dream history like Python, reads latest/requested git memory commits, formats changed files and unified diffs, and returns `render_as: text` metadata through the existing TS `/dream-log` bridge. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 3 native Dream restore parity: Rust `memory.dream_restore` now lists recent git-backed memory versions, restores tracked memory files to the selected commit's parent, creates a new safety commit, and reports restored files through the existing TS `/dream-restore` bridge. |
| 2026-06-12 | Continued Batch 5 Command Runtime Phase 3 native Dream run state: Rust `memory.dream_run` now returns `Dream: nothing to process.` when no conversation evidence or legacy history is pending. |
| 2026-06-13 | Continued Batch 5 Command Runtime Phase 3 native Dream extraction: Rust `memory.dream_run` now consumes pending conversation evidence with explicit memory intent, writes Dream-sourced native memory notes, refreshes memory views, advances `.evidence_cursor`, and returns captured/skipped note metadata through the TS `/dream` bridge while leaving legacy history and LLM summarization as follow-up work. |
| 2026-06-13 | Continued Batch 5 Command Runtime Phase 3 native Dream legacy history extraction: Rust `memory.dream_run` now consumes pending `memory/history.jsonl` records with explicit memory intent, writes Dream-sourced native memory notes with history cursor sources, refreshes memory views, advances `.dream_cursor`, and returns captured/skipped history metadata through the TS `/dream` bridge while leaving provider-backed LLM summarization as follow-up work. |
| 2026-06-12 | Started Batch 5 Task/Cron background runtime: added pure TS task types, Python-style task plan normalization, DAG validation/ready-state helpers, completed/blocked checks, and `_task_progress`-ready progress payloads as the foundation for TaskTool/SubagentRuntime/Cron follow-up work. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added a native TaskStore bridge contract for loading/listing/getting/saving/deleting task plans with snake_case persistence mapping, plus a local TaskRuntime for progress, pause/cancel/delete, subtask add/remove, and subtask result updates. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added Rust `task.read` / `task.write` capabilities and native `task.store.load` / `task.plan.list|get|save|delete` RPCs backed by the Python-compatible `plans/store.json` task store. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added the model-facing TS `task` tool for native-store list/status/progress/pause/cancel/delete/add/remove actions, registered it in the real TS worker with `task.read`/`task.write` capabilities, and kept create/resume/summary as explicit deferred responses. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added TS `TaskPlanner` decomposition via provider `submit_plan` tool calls, fallback single-subtask creation, DAG error capture, native-store persistence through `TaskRuntime.createPlan()`, and `task action=create` progress metadata while leaving resume/subagent execution deferred. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added `TaskRuntime.resumePlan()` and `completeSubtask()` for ready-subtask spawning and chain continuation, plus a provider-backed `TaskProviderSubagentExecutor` wired into native task tools so `task action=resume` can start TS-managed subtask execution when a provider is available. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added `TaskRuntime.getPlanSummary()` and `task action=summary` with Python-compatible completed-plan gating, missing-plan errors, not-completed progress guidance, and `[subtask] result` aggregation. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added TS `cron` types, `NativeCronBridge`, and model-facing `cron` tool for Python-compatible add/list/remove validation and formatting, then registered it in the real TS worker with `cron.read`/`cron.write` capabilities over native `cron.job.*` RPCs. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added Rust native `cron.read` / `cron.write` capabilities and native `cron.job.add|list|remove` RPCs backed by the Python-compatible `cron/jobs.json` cron store, including generated job ids, `at`/`every` next-run metadata, and protected `system_event` removal behavior. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added TS worker `cron.run_due` for Rust/native dispatchers to execute due cron `agent_turn` jobs through AgentRunner with Python-style scheduled task prompts, per-job ok/error/skipped records, and batch isolation for disabled, system-event, and failed jobs. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added Rust native `cron.run` capability plus `cron.job.due` / `cron.job.record_runs`, allowing native dispatchers to select due enabled jobs, apply TS run results, maintain Python-compatible `lastStatus` / `runHistory` state, recompute recurring `every` schedules, and delete one-shot jobs after execution. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added the native host `worker_cron_dispatch_due` one-shot dispatcher that queries due jobs from the Rust cron store, sends them to TS worker `cron.run_due`, and records returned run outcomes through `cron.job.record_runs`; recurring native timer scheduling remains follow-up work. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added the Rust host cron timer loop on desktop startup, deriving the next wake from enabled native cron jobs, capping idle polling, stopping with the desktop gateway lifecycle, and guarding against overlapping manual/timer dispatches. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added TS `SubagentRuntime` for Python-style subagent queueing, max concurrency, session ownership, timeout failure callbacks, and cleanup, then routed `TaskProviderSubagentExecutor` through it so task resume no longer launches unlimited provider-backed subtasks. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: upgraded `TaskProviderSubagentExecutor` to run subtasks through `AgentRunner` when a restricted subagent tool registry is configured, and wired native task tools to provide workspace read/write, shell, and approval tools while excluding recursive task/cron/spawn tools. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: wired active task subagent cancellation from `task action=cancel` through `TaskRuntime.cancelPlan()`, plan-metadata `SubagentRuntime` aborts, `AgentRunner` cancellation checks, and paused-plan completion guards so queued/running subtasks stop without resuming cancelled plans. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added `background.read` / `background.write` capabilities, Rust `background.run.list|upsert|complete` registry RPCs backed by `background/registry.json`, and a TS `NativeBackgroundRegistryBridge` wired into native task subagents so queued/running/completed subagent state is emitted to the Rust background registry. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added TS task completion notification delivery through `NativeTaskNotificationBridge`, appending Python-compatible internal user notifications with `_task_event` metadata to the owning session when a resumed plan finishes all subtasks. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added `TaskProgressPublisher` support so background `TaskRuntime.resumePlan()` and `completeSubtask()` emit `agent.task_progress` worker events for started/completed/failed/skipped subtasks with Python-shaped progress payloads. |
| 2026-06-12 | Continued Batch 5 Task/Cron background runtime: added Rust `session.task_progress.upsert` and TS `NativeTaskProgressCardBridge` so task progress updates replace the owning session's per-plan progress card while keeping `agent.task_progress` worker events. |
| 2026-06-12 | Started Batch 5 Cowork runtime migration: added pure TS Cowork blueprint normalize/validate/preview support and exposed `cowork.validate_blueprint` / `cowork.preview_blueprint` through the TS worker for native/Rust callers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 1: added TS Cowork session/store types, legacy `store.json` serde/default hydration, defensive branch/current-branch repair, shared-memory normalization, and a `NativeCoworkStoreBridge` contract for `cowork_store.list/read/write/append_event/read_events/ensure_session_workspace/delete_session` RPCs. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 1: added read-only TS `coworkSessionSnapshot()` plus graph, trace, task DAG, artifact index, budget, branch, and non-verbose privacy projection; verified snapshots can feed existing desktop Cowork session row/cockpit builders. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 2: added TS architecture normalize/label/fallback diagnostics plus projection-only `ArchitecturePolicyRegistry` for adaptive starter, agent team, generator-verifier, message bus, shared state, and swarm; `coworkSessionSnapshot()` now consumes policy topology and organization projection instead of hard-coded placeholders. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3: added minimal TS `CoworkService` create/list/get/delete and blueprint session materialization over the store bridge, including default CRUD tools, kickoff thread/message, lead inbox, `session.created`/`blueprint.compiled` event+trace records, deterministic memory-store tests, and strict blueprint layout narrowing for service compilation. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3 worker wiring: `AgentWorker` now serves `cowork.list_sessions`, `cowork.get_session`, `cowork.create_session`, and `cowork.delete_session`; the real stdio server constructs `CoworkService` over `NativeCoworkStoreBridge`, so create/list/get/delete can persist through native `cowork_store.*` RPCs. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3 mutations: `CoworkService` now supports `sendMessage`, `addTask`, and `assignTask` with Python-compatible thread membership, recipient inbox wakeups, task focus/status updates, `message.sent` / `task.created` / `task.assigned` events, and task trace spans; `AgentWorker` exposes matching `cowork.send_message`, `cowork.add_task`, and `cowork.assign_task` RPCs. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3 mutations: added `retryTask` and `requestTaskReview` to `CoworkService`, including failed/skipped/completed retry validation, owner wakeups, review-task creation/reuse, `task.retried` / `task.review_requested` events, task/review trace spans, and `AgentWorker` RPCs for `cowork.retry_task` and `cowork.request_task_review`. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3 session controls: added TS `pauseSession`, `resumeSession`, `emergencyStopSession`, and `updateBudget` mutations with session/branch status changes, emergency stop agent step projection, stop reason/budget usage updates, budget remaining calculation, `session.paused` / `session.resumed` / `scheduler.stop` / `budget.updated` events, and `AgentWorker` RPCs for the matching `cowork.*` methods. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 facade: added TS `CoworkService` read-only projections and Worker RPCs for `cowork.export_blueprint`, `cowork.get_graph`, `cowork.get_trace`, `cowork.get_agent_activity`, and `cowork.get_observation_detail`, including Python-style blueprint export metadata, snapshot-derived graph/trace payloads, bounded agent activity, and sensitive observation authorization/redaction. |
| 2026-06-12 | Started Batch 5 Cowork runtime Phase 4 mailbox: added pure TS `CoworkMailbox` and `CoworkService.deliverEnvelope()` persistence for Python-aligned recipient routing, delivered record/message/thread creation, wake/reopen behavior, multi-recipient reply tracking, active correlation/question/content dedup, mailbox events, and mailbox trace spans. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 4 mailbox lifecycle: added TS mailbox `markMessagesRead()` and `expireRecords()` plus `CoworkService.markMailboxMessagesRead()` / `expireMailboxRecords()` persistence, covering inbox clearing, message/read receipt updates, `read` mailbox status, deadline-based `expired` records, and `mailbox.expired` events. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 4 mailbox lifecycle: added TS stale blocker escalation with reviewer-first target selection, one-shot `escalated_at` marking, escalation follow-up messages, `mailbox.stale_blocker` events, and `CoworkService.escalateStaleBlockers()` persistence. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 4 worker exposure: added `AgentWorker` RPCs for `cowork.deliver_envelope`, `cowork.mark_messages_read`, `cowork.expire_mailbox_records`, and `cowork.escalate_stale_blockers`, including envelope parsing and service-backed persisted session results. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 3 branch/final-result mutations: added TS service and Worker RPC support for `cowork.derive_branch`, `cowork.select_branch`, `cowork.select_branch_result`, and `cowork.merge_branch_results`, including Python-aligned source branch state capture, branch result creation, stage records, selected final results, merged final candidates, and persisted events. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 read-only facade: added TS service and Worker RPC support for `cowork.get_summary`, `cowork.get_dag`, `cowork.get_artifacts`, `cowork.get_organization`, and `cowork.get_queues`, all projected from the persisted `coworkSessionSnapshot()` contract for future API route bridging. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 route bridge: added Worker `cowork.route_request` for Python-compatible `/api/cowork/...` request shapes, covering blueprint preview/validate, session create/list/get/delete, message/task creation, read-only summary/graph/trace/dag/artifacts/organization/queues, and branch derive/select paths over the TS `CoworkService`. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 route bridge: expanded Worker `cowork.route_request` to match desktop `buildDesktopCoworkActionRequest()` paths for `blueprint: null` session creation, pause/resume/emergency-stop controls, task assign/retry/review actions, agent activity, observation detail, branch select, branch result select-final, and branch-results merge over the TS `CoworkService`. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 native desktop bridge: added Rust/Tauri `worker_cowork_route`, a `desktopNativeCowork` wrapper that unwraps Worker route envelopes, and gateway-client native-first dispatch for migrated Cowork routes while keeping `/run` and work-unit routes on the Python gateway fallback. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 route bridge: filled remaining non-run Python API compatibility paths for `GET /blueprint`, `GET /branches`, `POST /budget`, and `POST /branches/{branch_id}/derive` through Worker `cowork.route_request` over the TS `CoworkService`. |
| 2026-06-12 | Continued Batch 5 Cowork runtime work-unit lifecycle: added TS `CoworkService` and Worker route support for `retry_work_unit`, `skip_work_unit`, and `cancel_work_unit`, including Python-compatible API responses, associated task state updates, readiness recalculation, and persisted session snapshots. |
| 2026-06-12 | Continued Batch 5 Cowork runtime native desktop bridge: switched desktop `workUnitAction()` to the native-first `worker_cowork_route` path now that work-unit retry/skip/cancel are served by the TS Cowork route bridge; `/run` remains on Python fallback. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 5 route bridge: added Worker `cowork.route_request` aliases for `POST /api/cowork/sessions/{session_id}/final-result/select` and `/final-result/merge`, reusing the TS final-result selection and branch-result merge service paths described in the Cowork migration design. |
| 2026-06-12 | Started Batch 5 Cowork runtime Phase 6 tool facade: added a TS `cowork` tool facade for start/list/status/send_message/add_task/assign_task/pause/resume/summary/export_blueprint over `CoworkService`, registered it in the native worker with shared `NativeCoworkStoreBridge` persistence, and left `run` explicitly deferred until scheduler/agent runtime migration. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 6 team planner: added TS `CoworkTeamPlanner` with provider `submit_cowork_team` tool-call planning, mode guidance, deterministic coordinator/reviewer fallback, lead-start task fallback, and native worker injection for goal-only `cowork action=start` calls. |
| 2026-06-12 | Started Batch 5 Cowork runtime Phase 7 scheduler: added `CoworkScheduler.runSession()` with paused/completed/idle stop persistence, scheduler decisions, run metrics, trace spans, `cowork.run_session` Worker RPC, `cowork action=run` / `auto_run` support, and native-first desktop `/run` routing with Python fallback for native errors. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 agent runtime: added `CoworkAgentRuntime.runAgent()` with AgentRunner-backed one-round execution, task selection, inbox read marking, progress JSON parsing, completed-task persistence, agent state/private summary updates, public-note message append, agent step/trace observability, and scheduler ready-agent execution through the real native store bridge. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 scheduler: expanded `CoworkScheduler.runSession()` from one AgentRunner-backed round to a multi-round loop that reselects ready agents after each persisted agent result, unlocks dependent tasks after completed-task progress, records per-round decisions/spans, and honors max-round plus agent-call limits. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 scheduler: added `stopOnBlocker` handling before agent selection, stopping with `blocker` when unresolved mailbox reply blockers, review blockers, or fanout blockers are visible and recording the blocker decision in scheduler stop events. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 scheduler: added configured session budget exhaustion checks before agent selection, matching Python's total agent-call/tool/token/cost/wall-time/work-unit stop reasons and preserving run metrics without invoking AgentRunner. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 scheduler: added Python-aligned progress signatures, `scheduler.no_progress` events, and `convergence` stop handling after consecutive no-progress rounds without counting trace, agent-step, status, or private-summary churn as progress. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 scheduler: added lead synthesis after teammate replies are ready, including Python-aligned lead request/reply correlation checks, `scheduler.lead_synthesis` events, an extra lead AgentRunner call, and run metric agent-call accounting. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 streaming: added per-run AgentRunner stream event hooks and TS `agent.stream` projection for websocket/main_chat Cowork rounds, persisting public content deltas plus terminal completion events while excluding reasoning/tool-call/private-note data. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: added TS `coworkInternalTool.ts` and inject `cowork_internal` into `CoworkAgentRuntime` rounds for agent-owned `complete_task`, including persisted task result/status, structured result parsing, confidence/artifact/shared-memory projection, task trace spans, `task.completed` / `task.failed` events, tool metadata, and temporary registry cleanup after each round. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `send_message` and `add_task`, allowing AgentRunner tool calls to persist agent-authored messages, wake recipients, create follow-up tasks with dependencies, and emit `message.sent` / `task.created` events during a cowork round. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `assign_task` and `update_status`, including assignee wake messages, `task.assigned` events, and `agent.status` persistence from AgentRunner tool calls. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `claim_task`, including shared-task claiming, claim conflict events, task trace spans, dependency-ready selection, and persisted task ownership from AgentRunner tool calls. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `create_thread`, including filtered participant lists, persisted thread records, `thread.created` events, and AgentRunner tool-call responses. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `retire_agent`, including retired agent lifecycle/status persistence, delegated-task retirement, `agent.retired` events, and agent trace spans. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `spawn_agent`, including delegated task/brief creation, isolated sub-agent context records, spawned-agent budget usage, `agent.spawned` events, and agent trace spans. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 internal tools: extended TS `cowork_internal` with `spawn_subteam`, including batched temporary agent creation, source event linkage, fanout task creation, kickoff messages, spawned-agent budget usage, and `subteam.spawned` events. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 streaming: added TS mailbox draft stream projection for streamed `cowork_internal send_message` tool-call arguments, emitting Python-compatible `mailbox.stream` delta/terminal events with recipient/topic/reply metadata while exposing only incremental message content. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 observation hooks: forwarded AgentRunner tool start/result events to per-run hooks and added TS Cowork tool observation projection with parameter summaries, result summaries, full observation details, and `cowork.observation.available` events on agent steps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 observation hooks: added Python-aligned browser observation and sensitive artifact projection for URL/browser-like tool events, including redacted localhost/file resource details, linked artifact refs, and agent-step browser observation records. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm scheduling: added Python-aligned ready work-unit fair ordering by workstream for swarm sessions, so scheduler decisions select bounded parallel agents across workstreams and record work-unit/workstream candidate metadata. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm scheduling: added AgentRunner-backed swarm work-unit lifecycle projection, so selected source tasks start their associated work unit, agent steps link `work_unit_id`, completed task progress syncs work-unit result/evidence/risks/confidence, and swarm trace spans record work-unit start/completion. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm reducer gate: added scheduler-side reducer task/work-unit scheduling once base swarm work units finish, including source-work-unit linkage, reducing plan state, completion decision metadata, scheduler event/trace records, and handoff to existing AgentRunner-backed ready selection. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm reducer result processing: reducer task completion now stores `final_draft`, normalizes source work-unit/artifact links, projects coverage/confidence metadata back to the reducer unit, handles missing-work reopen events, and schedules reviewer task/work-unit gates when swarm review is required. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 reviewer verdict handling: reviewer `needs_revision` results now normalize review issues/follow-up units, reopen the swarm plan, create bounded revision work units linked to reviewer/source units and artifact refs, and record reviewer verdict plus replanned work-unit traces. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 reviewer verdict handling: added reviewer `pass` and `blocked` state coverage, including completed/blocked swarm plan transitions, review result normalization, `review_blocked` stop/budget projection, scheduler stop events, and reviewer verdict traces. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation blockers: added TS evaluation projection for goal coverage, safety policy, and budget state after reviewer verdicts, storing `runtime_state.swarm_evaluations` and emitting evaluation trace spans so `review_blocked`/budget blockers become observable in native snapshots. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm replan loops: completed non-follow-up swarm work units now turn `missing_work` and `open_questions` signals into deduplicated follow-up tasks/work units, preserving source work-unit linkage, dependency readiness refresh, tool allowlists, scheduler events, and replan trace spans. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm split replanning: failed broad work units now sync failed task/unit state from AgentRunner progress and create a two-step revision plan for narrowing scope then completing the reduced scope, with source linkage, dependency readiness, tool allowlists, events, and replan trace spans. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation coverage: added TS workstream coverage evaluation so reducer outputs that omit completed workstreams produce warning evaluations with missing-workstream issues and recommended citation/coverage actions. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation coverage: added TS evidence coverage evaluation so reducer outputs that synthesize completed work units without `source_work_unit_ids` produce a warning and `add_source_work_unit_ids` recommendation. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation coverage: added TS uncited-claims evaluation from reducer findings/decisions/risks and reviewer `uncited_claims`, producing warning evaluations with source work-unit/artifact citation recommendations. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation coverage: added TS conflict detection evaluation for task-level conflicts/disagreements, low-confidence completed tasks, and multi-author conflict-like claims, producing blocking evaluations with `resolve_conflicts` recommendations. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 7 swarm evaluation coverage: added TS artifact validation evaluation so artifact-like goals without indexed artifacts block completion, reducer outputs are checked for required artifact refs, and reviewer artifact issues produce citation warnings. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 projection hardening: added TS `swarm_organization` and `large_swarm_summary` snapshot projections for large swarm fixtures, including workstream clustering, grouped counts, gate summaries, blocker summaries, sample work-unit ids, and the Python-compatible render limit. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 event-log replay hardening: `NativeCoworkStoreBridge.readEvents()` now normalizes Python `cowork.event_log.v1` JSONL records into TS `CoworkEvent` objects while preserving already-normalized event payloads. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout gates: added desktop gateway-client `tsCoworkRuntime` gate controls for Cowork read-only snapshot, mutation, scheduler, and swarm route groups with Python fallback preserved by default. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout gates: wired `desktop.tsCoworkRuntime` into TS/Python config defaults and desktop gateway-client startup synchronization, so persisted rollout settings control native Cowork routing conservatively by default. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 event-log replay/recovery: `CoworkService` now replays missing native event-log events into loaded snapshots and recovers interrupted pending/running trace spans to failed state on load, matching Python reload behavior for partial runtime exits. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 trace replay: `NativeCoworkStoreBridge` now separates Python `category=trace` event-log records from user-facing events and exposes replayable trace spans; `CoworkService` merges missing trace spans into loaded snapshots with Python-compatible de-duplication and retention. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 observation replay: `NativeCoworkStoreBridge` now separates Python `category=observation` agent-step records from user-facing events and exposes replayable agent steps; `CoworkService` merges missing agent steps into loaded snapshots with Python-compatible de-duplication and retention. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 observation replay: added Python event-log replay for `tool_observation.recorded`, keeping user-facing events clean while restoring missing tool observations onto loaded agent steps by `step_id` with duplicate suppression. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 observation replay: added Python event-log replay for `browser_observation.recorded`, restoring missing browser observations onto loaded agent steps by `step_id` with duplicate suppression while preserving detail refs, artifact refs, and sensitive/redacted metadata. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 9 observation replay hardening: `NativeCoworkStoreBridge` can now extract observation detail and sensitive artifact payloads from observation event-log records, and `CoworkService` merges missing detail/artifact maps on load without overwriting snapshot-owned records. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout: switched desktop TS/Python config defaults and gateway-client fallback defaults to TS-first Cowork routing for read-only, mutation, scheduler, and swarm route groups while keeping Python fallback enabled and preserving explicit per-gate disable controls. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 desktop route coverage: expanded the desktop gateway Cowork facade to expose migrated blueprint export, trace, DAG, artifacts, organization, queues, branch listing/derive, budget update, and final-result select/merge routes through the same native-first TS rollout path. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: TS `cowork.route_request` now accepts both current Python `POST /api/cowork/sessions/{session_id}/budget` and documented `PATCH /api/cowork/sessions/{session_id}/budget` budget updates over the same `CoworkService.updateBudget()` path. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 swarm route parity: recipient-less `POST /api/cowork/sessions/{session_id}/messages` requests for swarm sessions now use TS `CoworkService.steerSwarm()`, routing user steering to the lead, recording `swarm_plan.user_steering`, and emitting `swarm.user_steered` event/trace data like Python. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: `POST /api/cowork/sessions/{session_id}/messages` now rejects blank content with Python-compatible `400 {"error":"content is required"}` instead of persisting an empty TS message. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: `POST /api/cowork/sessions/{session_id}/tasks` now rejects blank titles with Python-compatible `400 {"error":"title is required"}` instead of creating a default untitled TS task through the HTTP route. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: `POST /api/cowork/sessions/{session_id}/tasks/{task_id}/assign` now returns Python-compatible 400 API responses for missing assignees instead of surfacing a worker protocol error. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: read-only observability routes now return Python-compatible HTTP status codes for missing agent activity, unavailable observation details, and unauthorized sensitive observation details while keeping the TS route body shape aligned. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: read-only graph, DAG, artifacts, organization, and queues routes now expose Python-compatible response keys while preserving existing TS route aliases for desktop callers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: delete-session and final-result select/merge route errors now return Python-compatible 404/400 responses with `error` payloads instead of successful TS service result wrappers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: missing-session route requests now return Python-compatible `404 {"error":"cowork session not found"}` responses for direct session reads and migrated service-backed detail routes instead of worker protocol failures. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: task retry/review route business errors now return Python-compatible 400 responses instead of successful TS service wrappers or worker protocol failures. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: branch listing now uses the Python-compatible missing-session error payload, and budget route requests reject non-object `budgets` payloads with `400 {"error":"budgets must be an object"}` before mutating session state. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: branch select, branch derive, and branch-scoped final-result selection now translate TS service business errors into Python-compatible 404/400 route responses instead of successful result wrappers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: session list route now returns Python-compatible non-verbose Cowork snapshots instead of raw persisted sessions, preserving list privacy for messages, trace spans, and agent private summaries. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: session detail route now returns the verbose Python-compatible Cowork snapshot projection, including array-shaped agents/messages plus graph and trace payloads, instead of raw persisted maps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout coverage: desktop gateway routing now treats work-unit, branch-result, and final-result routes as swarm-gated so `swarm=false` cleanly falls back to the Python gateway instead of using native TS. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: send-message success responses now include a Python-style `result` string and verbose snapshot session payload instead of exposing the raw persisted session map. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: add-task success responses now include a Python-style `result` string and verbose snapshot session payload while keeping the created task available for desktop callers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: task assign, retry, and review success responses now return Python-compatible result/review payloads with verbose snapshot sessions instead of raw persisted session maps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: work-unit retry, skip, and cancel route success responses now return Python-compatible result payloads with verbose snapshot sessions instead of raw persisted session maps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 fallback shrink: desktop TS Cowork runtime defaults now set `fallbackToPython=false` across gateway client, TS config schema, and Python config schema while preserving explicit opt-in fallback. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: `/api/cowork/sessions/{session_id}/run` now returns Python-compatible `result` plus verbose snapshot/null `session` payloads instead of raw scheduler session maps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: pause, resume, and emergency-stop session control routes now return Python-compatible result/agent-step payloads with verbose snapshot sessions. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: session summary routes and the agent-facing `cowork summary` tool now return Python-compatible markdown summary strings instead of structured TS summary objects. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: session creation routes now return Python-compatible `result` plus verbose snapshot sessions and blueprint validation error payloads instead of raw TS service session maps. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: final-result select and branch-result merge routes now return Python-compatible `session_final_result` payloads with verbose snapshot sessions instead of raw TS service wrappers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: branch derive/select routes now return Python-compatible branch snapshots and verbose session snapshots instead of raw TS service wrappers. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 swarm route parity: recipient-less swarm message steering now returns Python-compatible result plus verbose snapshot session payloads instead of raw TS service sessions. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: budget update routes now return Python-compatible budget payloads with verbose snapshot sessions instead of raw TS service sessions. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: task assign/retry error responses now keep Python-compatible result payloads while returning verbose snapshot sessions instead of raw TS service sessions. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout gates: blueprint validate/preview routes are now classified as read-only native TS routes, so disabling mutation routes no longer sends pure blueprint validation back to Python. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout gates: recipient-less message routes are now classified under the swarm gate while directed messages remain mutation routes, so disabling swarm routing cleanly falls back to Python for user steering. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 rollout gates: branch derivation requests targeting `swarm` architecture are now classified under the swarm gate while non-swarm branch derivations remain mutation routes. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: session list route query parsing now accepts Python-compatible `include_completed=1/yes/true` aliases and trims `origin_chat_id` on both query and session runtime state. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: run-session route parsing now accepts Python-compatible `parallel_width` as a `max_agents` alias before dispatching to the TS scheduler. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: create-session route parsing now accepts Python-compatible `architecture` and `mode` aliases for `workflow_mode`. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: create-session routes with `auto_run=true` now dispatch the newly created TS session through the native Cowork scheduler before returning the snapshot. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: create-session routes without `goal` or `blueprint` now return Python-compatible `400 {"error":"goal is required"}` instead of a worker protocol failure. |
| 2026-06-12 | Continued Batch 5 Cowork runtime Phase 10 route parity: create-session routes with non-object bodies now return Python-compatible `400 {"error":"invalid json body"}` instead of falling through to missing-goal validation. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 route parity: routes backed by Python `_json_body()` now reject non-object TS `cowork.route_request` bodies with Python-compatible `400 {"error":"invalid json body"}` for blueprint validation, message/task mutations, assign-task, budget updates, and related JSON-body actions. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 route parity: TS `cowork.route_request` now returns Python-compatible HTTP `503 {"error":"cowork is not available"}` when the Cowork service is absent instead of surfacing a worker protocol error. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 route parity: branch-scoped derive and select-final routes now reject explicit non-object `cowork.route_request` bodies with Python-compatible `400 {"error":"invalid json body"}` while preserving the TS bridge's empty-body business-error compatibility. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 route parity: branch-result merge routes now return Python-compatible route-level `400 {"error":"branch_ids must be a list"}` when `branch_ids` is missing or not a list instead of surfacing a worker protocol parameter error. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 route parity: TS work-unit retry/skip/cancel route errors now return Python-shaped payloads with snapshot sessions instead of leaking raw Cowork session state on 400 responses. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 desktop facade coverage: gateway `cowork.agentActivity()` now forwards Python-compatible `limit` query parameters through the default native TS route path so desktop observability panels can request bounded activity without falling back to Python. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 desktop facade coverage: gateway `cowork.observation()` now forwards Python-compatible requester `agent_id` query parameters through the default native TS route path so sensitive observation authorization can stay on the migrated Worker route. |
| 2026-06-13 | Continued Batch 5 Cowork runtime Phase 10 desktop facade coverage: gateway `cowork.updateBudget()` can now explicitly dispatch documented `PATCH /budget` requests through the default native TS route while preserving the existing Python-compatible POST default. |
| 2026-06-13 | Started Batch 6 WebUI transport migration: TS worker now exposes `webui.route_specs` and Python-compatible `webui.handle_request` for `GET /api/status`, Rust exposes `worker_webui_route`, and desktop `runtime.status()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS worker now exposes Python-compatible `GET /api/sessions` through native session metadata, and desktop `sessions.list()` prefers the native TS WebUI route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS worker now exposes Python-compatible `GET /api/sessions/{key}/messages`, serializes visible session messages with the WebUI metadata allowlist, filters internal Agent UI/task messages, and desktop `sessions.messages()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS worker now exposes `POST /api/sessions/{key}/clear` through native `session.clear`, returning Python-compatible `key`/`cleared` plus native lifecycle counts, and desktop `sessions.clear()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: Rust native session RPC now exposes `session.delete`, TS worker maps Python-compatible `DELETE /api/sessions/{key}` through that bridge with 404 for missing sessions, and desktop `sessions.delete()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS worker now exposes Python-compatible `GET /api/sessions/{key}/profile` through native session metadata, and desktop `sessions.profile()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: Rust native session RPC now exposes `session.patch_metadata`, TS worker maps Python-compatible `PATCH /api/sessions/{key}` metadata updates through that bridge, and desktop `sessions.patch()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS worker now exposes Python-compatible `GET /api/sessions/{key}/temporary-files` through native session metadata, and desktop `sessions.temporaryFiles()` prefers the native TS route with HTTP/Python fallback preserved. |
| 2026-06-13 | Continued Batch 6 WebUI transport migration: TS-native workspace file `PUT /api/workspace/files/{path}` now preserves Python-compatible `expected_updated_at` optimistic concurrency through the native workspace bridge, with Rust returning version-conflict errors before overwriting stale files. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: desktop branch-derive rollout gating now follows Python's target precedence of `target_architecture` / `architecture`, so unrelated `workflow_mode` aliases no longer force non-swarm derive requests onto the Python fallback when TS swarm routing is disabled. |
| 2026-06-13 | Continued Cowork Phase 10 desktop/native route parity: desktop native-first Cowork route calls now split query parameters into Rust's structured `query` field while keeping HTTP fallback URLs unchanged, so migrated observability/list routes use the same explicit query envelope as `worker_cowork_route`. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: desktop create-session swarm gates now match Python's `architecture` / `workflow_mode` precedence for non-blueprint creates, keeping architecture-overridden non-swarm starts on the TS-native route while preserving Python fallback for architecture-overridden swarm starts when TS swarm routing is disabled. |
| 2026-06-13 | Continued Cowork Phase 10 rollout parity: desktop auto-run swarm session creation now checks both scheduler and swarm rollout gates before using the native route, so disabling either TS run scheduling or TS swarm routing preserves the Python create-and-run fallback. |
| 2026-06-13 | Continued Cowork Phase 10 desktop route parity: desktop Cowork cockpit branch rows now fall back to Python/TS snapshot branches and nested branch_result payloads when branch_results is absent, so branch select/derive/merge action controls retain branch IDs for native-first route dispatch. |
| 2026-06-13 | Continued Cowork Phase 10 route parity: TS-native branch derive routes now preserve Python-compatible `architecture` aliases as target architectures instead of defaulting alias-shaped requests to `adaptive_starter`. |
| 2026-06-13 | Continued Cowork Phase 10 route parity: TS-native branch derive routes now preserve Python-compatible `derivation_reason` aliases through branch, stage, and event metadata. |
| 2026-06-13 | Continued Cowork Phase 10 route parity: TS-native message routes now preserve Python-compatible `thread_id` and `topic` fields when creating new discussion threads. |
| 2026-06-13 | Continued Cowork Phase 10 route parity: TS-native message routes now deliver non-swarm API messages through mailbox envelopes with delivered records and `event_type` metadata. |
| 2026-06-13 | Continued Cowork Phase 10 mailbox parity: TS mailbox delivery now expires overdue records before delivering new envelopes. |
| 2026-06-13 | Continued Cowork Phase 10 route parity: TS-native Cowork `_json_body()` mutation routes now reject missing request bodies with Python-compatible `invalid json body` responses. |
| 2026-06-13 | Continued Channel Bus Phase 3: TS worker now exposes `channel.dispatch_inbound`, parses Python-compatible inbound envelopes, routes them through `ChannelRuntime` and the existing `agent.run_input` path, and returns outbound bus messages with camelCase and snake_case projections for native/Python bridges. |
| 2026-06-13 | Continued Channel Bus Phase 3/4 bridge setup: Rust/Tauri now exposes `worker_channel_dispatch_inbound`, builds `channel.dispatch_inbound` worker requests from generic channel envelopes, and desktop `nativeTransport.dispatchChannelInbound()` can call the native TS channel bridge. |
| 2026-06-13 | Continued Channel Bus Phase 4 bridge setup: added exported TS `pythonChannelBridge` schema helpers for Python-compatible inbound normalization and outbound snake_case projection, and made `channel.dispatch_inbound` reuse that shared bridge contract. |
| 2026-06-13 | Continued Channel Bus Phase 4 bridge setup: added a TS Python bridge ChannelAdapter factory that lets ChannelManager deliver ordinary replies, usage frames, and stream deltas as Python-compatible outbound JSON for external channel adapters. |
| 2026-06-13 | Continued Channel Bus Phase 4 parity: ChannelManager now consumes Python-compatible `tinybot_RESTART_*` restart notice markers on startup and sends the restart completion message through the target channel with the existing retry path. |

## Next Checklist

- [x] Continue session turn lifecycle evidence durability: align append fallback memory-evidence start indexes with existing session history length.
- [x] Continue Cowork Phase 3: add minimal TS `CoworkService` create/list/get/delete and blueprint materialization.
- [x] Continue Cowork Phase 3: wire `CoworkService` into worker RPCs and the native store bridge.
- [x] Continue Cowork Phase 3: add `send_message`, `add_task`, and `assign_task` service mutations and worker RPCs.
- [x] Continue Cowork Phase 3: add `retry_task` and `request_task_review` service mutations and worker RPCs.
- [x] Continue Cowork Phase 3: add pause/resume/emergency-stop/budget service mutations and worker RPCs.
- [x] Continue Cowork Phase 5: add read-only `export_blueprint`, `get_graph`, `get_trace`, `get_agent_activity`, and `get_observation_detail` service methods and worker RPCs.
- [x] Continue Cowork Phase 4: add pure TS mailbox delivery runtime with service persistence for routing/reply/dedup/wake behavior.
- [x] Continue Cowork Phase 4: add mailbox read lifecycle and deadline expiration with service persistence.
- [x] Continue Cowork Phase 4: add stale blocker escalation with service persistence.
- [x] Continue Cowork Phase 4: expose mailbox lifecycle operations through Worker RPCs.
- [x] Continue Cowork Phase 3: add branch derivation, branch selection, and final-result selection/merge service mutations and Worker RPCs.
- [x] Continue Cowork Phase 5: add summary, task DAG, artifact index, organization, and queues read-only service methods and Worker RPCs.
- [x] Continue Cowork Phase 6: add an agent-facing TS `cowork` tool facade and native worker registration for non-run service-backed actions.
- [x] Continue Cowork Phase 6: add provider-backed team planning and fallback for goal-only `cowork` starts.
- [x] Continue Cowork Phase 7: add the first TS scheduler/run slice for persisted paused/completed/idle stop reasons and native-first `/run`.
- [x] Continue Cowork Phase 7: add minimal `CoworkAgentRuntime` execution through `AgentRunner`, progress parsing, and scheduler ready-agent selection for one round.
- [x] Continue Cowork Phase 7: add multi-round scheduler continuation with dependency-unlock ready-agent reselection.
- [x] Continue Cowork Phase 7: add scheduler `stopOnBlocker` handling for unresolved mailbox/review/fanout blockers.
- [x] Continue Cowork Phase 7: add scheduler session budget exhaustion checks before agent selection.
- [x] Continue Cowork Phase 7: add scheduler no-progress tracking and convergence stop handling.
- [x] Continue Cowork Phase 7: add scheduler lead synthesis after teammate replies are ready.
- [x] Continue Cowork Phase 7: add per-run AgentRunner stream hooks and public `agent.stream` projection for websocket Cowork rounds.
- [x] Continue Cowork Phase 7: add initial `cowork_internal` injection for agent-owned `complete_task`.
- [x] Continue Cowork Phase 7: parse structured `cowork_internal complete_task` results into task result data, artifacts, shared memory, confidence, and task trace spans.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `send_message` and `add_task`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `assign_task` and `update_status`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `claim_task`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `create_thread`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `retire_agent`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `spawn_agent`.
- [x] Continue Cowork Phase 7: extend `cowork_internal` with `spawn_subteam`.
- [x] Continue Cowork Phase 7: add mailbox draft stream hooks for streamed `cowork_internal send_message` content.
- [x] Continue Cowork Phase 7: add tool observation hooks for AgentRunner-backed Cowork rounds.
- [x] Continue Cowork Phase 7: add browser observation/sensitive artifact hooks for AgentRunner-backed Cowork rounds.
- [x] Continue Cowork Phase 7: add swarm ready work-unit fair ordering by workstream to scheduler selection.
- [x] Continue Cowork Phase 7: add AgentRunner-backed swarm work-unit start/completion lifecycle sync for source tasks.
- [x] Continue Cowork Phase 7: add scheduler-side swarm reducer gate scheduling after base work units finish.
- [x] Continue Cowork Phase 7: process completed reducer results and schedule reviewer gates when swarm review is required.
- [x] Continue Cowork Phase 7: handle reviewer `needs_revision` verdicts and create revision work units.
- [x] Continue Cowork Phase 7: handle reviewer `pass`/`blocked` verdicts with completed/blocked plan transitions.
- [x] Continue Cowork Phase 7: add minimal swarm evaluation blocker projection for goal coverage, safety policy, and budget state.
- [x] Continue Cowork Phase 7: add completed work-unit follow-up replanning from `missing_work` and `open_questions`.
- [x] Continue Cowork Phase 7: add failed/broad work-unit split replanning into narrow-scope revision work.
- [x] Continue Cowork Phase 7: add swarm workstream coverage evaluation.
- [x] Continue Cowork Phase 7: add swarm evidence coverage evaluation for missing `source_work_unit_ids`.
- [x] Continue Cowork Phase 7: add swarm uncited-claims evaluation.
- [x] Continue Cowork Phase 7: add swarm conflict detection evaluation.
- [x] Continue Cowork Phase 7: add swarm artifact validation evaluation.
- [x] Continue Cowork Phase 9: add large swarm fixture projection for clustered UI behavior.
- [x] Continue Cowork Phase 9: normalize Python event-log records when reading native Cowork events.
- [x] Continue Cowork Phase 10: add desktop gateway-client TS Cowork rollout gates.
- [x] Continue Cowork Phase 10: wire TS Cowork rollout gates to persisted config/defaults.
- [x] Continue Cowork Phase 9: replay missing event-log events and recover interrupted runtime trace spans on load.
- [x] Continue Cowork Phase 9: replay missing trace spans from Python event-log records.
- [x] Continue Cowork Phase 9: replay missing agent steps from Python observation event-log records.
- [x] Continue Cowork Phase 9: replay missing tool observations from Python observation event-log records.
- [x] Continue Cowork Phase 9: replay missing browser observations from Python observation event-log records.
- [x] Continue Cowork Phase 9: harden full observation detail and sensitive artifact replay from observation event-log payloads.
- [x] Continue Cowork Phase 10: enable TS-first Cowork routing by default with Python fallback preserved.
- [x] Continue Cowork Phase 10: expand desktop gateway facade coverage for migrated Cowork routes under default TS-first rollout.
- [x] Continue Cowork Phase 10: accept documented PATCH budget route while preserving current Python POST budget compatibility.
- [x] Continue Cowork Phase 10: route recipient-less swarm messages as user steering instructions.
- [x] Continue Cowork Phase 10: reject blank message route content with Python-compatible 400 responses.
- [x] Continue Cowork Phase 10: reject blank add-task route titles with Python-compatible 400 responses.
- [x] Continue Cowork Phase 10: return Python-compatible 400 responses for missing assign-task assignees.
- [x] Continue Cowork Phase 10: return Python-compatible read-only observability route status codes for missing agent activity and unavailable/unauthorized observation details.
- [x] Continue Cowork Phase 10: expose Python-compatible read-only route response keys for graph, DAG, artifacts, organization, and queues while preserving TS aliases.
- [x] Continue Cowork Phase 10: return Python-compatible 404/400 responses for delete-session and final-result select/merge route errors.
- [x] Continue Cowork Phase 10: map missing-session service errors to Python-compatible 404 route responses instead of worker protocol failures.
- [x] Continue Cowork Phase 10: return Python-compatible 400 responses for task retry/review route business errors.
- [x] Continue Cowork Phase 10: return Python-compatible branch-list missing-session errors and reject non-object budget route payloads.
- [x] Continue Cowork Phase 10: map branch select/derive/final-result business errors to Python-compatible HTTP route errors.
- [x] Continue Cowork Phase 10: return non-verbose snapshot payloads from the session list route.
- [x] Continue Cowork Phase 10: return verbose snapshot payloads from the session detail route.
- [x] Continue Cowork Phase 10: gate desktop work-unit, branch-result, and final-result routes behind the swarm rollout flag with Python fallback.
- [x] Continue Cowork Phase 10: return Python-shaped send-message success payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped add-task success payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped task assign, retry, and review success payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped work-unit retry, skip, and cancel success payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: switch desktop TS Cowork runtime fallback to explicit opt-in instead of default Python fallback.
- [x] Continue Cowork Phase 10: return Python-shaped run route payloads with snapshot/null sessions.
- [x] Continue Cowork Phase 10: return Python-shaped pause, resume, and emergency-stop route payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped markdown summary strings from summary routes and the `cowork summary` tool action.
- [x] Continue Cowork Phase 10: return Python-shaped create-session route payloads with snapshot sessions and blueprint validation errors.
- [x] Continue Cowork Phase 10: return Python-shaped final-result select and branch-result merge route payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped branch derive/select route payloads with branch and session snapshots.
- [x] Continue Cowork Phase 10: return Python-shaped recipient-less swarm message steering payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped budget update payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: return Python-shaped task assign/retry error payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: keep blueprint validate/preview under the read-only native route gate when mutation routes are disabled.
- [x] Continue Cowork Phase 10: gate recipient-less swarm message steering separately from directed message mutations.
- [x] Continue Cowork Phase 10: gate swarm-target branch derivation separately from non-swarm branch mutations.
- [x] Continue Cowork Phase 10: accept Python-compatible session-list `include_completed` aliases and trimmed `origin_chat_id` filters.
- [x] Continue Cowork Phase 10: accept Python-compatible run-session `parallel_width` as a `max_agents` alias.
- [x] Continue Cowork Phase 10: accept Python-compatible create-session `architecture` and `mode` aliases for `workflow_mode`.
- [x] Continue Cowork Phase 10: auto-run newly created sessions through the TS scheduler when route body sets `auto_run=true`.
- [x] Continue Cowork Phase 10: return Python-compatible create-session route errors for missing `goal`/`blueprint`.
- [x] Continue Cowork Phase 10: return Python-compatible create-session route errors for non-object bodies.
- [x] Continue Cowork Phase 10: reject non-object route bodies with Python-compatible invalid-json responses on `_json_body()` mutation routes.
- [x] Continue Cowork Phase 10: return Python-compatible route-level 503 errors when Cowork service is unavailable.
- [x] Continue Cowork Phase 10: return Python-compatible invalid-json errors for explicit non-object branch-scoped derive/select-final route bodies.
- [x] Continue Cowork Phase 10: return Python-compatible route-level branch-result merge errors for missing or non-list `branch_ids`.
- [x] Continue Cowork Phase 10: pass agent activity `limit` query options through the desktop gateway native TS Cowork facade.
- [x] Continue Cowork Phase 10: pass observation requester `agent_id` query options through the desktop gateway native TS Cowork facade.
- [x] Continue Cowork Phase 10: expose documented PATCH budget updates through the desktop gateway native TS Cowork facade.
- [x] Continue session turn lifecycle parity cleanup: align worker server checkpoint persistence tests with the native `session.persist_turn` atomic clear contract.
- [x] Continue Task/Cron background runtime parity: reject unknown IANA timezone names for TS-native `cron` add requests with `cron_expr`, matching Python `ZoneInfo` validation.
- [x] Continue Task/Cron background runtime parity: evaluate `deliver=true` cron run results with the TS evaluator before emitting native delivery events.
- [x] Start WebUI transport Batch 6: expose TS-native `/api/status` via worker route specs, Rust `worker_webui_route`, and desktop native status facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions` list via session metadata bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}/messages` via session metadata bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}/clear` via native session clear bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}` delete via native session delete bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}/profile` via session metadata bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}` PATCH metadata via native session patch bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}/temporary-files` list via session metadata bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/tools` list via worker ToolRegistry projection and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/approvals` list via native approval bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/approvals/{approval_id}/approve` and `/deny` via native approval bridge and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/provider-models` via provider model list handler and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/config` get via native public config snapshot and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/config` PATCH via TS config patch validation, native config-store apply, and desktop native facade fallback.
- [x] Continue MCP/WebUI config parity: reconnect native MCP discovery after TS-native `/api/config` PATCH updates MCP server fields.
- [x] Continue MCP diagnostics durability: expose latest native MCP discovery diagnostics through TS-native `/api/status`.
- [x] Continue MCP config contract parity: apply updated MCP allowlists/timeouts when native discovery reconnects after config patches.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/providers` via provider catalog handler and desktop native facade.
- [x] Continue WebUI transport Batch 6: expose TS worker `/webui/bootstrap` route spec and provider-injected bootstrap payload contract.
- [x] Continue WebUI transport Batch 6: route desktop near-expiry gateway token refresh through native `/webui/refresh-token` before HTTP fallback.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/skills` list/detail via skills bridge and desktop native WebUI facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/skills` create/update/delete/validate via skills bridge and desktop native WebUI facade.
- [x] Continue WebUI transport Batch 6: expose TS-native Agent UI form submit/cancel routes via checkpoint continuation and desktop native WebUI facade.
- [x] Continue WebUI transport Batch 6: expose TS-native workspace file list/read/write routes via native workspace bridge and desktop WebUI facade.
- [x] Continue WebUI transport Batch 6: expose TS-native `/webui/refresh-token` route spec/handler with native WebUI header propagation.
- [x] Continue WebUI transport Batch 6: expose TS-native `/api/sessions/{key}/temporary-files` upload route with native session storage and desktop FormData native fallback.
- [x] Continue WebUI transport Batch 6: preserve workspace file `expected_updated_at` optimistic concurrency through the TS/Rust native route.
- [x] Continue WebUI transport Batch 6: expose TS transport legacy WebSocket outbound frame mapper and worker RPC.
- [x] Continue WebUI transport Batch 6: expose Rust/Tauri `worker_transport_gateway_frame` and desktop native transport facade for TS legacy WebSocket frames.
- [x] Continue WebUI transport Batch 6: expose TS inbound WebSocket client-frame mapper and `transport.websocket_message` worker RPC.
- [x] Continue WebUI transport Batch 6: expose Rust/Tauri `worker_transport_websocket_message` and desktop native transport facade for TS inbound WebSocket client frames.
- [x] Continue WebUI transport Batch 6: map native inbound WebSocket message frames into `agent.run_input` through Rust/Tauri dispatch and desktop native transport facade support.
- [x] Continue WebUI transport Batch 6: route root-WebUI same-origin `/ws` through a desktop native WebSocket shim backed by TS worker transport dispatch.
- [x] Continue WebUI transport Batch 6: project TS worker stream events through the root-WebUI native WebSocket shim as legacy WebUI frames.
- [x] Continue WebUI transport Batch 6: project TS worker tool progress events through the root-WebUI native WebSocket shim as legacy `_progress` tool frames.
- [x] Continue WebUI transport Batch 6: project TS worker awaiting form/approval events through the root-WebUI native WebSocket shim.
- [x] Continue WebUI transport Batch 6: project TS worker memory reference and task progress events through the root-WebUI native WebSocket shim.
- [x] Continue WebUI transport Batch 6: preserve TS worker stream-end memory and recent-context references through the root-WebUI native WebSocket shim.
- [x] Continue WebUI transport Batch 6: project TS worker browser frame events through the root-WebUI native WebSocket shim while preserving `source_command`.
- [x] Continue WebUI transport Batch 6: project TS worker cancellation events through the root-WebUI native WebSocket shim as legacy `interrupted` frames.
- [x] Start Channel Bus Phase 1: add TS-native message envelopes, Python-compatible session keys, async inbound/outbound queues, batch/timeout consumption, close semantics, and backlog diagnostics.
- [x] Continue Channel Bus Phase 1: add TS-native ChannelManager outbound dispatch with send routing, progress filtering, stream coalescing, and retry diagnostics.
- [x] Continue Channel Bus Phase 2: add TS-native BaseChannel allow-list/inbound normalization and ChannelManager lifecycle/status projection.
- [x] Continue Channel Bus Phase 2: add built-in channel registry descriptors, default configs, delivery selectors, and enabled-channel config selection.
- [x] Continue Channel Bus Phase 3 foundation: add inbound channel envelope to AgentRunInput bridge with final/usage outbound publication and failure diagnostics.
- [x] Continue Channel Bus Phase 3: expose worker `channel.dispatch_inbound` for native/Python bridge envelopes through the existing `agent.run_input` execution path.
- [x] Continue Channel Bus Phase 3/4: expose Rust/Tauri `worker_channel_dispatch_inbound` and desktop native transport facade support for generic channel envelopes.
- [x] Continue Channel Bus Phase 4: add exported Python bridge schema helpers for inbound normalization and outbound JSON projection.
- [x] Continue Channel Bus Phase 4: add Python bridge ChannelAdapter outbound delivery for ordinary, usage, and stream delta messages.
- [x] Continue Channel Bus Phase 4: add Python bridge inbound ingestion into the TS MessageBus with malformed, closed-bus, and backpressure diagnostics.
- [x] Continue Channel Bus Phase 4: deliver restart completion notices from Python-compatible env markers on ChannelManager startup.
- [x] Continue Channel Bus command parity: dispatch channel slash commands through the backend command router before normal agent context/provider execution.
- [x] Continue Channel Bus manager parity: swallow stream/reasoning/end frames on adapters without `sendDelta`, matching Python `BaseChannel.send_delta()` no-op behavior.
- [x] Continue Channel Bus manager parity: align `sendMaxRetries` with Python `send_max_retries` total-attempt semantics.
- [x] Continue Channel Bus retry parity: propagate adapter cancellation errors instead of recording them as final send failures.
- [x] Continue Channel Bus manager lifecycle parity: start and stop a background outbound dispatcher with `ChannelManager` lifecycle.
- [x] Continue Channel Bus dispatcher parity: wake the outbound dispatcher from `MessageBus` delivery instead of waiting for idle polling.
- [x] Continue Channel Bus lifecycle parity: isolate per-channel startup failures and continue starting healthy adapters.
- [x] Continue Channel Bus lifecycle parity: isolate per-channel stop failures and continue stopping healthy adapters.
- [x] Continue Channel Bus Phase 5 foundation: add reusable TS `NativeTextChannel` connector boundary for native platform adapters.
- [x] Continue Channel Bus Phase 5 foundation: instantiate native text adapters from enabled channel config and connector registry.
- [x] Continue Channel Bus Phase 5 foundation: expose injected native `ChannelManager` lifecycle through worker RPCs.
- [x] Continue Channel Bus Phase 5 foundation: expose Rust/Tauri and desktop native transport lifecycle commands for TS-managed channel adapters.
- [x] Continue Channel Bus Phase 5 foundation: install a default TS `MessageBus`/`ChannelManager` in normal agent worker server runs.
- [x] Continue Channel Bus Phase 5 foundation: republish `channel.dispatch_inbound` replies onto the shared TS channel bus for native dispatch.
- [x] Continue Channel Bus Phase 5 foundation: start the TS-managed native channel runtime during desktop bootstrap.
- [x] Continue Channel Bus Phase 5 foundation: assemble host-provided native text connectors from canonical config in the default stdio worker lifecycle.
- [x] Continue Channel Bus Phase 5 foundation: add an explicit host-RPC connector bridge contract for native text adapters.
- [x] Continue Channel Bus Phase 5 foundation: add Rust host recognition and capability gating for `channel.connector.*` worker-host RPCs.
- [x] Continue Channel Bus Phase 5 foundation: convert host `handled: false` connector responses into TS channel diagnostics.
- [x] Start API Runtime Phase 1: expose TS-native public `GET /health` and OpenAI-compatible `GET /v1/models` through the worker route bridge.
- [x] Continue API Runtime Phase 1: expose TS-native non-stream `POST /v1/chat/completions` through the worker route bridge and existing AgentRunner path.
- [x] Continue API Runtime Phase 1: apply `api.timeout` and OpenAI-shaped 504 handling to TS-native chat completions.
- [x] Continue API Runtime Phase 1: expose desktop gateway `openAi` facade methods for `/health`, `/v1/models`, and `/v1/chat/completions` with native WebUI route preference and HTTP gateway fallback.
- [x] Continue API Runtime Phase 1: expose native-backed Knowledge API list/add/txt-md-upload/get/delete/query/stats route adapters and desktop native-first facade methods while leaving unsupported upload/jobs/rebuild/graph endpoints on HTTP fallback.
- [x] Continue API Runtime Phase 1: preserve Python-shaped async upload job envelopes for native txt/md Knowledge uploads while leaving standalone job polling/rebuild/graph endpoints on HTTP fallback.
- [x] Continue API Runtime Phase 1: expose native upload-job polling for TS-native Knowledge uploads.
- [x] Continue API Runtime Phase 1: expose native bm25 rebuild-index completed job envelopes and completed-job polling while leaving semantic rebuild and GraphRAG endpoints on HTTP fallback.
- [x] Continue API Runtime Phase 1: expose native Knowledge graph readiness/empty projection and desktop native-first graph facade while leaving GraphRAG on HTTP fallback.
- [x] Continue API Runtime Phase 1: expose native GraphRAG empty index projection and desktop native-first GraphRAG facade while leaving semantic rebuild-index on HTTP fallback.
- [x] Continue API Runtime Phase 1: expose native all rebuild-index completed aggregate job envelopes and desktop native-first all rebuild facade while leaving semantic rebuild-index on HTTP fallback.
- [x] Continue API Runtime Phase 1: extend desktop native Knowledge upload support to `.json` and `.csv` text-like files while leaving extractor-dependent formats on HTTP fallback.
- [x] Continue API Runtime Phase 1: canonicalize desktop Knowledge `.markdown` uploads to native `md` payloads while leaving extractor-dependent formats on HTTP fallback.
- [x] Continue API Runtime Phase 1: route semantic rebuild-index through native completed unavailable/skipped job envelopes and desktop native-first facade paths while keeping semantic extraction itself deferred.
- [x] Continue API Runtime Knowledge validation parity: return Python-compatible invalid-request envelopes for graph, GraphRAG, and rebuild-index validation errors.
- [x] Continue API Runtime Knowledge error-envelope parity: return Python-compatible invalid-request envelopes for unavailable store, malformed body, missing field, upload validation, document not-found, and job not-found errors.
- [x] Continue API Runtime Knowledge provider-error parity: wrap Knowledge provider exceptions as route-specific Python-compatible 500 server-error envelopes.
- [x] Continue API Runtime Knowledge async-add parity: return Python-compatible completed job envelopes for add-document requests with `async_index`.
- [x] Continue API Runtime Knowledge validation parity: reject whitespace-only direct add-document content before native provider dispatch.
- [x] Continue API Runtime Phase 1: harden the TS worker upload route and Rust `knowledge.add_document` core so `.json` and `.csv` text-like Knowledge uploads are accepted end-to-end on the native path.
- [x] Continue API Runtime Phase 1: parameterize the desktop native-first Knowledge GraphRAG facade for Python-compatible query options.
- [x] Continue API Runtime Phase 1: mirror Python truthiness for OpenAI-compatible chat completion `model` validation on TS-native routes.
- [x] Continue API Runtime Phase 1: mirror Python truthiness for OpenAI-compatible chat completion `stream` rejection on TS-native routes.
- [x] Continue API Runtime Phase 1: mirror Python truthiness for OpenAI-compatible chat completion `session_id` lock keys on TS-native routes.
- [x] Continue Knowledge Phase 3: include session temporary uploads in native `knowledge.context` results and preserve temporary reference metadata through the TS context bridge.
- [x] Continue Knowledge Phase 3: let attachment-style prompts request native `knowledge.context` with persistent retrieval disabled so session temporary uploads remain available without broad Knowledge auto-retrieval.
- [x] Continue Knowledge Phase 3: expose native `knowledge.session_upload`, `knowledge.session_list`, and `knowledge.session_clear` RPC aliases over the session temporary upload store.
- [x] Continue Knowledge Phase 3: route TS WebUI temporary-file list/upload through native `knowledge.session_list` and `knowledge.session_upload`.
- [x] Continue Knowledge Phase 3: expose TS WebUI temporary-file clear through native `knowledge.session_clear`.
- [x] Continue Knowledge Phase 3: expose desktop gateway native-first temporary-file clear facade with HTTP fallback.
- [x] Continue WebUI transport Batch 6: keep extractor-dependent session temporary uploads such as PDF on HTTP/Python fallback while preserving native-first text/Markdown uploads.
- [x] Continue WebUI transport Batch 6: expose `/api/cowork/*` wildcard route specs and bridge `webui.handle_request` Cowork requests into the TS-native Cowork dispatcher.
- [x] Continue WebUI transport Batch 6: forward TS worker Cowork update/state/stream events through the native root-WebUI WebSocket shim and emit create-session update/state events from the TS Cowork service.
- [x] Continue Cowork Phase 10: expose desktop native action requests for TS-native Cowork blueprint, trace, DAG, artifact, organization, queue, and branch read-only routes.
- [x] Continue Cowork Phase 10: wire desktop Cowork action controls and handler dispatch for TS-native blueprint, trace, DAG, artifact, organization, queue, and branch read-only routes.
- [x] Continue Cowork Phase 10: expose desktop native action requests for TS-native budget update, source-branch derive, final-result select, and final-result merge routes.
- [x] Continue Cowork Phase 10: wire desktop Cowork action controls and handler dispatch for TS-native budget update, source-branch derive, final-result select, and final-result merge routes.
- [x] Continue Cowork Phase 10: expand desktop gateway regression coverage for default TS-native Cowork session detail, summary, graph, pause, delete, message, add-task, branch select, and branch-result merge routes.
- [x] Continue Cowork Phase 10: wire desktop Cowork agent-activity and observation-detail actions through native-first facade routes with requester `agent_id` propagation.
- [x] Continue Cowork Phase 10: switch desktop budget update actions to the documented native `PATCH /budget` route while preserving gateway POST compatibility.
- [x] Continue Cowork Phase 10: gate nested blueprint swarm session creation under the swarm rollout flag with Python fallback.
- [x] Continue Cowork Phase 10: normalize swarm create architecture aliases before applying desktop rollout fallback gates.
- [x] Continue Cowork Phase 10: classify auto-run swarm session creation under the swarm rollout gate before scheduler routing.
- [x] Continue Cowork Phase 10: prefer blueprint architecture over top-level create mode when applying swarm rollout fallback gates.
- [x] Continue Cowork Phase 10: align recipient-less swarm message rollout gates with worker recipient alias precedence.
- [x] Continue Cowork Phase 10: align TS scheduler budget-stop events and trace status with Python Cowork observability semantics.
- [x] Continue Cowork Phase 10: block TS `cowork_internal` spawn_agent/spawn_subteam when explicit spawned-agent budget guardrails are exhausted.
- [x] Continue Cowork Phase 10: preserve agent-activity `limit` query options in desktop action request builders.
- [x] Continue Cowork Phase 10: align native Vue inspector branch/final-result controls with migrated TS-native desktop route actions.
- [x] Continue Cowork Phase 10: expose selected-agent activity actions from legacy and Vue desktop inspectors.
- [x] Continue Cowork Phase 10: preserve selected-agent activity `limit` query options through legacy/Vue desktop inspector events and the native bootstrap handler.
- [x] Continue Cowork Phase 10: gate branch-select desktop gateway requests under the swarm rollout flag with Python fallback.
- [x] Continue Cowork Phase 10: expose selected-agent observation-detail actions from legacy and Vue desktop inspectors with requester propagation.
- [x] Continue Cowork Phase 10: preserve Python-compatible message `thread_id`, `topic`, and `event_type` fields through direct TS worker RPC and desktop action request builders.
- [x] Continue Cowork Phase 10: return Python-shaped work-unit retry/skip/cancel error payloads with snapshot sessions.
- [x] Continue Cowork Phase 10: align branch-derive rollout gating with Python `target_architecture` / `architecture` precedence.
- [x] Continue Cowork Phase 10: pass desktop native Cowork route query parameters through Rust's structured worker route envelope.
- [x] Continue Cowork Phase 10: align create-session rollout gating with Python `architecture` / `workflow_mode` precedence for non-blueprint requests.
- [x] Continue Cowork Phase 10: require both scheduler and swarm rollout gates for desktop auto-run swarm create-session requests.
- [x] Continue Cowork Phase 10: project desktop branch rows from Python/TS snapshot branches when `branch_results` is absent.
- [x] Continue Cowork Phase 10: accept Python-compatible `architecture` aliases on TS-native branch derive routes.
- [x] Continue Cowork Phase 10: preserve Python-compatible `derivation_reason` aliases on TS-native branch derive routes.
- [x] Continue Cowork Phase 10: preserve Python-compatible message `thread_id` and `topic` fields on TS-native message routes.
- [x] Continue Cowork Phase 10: route non-swarm TS-native API messages through mailbox envelopes with `event_type` metadata.
- [x] Continue Cowork Phase 10: expire overdue mailbox records before TS mailbox delivery.
- [x] Continue Cowork Phase 10: reject missing bodies on TS-native Cowork `_json_body()` mutation routes.
- [x] Continue Cowork Phase 10: reset stale completed-session readiness decisions when TS mailbox delivery reopens a session for a user message.
- [x] Continue Cowork Phase 10: refresh Python-compatible pending-reply blocker completion decisions after TS mailbox delivery.
- [x] Continue Cowork Phase 10: preserve Python `review_failed_tasks` priority ahead of reply blockers during TS mailbox decision refresh.
- [x] Continue Cowork Phase 10: preserve Python `review_convergence` priority ahead of unread inbox work during TS mailbox decision refresh.
- [x] Continue Cowork Phase 10: return Python-compatible `summarize` / `ready_to_finish` decisions for completed task results during TS mailbox refresh.
- [x] Continue Cowork Phase 10: preserve Python review gate blocker decisions during TS mailbox completion-decision refresh.
- [x] Continue Cowork Phase 10: preserve Python fanout merge blocker decisions during TS mailbox completion-decision refresh.
- [x] Continue Cowork Phase 10: preserve Python disagreement synthesis decisions during TS mailbox completion-decision refresh.
- [x] Continue Cowork Phase 10: preserve Python completion-decision metadata for budget, workflow, focus, workspace, artifacts, and shared-memory counts during TS mailbox refresh.
- [x] Continue Cowork Phase 10: preserve Python agent readiness score payloads during TS mailbox completion-decision refresh.
- [x] Continue Cowork Phase 10: recompute Python-compatible current focus tasks during TS mailbox completion-decision refresh.
- [x] Continue Cowork Phase 10: include Python-compatible shared-task claim activation reasons in TS mailbox readiness payloads.
- [x] Continue Cowork Phase 10: include Python-compatible lead synthesis score boosts and activation reasons in TS mailbox readiness payloads.
- [x] Continue Cowork Phase 10: include Python-compatible message-bus subscription pressure in TS mailbox readiness scores.
- [x] Continue Cowork Phase 10: include Python-compatible shared-state open-question pressure in TS mailbox readiness scores.
- [x] Continue Cowork Phase 10: align TS active-agent selection with Python shared-task slot consumption for unassigned ready tasks.
- [x] Continue Cowork Phase 10: align TS active-agent and swarm selection with Python terminal-agent filtering.
- [x] Continue Cowork Phase 10: align TS active-agent selection with Python inactive-session early return.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python direct swarm selector return.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python parallel-width slot limits.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python duplicate work-unit signature guards.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python failed-retry queue eligibility.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python failed source-task retry eligibility.
- [x] Continue Cowork Phase 10: align TS swarm active-agent selection with Python ready-before-failed-retry queue ordering.
- [x] Continue Cowork Phase 10: project Python-compatible `swarm_queues` and `swarm_metrics` from TS swarm snapshots.
- [x] Continue Cowork Phase 10: align TS swarm parallel metrics with Python trace-derived fanout width and empty reducer-coverage semantics.
- [x] Continue Cowork Phase 10: align TS swarm reducer-coverage metrics with Python source-event citation semantics.
- [x] Continue Cowork Phase 10: align TS swarm critical-path metrics with Python cyclic dependency semantics.
- [x] Continue Cowork Phase 10: populate Python-compatible `generated_at` timestamps on TS Cowork graph/swarm snapshot projections.
- [x] Continue Cowork Phase 10: embed Python-compatible swarm parallel metrics in TS swarm organization projections.
- [x] Continue Cowork Phase 10: align TS swarm workstream risk projection with Python active/no-blocker semantics.
- [x] Continue Cowork Phase 10: align TS swarm workstream risk projection with Python completed-workstream semantics.
- [x] Continue Cowork Phase 10: align TS swarm blocker extraction with Python blank dependency/blocker filtering.
- [x] Continue Cowork Phase 10: align TS large-swarm summary workstream ordering with Python equal-count semantics.
- [x] Continue Cowork Phase 10: align TS swarm gate `required` projection with Python truthy configuration semantics.
- [x] Continue Cowork Phase 10: align TS swarm gate blocking evaluation id placeholders with Python snapshot semantics.
- [x] Continue Cowork Phase 10: align TS swarm final-deliverable readiness projection with Python truthy semantics.
- [x] Continue Cowork Phase 10: preserve Python-compatible emergency-stop `reason` bodies through the desktop Cowork action builder and bootstrap default UI dispatch path.
- [x] Continue Cowork Phase 10: forward Python-compatible emergency-stop route bodies from the desktop gateway native-first client so `reason` reaches the TS route handler.
- [x] Continue Cowork Phase 10: mirror Python truthiness for Cowork run-route `run_until_idle` and `stop_on_blocker` flags.
- [x] Continue Cowork Phase 10: mirror Python truthiness for Cowork create-session `auto_run` flags.
- [x] Continue Cowork Phase 10: accept Python blueprint create auto-run `rounds` as a `max_rounds` alias.
- [x] Continue Cowork Phase 10: mirror Python truthiness for desktop gateway auto-run create scheduler rollout gates.
- [x] Continue Cowork Phase 10: mirror Python truthiness for desktop gateway create and branch-derive swarm rollout mode selection.
- [x] Continue Cowork Phase 10: mirror Python truthiness for desktop gateway recipient-less swarm message rollout gates.
- [x] Continue Cowork Phase 10: mirror Python `architecture` before `workflow_mode` precedence on TS-native create-session routes.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for Cowork message content and task title validation.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for Cowork add-task optional description and assignee fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for Cowork emergency-stop reasons.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for Cowork assign-task agent ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for branch-result merge summaries.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for branch-derive metadata fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for final-result select ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for work-unit action reasons.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for message route metadata fields.
- [x] Continue Cowork Phase 10: mirror Python add-task route payload boundaries for direct worker RPC-only fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for task-review reviewer ids.
- [x] Continue Cowork Phase 10: auto-run direct TS `cowork.create_session` RPCs with Python-compatible scheduler limits.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.send_message` metadata fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.send_message` content.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.send_message` sender ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.add_task` titles.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.add_task` descriptions.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.add_task` assignee ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.add_task` direct-only metadata fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS task mutation ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.emergency_stop_session` reasons.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS work-unit action reasons.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS work-unit action ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS mailbox read agent ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.assign_task` assignee ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.request_task_review` reviewer ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for Cowork create-session goals and titles.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.derive_branch` metadata fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.merge_branch_results` summaries.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.select_branch_result` result ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS branch ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS `cowork.deliver_envelope` fields.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for direct TS read-only observability ids.
- [x] Continue Cowork Phase 10: mirror Python route text coercion for TS-native blueprint default goals.
- [x] Continue Cowork Phase 10: mirror Python truthy text coercion for create-session architecture aliases.
- [x] Continue Cowork Phase 10: cover gateway default-route behavior for numeric create-session architecture precedence.
- [x] Continue Cowork Phase 10: cover gateway default-route behavior for numeric branch-derive architecture precedence.
- [x] Continue Cowork Phase 10: align gateway auto-run rollout alias precedence with the native TS worker route.
- [x] Continue Cowork Phase 10: align gateway recipientless message rollout normalization with the native TS worker route.
- [x] Continue Cowork Phase 10: align gateway branch-derive rollout alias precedence with the native TS worker route.
- [x] Continue Cowork Phase 10: align gateway create-session rollout architecture alias precedence with native TS worker and blueprint normalization.
- [x] Continue Cowork Phase 10: align gateway create/branch architecture text coercion with native TS worker route parsing.
- [x] Continue Cowork Phase 10: preserve Python fallback for mixed-alias auto-run create-session requests when TS scheduler routing is disabled.
- [x] Continue Cowork Phase 10: auto-run mixed-alias create-session requests on the TS-native worker route.
- [x] Continue Cowork Phase 10: honor mixed-alias run-route scheduler flags on the TS-native worker route.
- [x] Continue Cowork Phase 10: honor mixed-alias run-route numeric limits on the TS-native worker route.
- [x] Continue Cowork Phase 10: preserve blueprint create auto-run `rounds` fallback with blank camel-case max-round aliases.
- [x] Continue Cowork Phase 10: preserve assign-task route `assigned_agent_id` precedence with blank direct-agent aliases.
- [x] Continue Cowork Phase 10: preserve add-task route `assigned_agent_id` precedence with blank camel-case assignee aliases.
- [x] Continue Cowork Phase 10: preserve task-review route `reviewer_agent_id` precedence with blank camel-case reviewer aliases.
- [x] Continue Cowork Phase 10: preserve branch-derive route snake-case text precedence with blank camel-case aliases.
- [x] Continue Cowork Phase 10: preserve branch final-result route `result_id` precedence with blank camel-case result aliases.
- [x] Continue Cowork Phase 10: preserve final-result merge route `branch_ids` precedence with blank camel-case branch aliases.
- [x] Continue Cowork Phase 10: preserve target-branch architecture on desktop branch result select-final requests so non-swarm branch final-result selections use the mutation rollout gate.
- [x] Continue Cowork Phase 10: route explicitly swarm Cowork run requests through Python fallback when the desktop swarm rollout gate is disabled.
- [x] Continue Cowork Phase 10: preserve selected-session architecture on desktop Cowork run action requests for swarm rollout fallback gating.
- [x] Continue Cowork Phase 10: preserve selected-session architecture on desktop recipientless message requests so non-swarm group messages use the mutation rollout gate.
- [x] Continue Cowork Phase 10: preserve target-branch architecture on desktop branch select requests so non-swarm branch selections use the mutation rollout gate.
- [x] Continue Cowork internal lifecycle metadata parity: mirror Python retire reason fallback, spawned-agent source envelope ids, and `_tool_call_id` draft ids.
- [x] Continue Cowork internal task mutation parity: keep omitted/invalid `add_task` assignees in the shared pool, reject terminal `assign_task` statuses, and preserve Python-shaped assign success events/traces without extra messages.
- [x] Continue Cowork scheduler parity: stop with `ready_to_finish` after a ready completion decision when no active agents remain.
- [x] Continue Cowork scheduler self-activation parity: skip agents after three consecutive self-selected runs and record `scheduler.self_activation_limited`.
- [x] Continue Cowork scheduler assessment parity: refresh completion decisions after rounds/synthesis and record run wall-clock budget usage.
- [x] Continue Cowork scheduler completion-output parity: include Python-style completed-session result text and refresh run metric counts.
- [x] Continue Cowork scheduler profile-limit parity: constrain orchestrator/generator-verifier/peer-handoff scheduler rounds to one selected agent.
- [x] Continue Cowork scheduler budget-usage parity: record per-round and lead-synthesis usage during the run for fresh session remaining snapshots.
- [x] Continue Cowork scheduler round execution parity: start same-round selected agents concurrently like Python.
- [x] Continue Cowork scheduler convergence parity: report idle when self-activation limits remove all next ready agents.
- [x] Continue Cowork scheduler trace parity: include swarm metrics in scheduler round trace spans like Python.
- [x] Continue Cowork lead-synthesis trace parity: keep synthesis agent trace linkage standalone like Python.
- [x] Continue Cowork agent-runtime failure parity: persist failed agent/task state and observability when AgentRunner raises.
- [x] Continue Cowork observability parity: sanitize AgentRunner tool observation parameters like Python.
- [x] Continue Cowork observability parity: finish AgentRunner steps with Python-compatible structured summaries.
- [x] Continue Cowork observability durability parity: append AgentRunner `agent_step.finished` event-log records like Python.
- [x] Continue Cowork observability durability parity: append AgentRunner tool/browser observation event-log records like Python.
- [x] Continue Cowork observability durability parity: append AgentRunner trace span event-log records like Python.
- [x] Continue Cowork agent readiness parity: sort team ready agents by Python-style readiness scores before applying scheduler limits.
- [x] Continue Cowork agent readiness parity: select agents with pending reply mailbox work and score mailbox pressure like Python.
- [x] Continue Cowork agent readiness parity: refresh mailbox expiry and stale-blocker escalation before selecting active agents like Python.
- [x] Continue session turn lifecycle evidence durability: skip memory evidence capture for duplicate-only native persist-turn results.
- [x] Continue session turn lifecycle evidence durability: skip memory evidence capture for duplicate-only append fallback results.
- [x] Continue session turn lifecycle evidence durability: capture memory evidence from native `saved_messages` for partial-duplicate persisted turns.
- [x] Continue session turn lifecycle parity: keep checkpoint clearing owned by `TurnLifecycle.finalizeTurn()` for direct and resumed completed runs.
- [x] Start Heartbeat runtime Phase 1: add pure TS heartbeat decision parsing, target selection, manual trigger/status, and tick service orchestration.
- [x] Continue Heartbeat runtime Phase 1: add start/stop interval lifecycle with disabled guard, first-delay scheduling, and no-overlap scheduled ticks.
- [x] Continue Heartbeat runtime bridge foundation: route heartbeat tasks through TS `AgentRunner` with fixed heartbeat session, trim callback, and external-notify gating.
- [x] Continue Heartbeat runtime Phase 2: expose worker `heartbeat.trigger_now` and `heartbeat.status` protocol methods.
- [x] Continue Heartbeat runtime Phase 2: inject real `HeartbeatRuntime` into the native stdio worker server with native workspace/config/session bridges.
- [x] Continue Heartbeat runtime Phase 2: add native `session.trim` and wire heartbeat execution to retain recent legal session suffixes.
- [x] Continue Heartbeat runtime Phase 2: expose worker `heartbeat.start`/`heartbeat.stop` and refresh native heartbeat enabled/interval config before scheduling.
- [x] Continue Heartbeat runtime Phase 3: expose heartbeat scheduler diagnostics through TS-native `/api/status` with native config refresh.
- [x] Continue Heartbeat runtime Phase 3: refresh heartbeat enabled/interval after TS-native `/api/config` PATCH applies to the native config store.
- [x] Continue Heartbeat runtime Phase 3: start and stop TS heartbeat scheduling from the native desktop host lifecycle.
- [x] Continue Heartbeat runtime Phase 3: use native `agents.defaults.timezone` when formatting heartbeat decision `Current Time` prompts.
- [x] Continue Heartbeat runtime Phase 4: use the shared Python-compatible background evaluator before scheduled heartbeat notifications.
- [x] Continue Heartbeat runtime Phase 4: emit approved native heartbeat external notifications through worker events with Python-compatible channel targets.
- [x] Continue Heartbeat runtime Phase 4: project native `heartbeat.delivery` worker events into desktop chat messages without requiring an active agent run.
- [x] Add a dedicated TS worker typecheck/runtime smoke build boundary and run it from the desktop build.
- [x] Continue Command Runtime Phase 3: migrate the first native `/dream` conversation-evidence extraction path for explicit memory-intent evidence.
- [x] Continue Command Runtime Phase 3: migrate the first native `/dream` legacy-history extraction path for explicit memory-intent records.
- [x] Continue Command Runtime Phase 3: preserve pending non-explicit Dream evidence/history for provider-backed LLM summarization by deferring native heuristic runs without cursor advancement.
- [x] Continue Command Runtime Phase 3: expose internal native Dream pending/apply RPCs and TS bridge hooks for provider-backed Dream note application with Dream source/cursor semantics.
- [x] Continue Command Runtime Phase 3: route deferred `/dream` batches through the TS provider, parse JSON Memory Operations, and apply save/reject/supersede operations without advancing cursors on invalid provider JSON.
- [x] Continue Command Runtime Phase 3: include current Memory Notes and rendered memory views in provider-backed Dream extraction prompts.
- [x] Continue Command Runtime Phase 3: align provider-backed Dream JSON operation parsing with Python single-object and unsupported-action semantics.
- [x] Continue Command Runtime Phase 3: align provider-backed Dream JSON operation defaults for confidence and tags with Python.
- [x] Continue Command Runtime Phase 3: align provider-backed Dream note type and scope coercion with Python.
- [x] Continue Command Runtime status parity: report Python-compatible `/status` model, token, context, session, and uptime fields from native worker snapshots.
- [x] Continue Command Runtime `/new` parity: clear native session temporary knowledge through `knowledge.session_clear` after clearing the session.
- [x] Continue Command Runtime `/new` archive parity: capture clear-before session messages into native conversation evidence before clearing the session.
- [x] Continue Command Runtime metadata parity: preserve inbound command message metadata while forcing command-owned `command` and `render_as: text` fields.
- [x] Continue Command Runtime Phase 3 Dream command parity: catch `/dream` bridge failures as Python-compatible `Dream failed: ...` output.
- [x] Continue Command Runtime Phase 3 Dream command durability: catch `/dream-log` and `/dream-restore` bridge failures as command text results.
- [x] Continue Command Runtime bridge durability: catch `/status`, `/restart`, and `/approvals` bridge failures as command text results.

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
- [x] Continue config/provider bridge durability: resolve native OpenAI secrets for legacy `provider=auto` fallback when public snapshots are unavailable.
- [x] 在 Batch 1 shared support Phase 1 完成后更新 `Current Focus` 和对应状态。
- [x] 继续 Cowork Phase 1：补 TS session/store types、legacy serde/default hydration 与 `cowork_store.*` native bridge contract。
- [x] 继续 Cowork Phase 1：补 read-only `coworkSessionSnapshot()`、graph/trace/task DAG/artifact index 与 non-verbose privacy projection。
- [x] 继续 Cowork Phase 2：补 architecture helpers、default policy registry 与 projection-only topology/organization capability，并接入 snapshot。
