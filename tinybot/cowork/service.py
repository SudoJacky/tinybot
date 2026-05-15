"""Persistent cowork session service."""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
import threading
import uuid
from collections.abc import Callable
from dataclasses import MISSING, asdict, fields
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.cowork.architecture import (
    ACCEPTED_ARCHITECTURE_VALUES,
    ADAPTIVE_STARTER,
    architecture_label,
    normalize_architecture_name,
)
from tinybot.cowork.blueprint import (
    budget_remaining,
    default_budget_usage,
    export_session_blueprint,
    normalize_blueprint,
    normalize_budget_limits,
    preview_blueprint,
    session_inputs_from_blueprint,
    validate_blueprint,
)
from tinybot.cowork.event_log import CoworkEventLogStore
from tinybot.cowork.policies import ArchitectureRuntimePolicy, default_policy_registry
from tinybot.cowork.snapshot import build_cowork_artifact_index
from tinybot.cowork.swarm import (
    build_swarm_scheduler_queues,
    normalize_swarm_plan,
    update_work_unit_readiness,
    work_unit_result_from_task,
)
from tinybot.cowork.types import (
    CoworkAgent,
    CoworkAgentStep,
    CoworkBranch,
    CoworkBranchResult,
    CoworkBrowserObservation,
    CoworkEvaluationResult,
    CoworkDelegatedBrief,
    CoworkDelegatedTask,
    CoworkDelegationGuardrail,
    CoworkEvent,
    CoworkFullObservationDetail,
    CoworkIsolatedSubAgentContext,
    CoworkMailboxRecord,
    CoworkMessage,
    CoworkRunMetrics,
    CoworkSession,
    CoworkSessionFinalResult,
    CoworkStageRecord,
    CoworkStepSummary,
    CoworkSensitiveArtifact,
    CoworkSubAgentResult,
    CoworkTask,
    CoworkThread,
    CoworkToolObservation,
    CoworkTraceSpan,
    now_iso,
)
from tinybot.cowork.trace import CoworkTraceRecorder, compact_text, duration_ms


_MAX_PRIVATE_SUMMARY_CHARS = 6000
_MAX_EVENT_COUNT = 500
_MAX_TRACE_SPAN_COUNT = 1000
_MAX_AGENT_STEP_COUNT = 1000
_MAX_RUN_METRIC_COUNT = 80
_MAX_SCHEDULER_DECISION_COUNT = 200
_MAX_MAILBOX_RECORDS = 300
_CONVERGENCE_IDLE_ROUNDS = 2
_DEFAULT_RUN_AGENT_CALLS = 30
_SHARED_MEMORY_BUCKETS = ("findings", "claims", "risks", "open_questions", "decisions", "artifacts")
_WORKFLOW_MODES = ACCEPTED_ARCHITECTURE_VALUES
_DEFAULT_BRANCH_ID = "default"


class CoworkService:
    """Create, persist, and mutate cowork sessions."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.cowork_dir = workspace / "cowork"
        self._sessions: dict[str, CoworkSession] | None = None
        self._listeners: list[Callable[[CoworkSession, CoworkEvent], None]] = []
        self.traces = CoworkTraceRecorder(self._new_id)
        self.event_log = CoworkEventLogStore(self.cowork_dir)
        self.policy_registry = default_policy_registry()
        self._mutation_lock = threading.RLock()

    @property
    def store_path(self) -> Path:
        return self.cowork_dir / "store.json"

    @staticmethod
    def normalize_workflow_mode(value: Any) -> str:
        return normalize_architecture_name(value)

    @staticmethod
    def workflow_profile(value: Any) -> str:
        mode = CoworkService.normalize_workflow_mode(value)
        if mode in {"supervisor", "orchestrator"}:
            return "orchestrator"
        if mode == "peer_handoff":
            return "peer_handoff"
        return default_policy_registry().resolve(mode).runtime_profile

    def architecture_policy(self, value: Any) -> ArchitectureRuntimePolicy:
        return self.policy_registry.resolve(self.normalize_workflow_mode(value))

    @staticmethod
    def _normalize_shared_memory(value: Any) -> dict[str, list[dict[str, Any]]]:
        memory: dict[str, list[dict[str, Any]]] = {bucket: [] for bucket in _SHARED_MEMORY_BUCKETS}
        if not isinstance(value, dict):
            return memory
        for bucket in _SHARED_MEMORY_BUCKETS:
            entries = value.get(bucket, [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict):
                    memory[bucket].append(dict(entry))
                elif str(entry).strip():
                    memory[bucket].append({"text": str(entry).strip()})
        return memory

    def _ensure_dir(self) -> None:
        self.cowork_dir.mkdir(parents=True, exist_ok=True)
        self.event_log.ensure_dirs()

    def _load(self) -> dict[str, CoworkSession]:
        if self._sessions is not None:
            return self._sessions
        if not self.store_path.exists():
            self._sessions = self._load_event_log_sessions()
            return self._sessions
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
            sessions = {}
            for raw in data.get("sessions", []):
                session = CoworkSession(
                    id=raw["id"],
                    title=raw["title"],
                    goal=raw["goal"],
                    status=raw.get("status", "active"),
                    workflow_mode=self.normalize_workflow_mode(raw.get("workflow_mode", ADAPTIVE_STARTER)),
                    current_branch_id=str(raw.get("current_branch_id") or _DEFAULT_BRANCH_ID),
                    current_focus_task=raw.get("current_focus_task", ""),
                    workspace_dir=raw.get("workspace_dir", ""),
                    artifacts=raw.get("artifacts", []) if isinstance(raw.get("artifacts", []), list) else [],
                    shared_memory=self._normalize_shared_memory(raw.get("shared_memory", {})),
                    shared_summary=raw.get("shared_summary", ""),
                    final_draft=raw.get("final_draft", ""),
                    completion_decision=raw.get("completion_decision", {}),
                    swarm_plan=raw.get("swarm_plan", {}) if isinstance(raw.get("swarm_plan", {}), dict) else {},
                    budget_limits=normalize_budget_limits(raw.get("budget_limits") or raw.get("budgets")),
                    budget_usage={
                        **default_budget_usage(),
                        **(raw.get("budget_usage", {}) if isinstance(raw.get("budget_usage", {}), dict) else {}),
                    },
                    stop_reason=str(raw.get("stop_reason") or ""),
                    blueprint=raw.get("blueprint", {}) if isinstance(raw.get("blueprint", {}), dict) else {},
                    blueprint_diagnostics=raw.get("blueprint_diagnostics", []) if isinstance(raw.get("blueprint_diagnostics", []), list) else [],
                    runtime_state=raw.get("runtime_state", {}) if isinstance(raw.get("runtime_state", {}), dict) else {},
                    session_final_result=self._hydrate_optional_dataclass(
                        raw.get("session_final_result"),
                        CoworkSessionFinalResult,
                    ),
                    created_at=raw.get("created_at", now_iso()),
                    updated_at=raw.get("updated_at", now_iso()),
                    rounds=raw.get("rounds", 0),
                    no_progress_rounds=int(raw.get("no_progress_rounds", 0) or 0),
                )
                session.agents = {
                    item["id"]: CoworkAgent(
                        id=item["id"],
                        name=item["name"],
                        role=item["role"],
                        goal=item["goal"],
                        responsibilities=item.get("responsibilities", []),
                        tools=item.get("tools", []),
                        subscriptions=item.get("subscriptions", []) if isinstance(item.get("subscriptions", []), list) else [],
                        communication_policy=item.get("communication_policy", ""),
                        context_policy=item.get("context_policy", ""),
                        status=item.get("status", "idle"),
                        private_summary=item.get("private_summary", ""),
                        inbox=item.get("inbox", []),
                        current_task_id=item.get("current_task_id"),
                        current_task_title=item.get("current_task_title"),
                        last_active_at=item.get("last_active_at"),
                        rounds=item.get("rounds", 0),
                        parent_agent_id=item.get("parent_agent_id"),
                        team_id=item.get("team_id", ""),
                        lifetime=item.get("lifetime", "persistent"),
                        lifecycle_status=item.get("lifecycle_status", "active"),
                        source_blueprint_id=item.get("source_blueprint_id", ""),
                        source_event_id=item.get("source_event_id", ""),
                        spawn_reason=item.get("spawn_reason", ""),
                        delegated_task_id=item.get("delegated_task_id", ""),
                        delegated_brief_id=item.get("delegated_brief_id", ""),
                        isolated_context_id=item.get("isolated_context_id", ""),
                        sub_agent_scope=item.get("sub_agent_scope", ""),
                    )
                    for item in raw.get("agents", {}).values()
                }
                session.tasks = {
                    item["id"]: CoworkTask(
                        id=item["id"],
                        title=item["title"],
                        description=item["description"],
                        assigned_agent_id=item.get("assigned_agent_id"),
                        dependencies=item.get("dependencies", []),
                        status=item.get("status", "pending"),
                        result=item.get("result"),
                        result_data=item.get("result_data", {}),
                        confidence=item.get("confidence"),
                        error=item.get("error"),
                        priority=int(item.get("priority", 0) or 0),
                        expected_output=item.get("expected_output", ""),
                        review_required=bool(item.get("review_required", False)),
                        reviewer_agent_ids=item.get("reviewer_agent_ids", []) if isinstance(item.get("reviewer_agent_ids", []), list) else [],
                        review_status=item.get("review_status", ""),
                        fanout_group_id=item.get("fanout_group_id", ""),
                        merge_task_id=item.get("merge_task_id", ""),
                        source_blueprint_id=item.get("source_blueprint_id", ""),
                        source_event_id=item.get("source_event_id", ""),
                        runtime_created=bool(item.get("runtime_created", False)),
                        created_at=item.get("created_at", now_iso()),
                        updated_at=item.get("updated_at", now_iso()),
                    )
                    for item in raw.get("tasks", {}).values()
                }
                session.threads = {
                    item["id"]: CoworkThread(
                        id=item["id"],
                        topic=item["topic"],
                        participant_ids=item.get("participant_ids", []),
                        status=item.get("status", "open"),
                        summary=item.get("summary", ""),
                        message_ids=item.get("message_ids", []),
                        created_at=item.get("created_at", now_iso()),
                        updated_at=item.get("updated_at", now_iso()),
                        last_message_at=item.get("last_message_at"),
                    )
                    for item in raw.get("threads", {}).values()
                }
                session.messages = {
                    item["id"]: CoworkMessage(
                        id=item["id"],
                        thread_id=item["thread_id"],
                        sender_id=item["sender_id"],
                        recipient_ids=item.get("recipient_ids", []),
                        content=item["content"],
                        created_at=item.get("created_at", now_iso()),
                        read_by=item.get("read_by", []),
                    )
                    for item in raw.get("messages", {}).values()
                }
                session.mailbox = {
                    item["id"]: CoworkMailboxRecord(
                        id=item["id"],
                        sender_id=item["sender_id"],
                        recipient_ids=item.get("recipient_ids", []),
                        content=item.get("content", ""),
                        visibility=item.get("visibility", "direct"),
                        kind=item.get("kind", "message"),
                        topic=item.get("topic", ""),
                        event_type=item.get("event_type", ""),
                        request_type=item.get("request_type", ""),
                        status=item.get("status", "queued"),
                        thread_id=item.get("thread_id"),
                        message_id=item.get("message_id"),
                        requires_reply=bool(item.get("requires_reply", False)),
                        priority=int(item.get("priority", 0) or 0),
                        deadline_round=item.get("deadline_round"),
                        correlation_id=item.get("correlation_id"),
                        lineage_id=item.get("lineage_id"),
                        reply_to_envelope_id=item.get("reply_to_envelope_id"),
                        caused_by_envelope_id=item.get("caused_by_envelope_id"),
                        expected_output_schema=item.get("expected_output_schema", {}),
                        blocking_task_id=item.get("blocking_task_id"),
                        escalate_after_rounds=item.get("escalate_after_rounds"),
                        escalated_at=item.get("escalated_at"),
                        read_by=item.get("read_by", []),
                        replied_by=item.get("replied_by", []),
                        created_at=item.get("created_at", now_iso()),
                        updated_at=item.get("updated_at", now_iso()),
                        delivered_at=item.get("delivered_at"),
                    )
                    for item in raw.get("mailbox", {}).values()
                }
                session.events = [
                    CoworkEvent(
                        id=item["id"],
                        type=item["type"],
                        message=item["message"],
                        actor_id=item.get("actor_id"),
                        data=item.get("data", {}),
                        created_at=item.get("created_at", now_iso()),
                    )
                    for item in raw.get("events", [])
                ]
                session.trace_spans = [
                    CoworkTraceSpan(
                        id=item["id"],
                        session_id=item.get("session_id", raw["id"]),
                        run_id=item.get("run_id"),
                        round_id=item.get("round_id"),
                        kind=item.get("kind", "event"),
                        name=item.get("name", item.get("kind", "event")),
                        actor_id=item.get("actor_id"),
                        parent_id=item.get("parent_id"),
                        status=item.get("status", "completed"),
                        started_at=item.get("started_at", item.get("created_at", now_iso())),
                        ended_at=item.get("ended_at"),
                        duration_ms=item.get("duration_ms"),
                        input_ref=item.get("input_ref", ""),
                        output_ref=item.get("output_ref", ""),
                        summary=item.get("summary", ""),
                        data=item.get("data", {}) if isinstance(item.get("data", {}), dict) else {},
                        error=item.get("error"),
                    )
                    for item in raw.get("trace_spans", [])
                    if isinstance(item, dict) and item.get("id")
                ]
                session.agent_steps = self._hydrate_agent_steps(raw.get("agent_steps", []))
                session.observation_details = self._hydrate_dataclass_map(
                    raw.get("observation_details", {}),
                    CoworkFullObservationDetail,
                )
                session.sensitive_artifacts = self._hydrate_dataclass_map(
                    raw.get("sensitive_artifacts", {}),
                    CoworkSensitiveArtifact,
                )
                session.delegation_guardrails = self._hydrate_dataclass_map(
                    raw.get("delegation_guardrails", {}),
                    CoworkDelegationGuardrail,
                )
                session.delegated_briefs = self._hydrate_dataclass_map(raw.get("delegated_briefs", {}), CoworkDelegatedBrief)
                session.delegated_tasks = self._hydrate_dataclass_map(raw.get("delegated_tasks", {}), CoworkDelegatedTask)
                session.isolated_sub_agent_contexts = self._hydrate_dataclass_map(
                    raw.get("isolated_sub_agent_contexts", {}),
                    CoworkIsolatedSubAgentContext,
                )
                session.sub_agent_results = self._hydrate_dataclass_map(raw.get("sub_agent_results", {}), CoworkSubAgentResult)
                session.run_metrics = [
                    CoworkRunMetrics(
                        run_id=item["run_id"],
                        status=item.get("status", "completed"),
                        rounds=int(item.get("rounds", 0) or 0),
                        agent_calls=int(item.get("agent_calls", 0) or 0),
                        tool_calls=int(item.get("tool_calls", 0) or 0),
                        messages=int(item.get("messages", 0) or 0),
                        tasks_created=int(item.get("tasks_created", 0) or 0),
                        tasks_completed=int(item.get("tasks_completed", 0) or 0),
                        artifacts_created=int(item.get("artifacts_created", 0) or 0),
                        tokens_prompt=int(item.get("tokens_prompt", 0) or 0),
                        tokens_completion=int(item.get("tokens_completion", 0) or 0),
                        tokens_total=int(item.get("tokens_total", 0) or 0),
                        stop_reason=item.get("stop_reason", ""),
                        started_at=item.get("started_at", now_iso()),
                        ended_at=item.get("ended_at"),
                    )
                    for item in raw.get("run_metrics", [])
                    if isinstance(item, dict) and item.get("run_id")
                ]
                session.scheduler_decisions = [
                    dict(item)
                    for item in raw.get("scheduler_decisions", [])
                    if isinstance(item, dict)
                ]
                session.branches = self._hydrate_branch_map(raw.get("branches", {}), session)
                session.stage_records = self._hydrate_dataclass_list(raw.get("stage_records", []), CoworkStageRecord)
                self.ensure_session_branches(session)
                self.ensure_session_budget(session)
                sessions[session.id] = session
            self._sessions = sessions
            self._save_event_log_layout([asdict(session) for session in sessions.values()])
        except Exception as exc:
            logger.warning("Failed to load cowork store: {}", exc)
            self._sessions = {}
        return self._sessions

    def _load_event_log_sessions(self) -> dict[str, CoworkSession]:
        sessions: dict[str, CoworkSession] = {}
        for raw in self.event_log.read_snapshot_payloads():
            try:
                session = self._hydrate_session(raw)
                self._replay_event_log(session)
                self._recover_interrupted_runtime(session)
                self.ensure_session_budget(session)
                sessions[session.id] = session
            except Exception as exc:
                logger.warning("Failed to load cowork snapshot: {}", exc)
        return sessions

    def _hydrate_session(self, raw: dict[str, Any]) -> CoworkSession:
        session = CoworkSession(
            id=str(raw.get("id") or self._new_id("cw")),
            title=str(raw.get("title") or "Cowork Session"),
            goal=str(raw.get("goal") or ""),
            status=raw.get("status", "active"),
            workflow_mode=self.normalize_workflow_mode(raw.get("workflow_mode", ADAPTIVE_STARTER)),
            current_branch_id=str(raw.get("current_branch_id") or _DEFAULT_BRANCH_ID),
            current_focus_task=raw.get("current_focus_task", ""),
            workspace_dir=raw.get("workspace_dir", ""),
            artifacts=raw.get("artifacts", []) if isinstance(raw.get("artifacts", []), list) else [],
            shared_memory=self._normalize_shared_memory(raw.get("shared_memory", {})),
            shared_summary=raw.get("shared_summary", ""),
            final_draft=raw.get("final_draft", ""),
            completion_decision=raw.get("completion_decision", {}) if isinstance(raw.get("completion_decision", {}), dict) else {},
            swarm_plan=raw.get("swarm_plan", {}) if isinstance(raw.get("swarm_plan", {}), dict) else {},
            budget_limits=normalize_budget_limits(raw.get("budget_limits") or raw.get("budgets")),
            budget_usage={
                **default_budget_usage(),
                **(raw.get("budget_usage", {}) if isinstance(raw.get("budget_usage", {}), dict) else {}),
            },
            stop_reason=str(raw.get("stop_reason") or ""),
            blueprint=raw.get("blueprint", {}) if isinstance(raw.get("blueprint", {}), dict) else {},
            blueprint_diagnostics=raw.get("blueprint_diagnostics", []) if isinstance(raw.get("blueprint_diagnostics", []), list) else [],
            runtime_state=raw.get("runtime_state", {}) if isinstance(raw.get("runtime_state", {}), dict) else {},
            session_final_result=self._hydrate_optional_dataclass(
                raw.get("session_final_result"),
                CoworkSessionFinalResult,
            ),
            created_at=raw.get("created_at", now_iso()),
            updated_at=raw.get("updated_at", now_iso()),
            rounds=int(raw.get("rounds", 0) or 0),
            no_progress_rounds=int(raw.get("no_progress_rounds", 0) or 0),
        )
        session.agents = self._hydrate_dataclass_map(raw.get("agents", {}), CoworkAgent)
        session.tasks = self._hydrate_dataclass_map(raw.get("tasks", {}), CoworkTask)
        session.threads = self._hydrate_dataclass_map(raw.get("threads", {}), CoworkThread)
        session.messages = self._hydrate_dataclass_map(raw.get("messages", {}), CoworkMessage)
        session.mailbox = self._hydrate_dataclass_map(raw.get("mailbox", {}), CoworkMailboxRecord)
        session.events = self._hydrate_dataclass_list(raw.get("events", []), CoworkEvent)
        session.trace_spans = self._hydrate_dataclass_list(raw.get("trace_spans", []), CoworkTraceSpan)
        session.agent_steps = self._hydrate_agent_steps(raw.get("agent_steps", []))
        session.observation_details = self._hydrate_dataclass_map(raw.get("observation_details", {}), CoworkFullObservationDetail)
        session.sensitive_artifacts = self._hydrate_dataclass_map(raw.get("sensitive_artifacts", {}), CoworkSensitiveArtifact)
        session.delegation_guardrails = self._hydrate_dataclass_map(raw.get("delegation_guardrails", {}), CoworkDelegationGuardrail)
        session.delegated_briefs = self._hydrate_dataclass_map(raw.get("delegated_briefs", {}), CoworkDelegatedBrief)
        session.delegated_tasks = self._hydrate_dataclass_map(raw.get("delegated_tasks", {}), CoworkDelegatedTask)
        session.isolated_sub_agent_contexts = self._hydrate_dataclass_map(raw.get("isolated_sub_agent_contexts", {}), CoworkIsolatedSubAgentContext)
        session.sub_agent_results = self._hydrate_dataclass_map(raw.get("sub_agent_results", {}), CoworkSubAgentResult)
        session.run_metrics = self._hydrate_dataclass_list(raw.get("run_metrics", []), CoworkRunMetrics)
        session.scheduler_decisions = [dict(item) for item in raw.get("scheduler_decisions", []) if isinstance(item, dict)]
        session.branches = self._hydrate_branch_map(raw.get("branches", {}), session)
        session.stage_records = self._hydrate_dataclass_list(raw.get("stage_records", []), CoworkStageRecord)
        self.ensure_session_branches(session)
        return session

    def _hydrate_branch_map(self, raw: Any, session: CoworkSession) -> dict[str, CoworkBranch]:
        items = raw.values() if isinstance(raw, dict) else raw if isinstance(raw, list) else []
        result: dict[str, CoworkBranch] = {}
        for item in items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            payload = dict(item)
            payload["architecture"] = self.normalize_workflow_mode(payload.get("architecture", session.workflow_mode))
            payload["branch_result"] = self._hydrate_optional_dataclass(payload.get("branch_result"), CoworkBranchResult)
            branch = self._hydrate_dataclass(payload, CoworkBranch)
            result[branch.id] = branch
        return result

    def _hydrate_dataclass_map(self, raw: Any, cls: type[Any]) -> dict[str, Any]:
        items = raw.values() if isinstance(raw, dict) else raw if isinstance(raw, list) else []
        result: dict[str, Any] = {}
        for item in items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            hydrated = self._hydrate_dataclass(item, cls)
            result[getattr(hydrated, "id")] = hydrated
        return result

    def _hydrate_dataclass_list(self, raw: Any, cls: type[Any]) -> list[Any]:
        if not isinstance(raw, list):
            return []
        return [self._hydrate_dataclass(item, cls) for item in raw if isinstance(item, dict)]

    def _hydrate_optional_dataclass(self, raw: Any, cls: type[Any]) -> Any | None:
        if not isinstance(raw, dict) or not raw:
            return None
        return self._hydrate_dataclass(raw, cls)

    def _hydrate_agent_steps(self, raw: Any) -> list[CoworkAgentStep]:
        if not isinstance(raw, list):
            return []
        steps: list[CoworkAgentStep] = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            payload = dict(item)
            payload["tool_observations"] = self._hydrate_dataclass_list(
                payload.get("tool_observations", []),
                CoworkToolObservation,
            )
            payload["browser_observations"] = self._hydrate_dataclass_list(
                payload.get("browser_observations", []),
                CoworkBrowserObservation,
            )
            payload["summary"] = self._hydrate_optional_dataclass(payload.get("summary"), CoworkStepSummary)
            steps.append(self._hydrate_dataclass(payload, CoworkAgentStep))
        return steps

    def _hydrate_dataclass(self, raw: dict[str, Any], cls: type[Any]) -> Any:
        kwargs: dict[str, Any] = {}
        for field_info in fields(cls):
            if field_info.name in raw:
                kwargs[field_info.name] = raw[field_info.name]
            elif field_info.default is not MISSING:
                kwargs[field_info.name] = field_info.default
            elif field_info.default_factory is not MISSING:  # type: ignore[comparison-overlap]
                kwargs[field_info.name] = field_info.default_factory()  # type: ignore[misc]
        return cls(**kwargs)

    def _replay_event_log(self, session: CoworkSession) -> None:
        known_event_ids = {event.id for event in session.events}
        known_span_ids = {span.id for span in session.trace_spans}
        for record in self.event_log.read_events(session.id):
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            if record.get("category") == "event":
                event_payload = payload.get("event") if isinstance(payload.get("event"), dict) else payload
                event_id = str(event_payload.get("id") or record.get("id") or "")
                if event_id and event_id not in known_event_ids:
                    event_payload = {
                        "id": event_id,
                        "type": event_payload.get("type") or record.get("type") or "event",
                        "message": event_payload.get("message") or "",
                        "actor_id": event_payload.get("actor_id") or record.get("actor_id"),
                        "data": event_payload.get("data", {}) if isinstance(event_payload.get("data", {}), dict) else {},
                        "created_at": event_payload.get("created_at") or record.get("created_at") or now_iso(),
                    }
                    session.events.append(self._hydrate_dataclass(event_payload, CoworkEvent))
                    known_event_ids.add(event_id)
            elif record.get("category") == "trace":
                span_payload = payload.get("span") if isinstance(payload.get("span"), dict) else payload
                span_id = str(span_payload.get("id") or record.get("id") or "")
                if span_id and span_id not in known_span_ids:
                    span_payload = {"id": span_id, "session_id": session.id, **span_payload}
                    session.trace_spans.append(self._hydrate_dataclass(span_payload, CoworkTraceSpan))
                    known_span_ids.add(span_id)
        session.events = session.events[-_MAX_EVENT_COUNT:]
        session.trace_spans = session.trace_spans[-_MAX_TRACE_SPAN_COUNT:]

    def _recover_interrupted_runtime(self, session: CoworkSession) -> None:
        recovered = False
        for span in session.trace_spans:
            if span.status in {"pending", "running", "in_progress"} and not span.ended_at:
                span.status = "failed"
                span.ended_at = now_iso()
                span.error = span.error or "Interrupted before the process stopped."
                span.summary = span.summary or "Interrupted runtime span recovered on load."
                recovered = True
        if recovered:
            session.runtime_state["interrupted_span_recovery_at"] = now_iso()

    def _save(self) -> None:
        if self._sessions is None:
            return
        self._ensure_dir()
        for session in self._sessions.values():
            self.ensure_session_branches(session)
            self._capture_current_branch_state(session)
        data = {"version": 1, "sessions": [asdict(s) for s in self._sessions.values()]}
        fd, temp_path = tempfile.mkstemp(dir=self.cowork_dir, suffix=".json")
        try:
            with open(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, ensure_ascii=False)
            Path(temp_path).replace(self.store_path)
            self._save_event_log_layout(data["sessions"])
        except Exception:
            Path(temp_path).unlink(missing_ok=True)
            raise

    def _save_event_log_layout(self, sessions: list[dict[str, Any]]) -> None:
        for raw in sessions:
            session_id = str(raw.get("id") or "")
            if not session_id:
                continue
            self.event_log.write_snapshot(session_id, raw)
            session = self._sessions.get(session_id) if self._sessions else None
            if session is not None:
                self.event_log.write_artifact_index(session_id, build_cowork_artifact_index(session))

    def list_sessions(self, include_completed: bool = False) -> list[CoworkSession]:
        sessions = list(self._load().values())
        if not include_completed:
            sessions = [s for s in sessions if s.status != "completed"]
        return sorted(sessions, key=lambda item: item.updated_at, reverse=True)

    def get_session(self, session_id: str) -> CoworkSession | None:
        session = self._load().get(session_id)
        if session is not None:
            self.ensure_session_branches(session)
        return session

    def ensure_session_branches(self, session: CoworkSession) -> None:
        """Migrate branchless sessions to a default branch in memory."""
        session.workflow_mode = self.normalize_workflow_mode(getattr(session, "workflow_mode", ADAPTIVE_STARTER))
        branches = getattr(session, "branches", None)
        if not isinstance(branches, dict):
            session.branches = {}
        if _DEFAULT_BRANCH_ID not in session.branches:
            session.branches[_DEFAULT_BRANCH_ID] = CoworkBranch(
                id=_DEFAULT_BRANCH_ID,
                title="Default branch",
                architecture=session.workflow_mode,
                status=session.status,
                topology_reference={
                    "branch_id": _DEFAULT_BRANCH_ID,
                    "architecture": session.workflow_mode,
                },
                runtime_state={
                    "current_focus_task": getattr(session, "current_focus_task", ""),
                    "rounds": getattr(session, "rounds", 0),
                },
                completion_decision=dict(getattr(session, "completion_decision", {}) or {}),
                created_at=getattr(session, "created_at", now_iso()),
                updated_at=getattr(session, "updated_at", now_iso()),
            )
        for branch in session.branches.values():
            branch.architecture = self.normalize_workflow_mode(branch.architecture)
            branch.topology_reference = branch.topology_reference or {
                "branch_id": branch.id,
                "architecture": branch.architecture,
            }
        if not getattr(session, "current_branch_id", "") or session.current_branch_id not in session.branches:
            session.current_branch_id = _DEFAULT_BRANCH_ID

    def current_branch(self, session: CoworkSession) -> CoworkBranch:
        self.ensure_session_branches(session)
        return session.branches[session.current_branch_id]

    def list_branches(self, session: CoworkSession) -> list[CoworkBranch]:
        self.ensure_session_branches(session)
        return sorted(session.branches.values(), key=lambda item: item.created_at)

    def branch_results(self, session: CoworkSession) -> list[CoworkBranchResult]:
        self.ensure_session_branches(session)
        results = [branch.branch_result for branch in session.branches.values() if branch.branch_result is not None]
        return sorted(results, key=lambda item: item.created_at)

    def _capture_current_branch_state(self, session: CoworkSession) -> None:
        self.ensure_session_branches(session)
        branch = session.branches[session.current_branch_id]
        branch.architecture = self.normalize_workflow_mode(session.workflow_mode)
        branch.status = session.status
        branch.completion_decision = dict(getattr(session, "completion_decision", {}) or {})
        branch.runtime_state = {
            **(branch.runtime_state or {}),
            "current_focus_task": getattr(session, "current_focus_task", ""),
            "rounds": getattr(session, "rounds", 0),
            "no_progress_rounds": getattr(session, "no_progress_rounds", 0),
            "stop_reason": getattr(session, "stop_reason", ""),
        }
        if branch.status == "completed" and branch.branch_result is None:
            self._record_branch_result(session, branch, save=False)
        branch.updated_at = now_iso()

    def _record_branch_result(
        self,
        session: CoworkSession,
        branch: CoworkBranch,
        *,
        save: bool = True,
    ) -> CoworkBranchResult:
        if branch.branch_result is not None:
            return branch.branch_result
        completed = [task for task in session.tasks.values() if task.status == "completed"]
        confidence_values = [task.confidence for task in completed if task.confidence is not None]
        confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
        summary = (getattr(session, "final_draft", "") or getattr(session, "shared_summary", "") or "").strip()
        if not summary:
            summary = self._build_final_draft(session).strip()
        if not summary:
            summary = f"Branch '{branch.title}' completed for goal: {session.goal}"
        result = CoworkBranchResult(
            id=self._new_id("brres"),
            source_branch_id=branch.id,
            source_architecture=branch.architecture,
            summary=summary,
            artifacts=list(getattr(session, "artifacts", [])[-20:]),
            decision=dict(getattr(session, "completion_decision", {}) or branch.completion_decision or {}),
            confidence=confidence,
        )
        branch.branch_result = result
        branch.updated_at = now_iso()
        self.add_event(
            session,
            "branch.result.created",
            f"Branch '{branch.id}' produced a result",
            actor_id="system",
            data={
                "branch_id": branch.id,
                "branch_result_id": result.id,
                "architecture": branch.architecture,
            },
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return result

    def select_session_final_result(
        self,
        session: CoworkSession,
        branch_id: str,
        result_id: str | None = None,
        *,
        save: bool = True,
    ) -> CoworkSessionFinalResult | str:
        self.ensure_session_branches(session)
        branch = session.branches.get(branch_id)
        if branch is None:
            return f"Error: branch '{branch_id}' not found."
        result = branch.branch_result
        if result is None:
            return f"Error: branch '{branch_id}' has no result to select."
        if result_id and result.id != result_id:
            return f"Error: branch result '{result_id}' not found on branch '{branch_id}'."
        final = CoworkSessionFinalResult(
            id=self._new_id("final"),
            source="selected_branch_result",
            selected_branch_id=branch.id,
            selected_result_id=result.id,
            source_branch_ids=[branch.id],
            source_result_ids=[result.id],
            summary=result.summary,
            artifacts=list(result.artifacts),
            decision=dict(result.decision),
            confidence=result.confidence,
        )
        session.session_final_result = final
        self.add_event(
            session,
            "session.final_result.selected",
            f"Selected branch result '{result.id}' as the session final result",
            actor_id="user",
            data={
                "selected_branch_id": branch.id,
                "selected_result_id": result.id,
                "session_final_result_id": final.id,
            },
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return final

    def merge_branch_results(
        self,
        session: CoworkSession,
        branch_ids: list[str],
        *,
        summary: str = "",
        save: bool = True,
    ) -> CoworkSessionFinalResult | str:
        self.ensure_session_branches(session)
        selected_ids = [branch_id for branch_id in dict.fromkeys(branch_ids) if branch_id in session.branches]
        if len(selected_ids) < 2:
            return "Error: at least two existing branches are required to merge branch results."
        results: list[CoworkBranchResult] = []
        missing = []
        for branch_id in selected_ids:
            result = session.branches[branch_id].branch_result
            if result is None:
                missing.append(branch_id)
            else:
                results.append(result)
        if missing:
            return f"Error: branch result missing for: {', '.join(missing)}."
        confidence_values = [item.confidence for item in results if item.confidence is not None]
        confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
        merged_summary = summary.strip() or "\n\n".join(
            f"## {session.branches[item.source_branch_id].title}\n{item.summary}" for item in results
        )
        final = CoworkSessionFinalResult(
            id=self._new_id("final"),
            source="branch_merge",
            source_branch_ids=selected_ids,
            source_result_ids=[item.id for item in results],
            summary=merged_summary,
            artifacts=list(dict.fromkeys(artifact for item in results for artifact in item.artifacts)),
            decision={
                "operation": "branch_merge",
                "source_branch_ids": selected_ids,
                "source_result_ids": [item.id for item in results],
                "created_at": now_iso(),
            },
            confidence=confidence,
        )
        session.session_final_result = final
        self.add_event(
            session,
            "session.final_result.merged",
            f"Merged {len(results)} branch results into a candidate session final result",
            actor_id="user",
            data={
                "source_branch_ids": selected_ids,
                "source_result_ids": [item.id for item in results],
                "session_final_result_id": final.id,
            },
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return final

    def select_branch(self, session: CoworkSession, branch_id: str, *, save: bool = True) -> CoworkBranch | str:
        self.ensure_session_branches(session)
        if branch_id not in session.branches:
            return f"Error: branch '{branch_id}' not found."
        self._capture_current_branch_state(session)
        branch = session.branches[branch_id]
        session.current_branch_id = branch.id
        session.workflow_mode = branch.architecture  # type: ignore[assignment]
        session.status = branch.status
        session.completion_decision = dict(branch.completion_decision or {})
        session.current_focus_task = str((branch.runtime_state or {}).get("current_focus_task") or session.current_focus_task)
        self.add_event(
            session,
            "branch.selected",
            f"Selected cowork branch '{branch.id}'",
            actor_id="user",
            data={"branch_id": branch.id, "architecture": branch.architecture},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return branch

    def derive_branch(
        self,
        session: CoworkSession,
        *,
        source_branch_id: str | None = None,
        target_architecture: str = ADAPTIVE_STARTER,
        reason: str = "",
        title: str = "",
        inherited_context_summary: str = "",
        save: bool = True,
    ) -> CoworkBranch | str:
        self.ensure_session_branches(session)
        source_id = source_branch_id or session.current_branch_id
        if source_id not in session.branches:
            return f"Error: source branch '{source_id}' not found."
        self._capture_current_branch_state(session)
        architecture = self.normalize_workflow_mode(target_architecture)
        branch_id = self._new_id("br")
        source = session.branches[source_id]
        summary = inherited_context_summary.strip() or self._stage_context_summary(session, source)
        stage_id = self._new_id("stage")
        event_id = self._new_id("evt")
        stage = CoworkStageRecord(
            id=stage_id,
            source_branch_id=source_id,
            target_branch_id=branch_id,
            source_architecture=source.architecture,
            target_architecture=architecture,
            derivation_reason=reason.strip(),
            source_summary=self._stage_source_summary(session, source),
            inherited_context_summary=summary,
            artifact_refs=list(getattr(session, "artifacts", [])[-20:]),
            message_refs=self._stage_message_refs(session),
            decisions=self._stage_decisions(session),
        )
        session.stage_records.append(stage)
        branch = CoworkBranch(
            id=branch_id,
            title=title.strip() or f"{architecture.replace('_', ' ').title()} branch",
            architecture=architecture,
            status="active",
            topology_reference={"branch_id": branch_id, "architecture": architecture},
            source_branch_id=source_id,
            source_stage_record_id=stage_id,
            derivation_event_id=event_id,
            derivation_reason=reason.strip(),
            inherited_context_summary=summary,
            runtime_state={"current_focus_task": summary or session.goal, "source_branch_status": source.status},
            completion_decision={},
        )
        session.branches[branch_id] = branch
        session.current_branch_id = branch_id
        session.workflow_mode = architecture  # type: ignore[assignment]
        session.status = "active"
        session.current_focus_task = branch.runtime_state["current_focus_task"]
        self.add_event(
            session,
            "branch.derived",
            f"Derived branch '{branch.id}' from '{source_id}'",
            actor_id="user",
            data={
                "branch_id": branch.id,
                "source_branch_id": source_id,
                "target_architecture": architecture,
                "derivation_reason": reason.strip(),
                "stage_record_id": stage_id,
                "derivation_event_id": event_id,
                "inherited_context_summary": summary,
            },
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return branch

    def _stage_context_summary(self, session: CoworkSession, source: CoworkBranch) -> str:
        parts = [
            getattr(session, "shared_summary", ""),
            getattr(session, "final_draft", ""),
            (source.runtime_state or {}).get("current_focus_task", ""),
            getattr(session, "current_focus_task", ""),
        ]
        text = " ".join(str(part or "").strip() for part in parts if str(part or "").strip())
        return text[:1200]

    def _stage_source_summary(self, session: CoworkSession, source: CoworkBranch) -> str:
        return (
            f"{source.title} ({source.architecture}) is {source.status}. "
            f"Goal: {session.goal}. Focus: {(source.runtime_state or {}).get('current_focus_task') or session.current_focus_task}"
        )[:1200]

    def _stage_message_refs(self, session: CoworkSession) -> list[dict[str, Any]]:
        return [
            {
                "id": message.id,
                "thread_id": message.thread_id,
                "sender_id": message.sender_id,
                "recipient_ids": list(message.recipient_ids),
                "summary": message.content[:240],
                "created_at": message.created_at,
            }
            for message in list(session.messages.values())[-12:]
        ]

    def _stage_decisions(self, session: CoworkSession) -> list[dict[str, Any]]:
        decisions = []
        if isinstance(getattr(session, "completion_decision", {}), dict) and session.completion_decision:
            decisions.append({"kind": "completion_decision", **session.completion_decision})
        memory = getattr(session, "shared_memory", {}) or {}
        for item in memory.get("decisions", [])[-8:] if isinstance(memory, dict) else []:
            if isinstance(item, dict):
                decisions.append(dict(item))
        return decisions

    def add_listener(self, listener: Callable[[CoworkSession, CoworkEvent], None]) -> None:
        if listener not in self._listeners:
            self._listeners.append(listener)

    def delete_session(self, session_id: str) -> bool:
        sessions = self._load()
        if session_id not in sessions:
            return False
        del sessions[session_id]
        self._save()
        return True

    def validate_blueprint(self, blueprint: dict[str, Any], *, default_goal: str = "") -> dict[str, Any]:
        return validate_blueprint(blueprint, default_goal=default_goal)

    def preview_blueprint(self, blueprint: dict[str, Any], *, default_goal: str = "") -> dict[str, Any]:
        return preview_blueprint(blueprint, default_goal=default_goal)

    def export_blueprint(self, session: CoworkSession) -> dict[str, Any]:
        return export_session_blueprint(session)

    def create_session_from_blueprint(self, blueprint: dict[str, Any]) -> tuple[CoworkSession | None, list[dict[str, Any]]]:
        preview = self.preview_blueprint(blueprint)
        diagnostics = list(preview.get("diagnostics", []))
        if not preview.get("ok"):
            return None, diagnostics
        normalized = preview["blueprint"]
        inputs = session_inputs_from_blueprint(normalized)
        agents = []
        for agent in inputs["agents"]:
            raw = dict(agent)
            raw["source_blueprint_id"] = agent.get("id", "")
            agents.append(raw)
        tasks = []
        for task in inputs["tasks"]:
            raw = dict(task)
            raw["source_blueprint_id"] = task.get("id", "")
            tasks.append(raw)
        session = self.create_session(
            goal=inputs["goal"],
            title=inputs["title"],
            agents=agents,
            tasks=tasks,
            workflow_mode=inputs["workflow_mode"],
            budgets=inputs["budgets"],
            blueprint=normalized,
            blueprint_diagnostics=diagnostics,
        )
        self.add_event(
            session,
            "blueprint.compiled",
            "Cowork blueprint compiled into a session",
            actor_id="user",
            data={"blueprint_id": normalized.get("id"), "diagnostics": diagnostics},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="blueprint",
            name="Blueprint compiled",
            actor_id="user",
            summary="Cowork blueprint compiled into a session",
            data={"blueprint_id": normalized.get("id"), "agent_count": len(agents), "task_count": len(tasks)},
            save=False,
        )
        self._touch(session)
        self._save()
        return session, diagnostics

    def ensure_session_budget(self, session: CoworkSession) -> dict[str, Any]:
        session.budget_limits = normalize_budget_limits(getattr(session, "budget_limits", {}) or {})
        usage = default_budget_usage()
        raw_usage = getattr(session, "budget_usage", {}) or {}
        if isinstance(raw_usage, dict):
            usage.update(raw_usage)
        session.budget_usage = usage
        if getattr(session, "stop_reason", ""):
            session.budget_usage["stop_reason"] = session.stop_reason
        return self.budget_state(session)

    def budget_state(self, session: CoworkSession) -> dict[str, Any]:
        limits = normalize_budget_limits(getattr(session, "budget_limits", {}) or {})
        usage = default_budget_usage()
        usage.update(getattr(session, "budget_usage", {}) or {})
        stop_reason = getattr(session, "stop_reason", "") or usage.get("stop_reason", "")
        usage["stop_reason"] = stop_reason
        return {
            "limits": limits,
            "usage": usage,
            "remaining": budget_remaining(limits, usage),
            "stop_reason": stop_reason,
        }

    def swarm_scheduler_queues(self, session: CoworkSession) -> dict[str, Any]:
        return build_swarm_scheduler_queues(session)

    def set_session_budgets(self, session: CoworkSession, budgets: dict[str, Any], *, save: bool = True) -> dict[str, Any]:
        session.budget_limits = normalize_budget_limits({**(getattr(session, "budget_limits", {}) or {}), **(budgets or {})})
        self.ensure_session_budget(session)
        self.add_event(
            session,
            "budget.updated",
            "Cowork budget limits updated",
            actor_id="user",
            data={"budget": self.budget_state(session)},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return self.budget_state(session)

    def record_budget_usage(
        self,
        session: CoworkSession,
        *,
        rounds: int = 0,
        agent_calls: int = 0,
        spawned_agents: int = 0,
        tool_calls: int = 0,
        tokens_prompt: int = 0,
        tokens_completion: int = 0,
        cost: float = 0.0,
        wall_time_seconds: float = 0.0,
        save: bool = False,
    ) -> dict[str, Any]:
        self.ensure_session_budget(session)
        usage = session.budget_usage
        usage["rounds"] = int(usage.get("rounds", 0) or 0) + max(0, int(rounds or 0))
        usage["agent_calls"] = int(usage.get("agent_calls", 0) or 0) + max(0, int(agent_calls or 0))
        usage["spawned_agents"] = int(usage.get("spawned_agents", 0) or 0) + max(0, int(spawned_agents or 0))
        usage["tool_calls"] = int(usage.get("tool_calls", 0) or 0) + max(0, int(tool_calls or 0))
        usage["tokens_prompt"] = int(usage.get("tokens_prompt", 0) or 0) + max(0, int(tokens_prompt or 0))
        usage["tokens_completion"] = int(usage.get("tokens_completion", 0) or 0) + max(0, int(tokens_completion or 0))
        usage["tokens_total"] = usage["tokens_prompt"] + usage["tokens_completion"]
        usage["cost"] = float(usage.get("cost", 0.0) or 0.0) + max(0.0, float(cost or 0.0))
        usage["wall_time_seconds"] = float(usage.get("wall_time_seconds", 0.0) or 0.0) + max(0.0, float(wall_time_seconds or 0.0))
        if save:
            self._touch(session)
            self._save()
        return self.budget_state(session)

    def steer_swarm(self, session: CoworkSession, instruction: str, *, save: bool = True) -> str:
        text = instruction.strip()
        if not text:
            return "Error: instruction is required"
        lead_id = self.lead_agent_id(session)
        self.send_message(session, sender_id="user", recipient_ids=[lead_id], content=text, save=False)
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if plan:
            updates = plan.setdefault("user_steering", [])
            if isinstance(updates, list):
                updates.append({"instruction": text, "created_at": now_iso(), "actor_id": "user"})
                if len(updates) > 40:
                    plan["user_steering"] = updates[-40:]
            plan["updated_at"] = now_iso()
            if plan.get("status") == "blocked":
                plan["status"] = "active"
            session.swarm_plan = plan
        self.add_event(
            session,
            "swarm.user_steered",
            "User steering instruction routed to the swarm lead",
            actor_id="user",
            data={"lead_agent_id": lead_id, "instruction": text[:500]},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="swarm",
            name="User steering",
            actor_id="user",
            status="completed",
            summary="User steering instruction routed to the swarm lead",
            data={"lead_agent_id": lead_id, "instruction": text[:500]},
            save=False,
        )
        if session.status == "completed":
            session.status = "active"
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return f"Steering instruction routed to {lead_id}."

    def budget_exhaustion_reason(
        self,
        session: CoworkSession,
        *,
        run_agent_calls: int = 0,
        run_agent_call_limit: int | None = None,
        elapsed_wall_time_seconds: float | None = None,
    ) -> str:
        state = self.budget_state(session)
        limits = state["limits"]
        usage = state["usage"]
        if run_agent_call_limit is not None and run_agent_calls >= run_agent_call_limit:
            return "agent_call_budget_exhausted"
        max_wall_time = limits.get("max_wall_time_seconds")
        if max_wall_time is not None and elapsed_wall_time_seconds is not None and elapsed_wall_time_seconds >= float(max_wall_time):
            return "wall_time_budget_exhausted"
        if session.workflow_mode == "swarm" and limits.get("max_work_units") is not None:
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
            if len(units) > int(limits["max_work_units"]):
                return "work_unit_budget_exhausted"
        checks = (
            ("max_agent_calls_total", "agent_calls", "agent_call_budget_exhausted"),
            ("max_tool_calls", "tool_calls", "tool_call_budget_exhausted"),
            ("max_tokens", "tokens_total", "token_budget_exhausted"),
            ("max_cost", "cost", "cost_budget_exhausted"),
        )
        for limit_key, usage_key, reason in checks:
            limit = limits.get(limit_key)
            if limit is not None and usage.get(usage_key, 0) >= limit:
                return reason
        return ""

    def record_stop_reason(
        self,
        session: CoworkSession,
        stop_reason: str,
        explanation: str,
        *,
        run_id: str | None = None,
        round_id: str | None = None,
        parent_id: str | None = None,
        data: dict[str, Any] | None = None,
        save: bool = False,
    ) -> None:
        session.stop_reason = stop_reason
        self.ensure_session_budget(session)
        session.budget_usage["stop_reason"] = stop_reason
        if stop_reason == "agent_call_budget_exhausted":
            event_type = "scheduler.agent_budget_exhausted"
        elif "budget_exhausted" in stop_reason:
            event_type = "scheduler.budget_exhausted"
        else:
            event_type = "scheduler.stop"
        payload = {"stop_reason": stop_reason, **(data or {})}
        self.add_event(session, event_type, explanation, actor_id="scheduler", data=payload, save=False)
        self.add_trace_event(
            session,
            kind="scheduler",
            name="Stop reason",
            status="blocked" if "budget_exhausted" in stop_reason or "blocker" in stop_reason else "completed",
            actor_id="scheduler",
            run_id=run_id,
            round_id=round_id,
            parent_id=parent_id,
            summary=explanation,
            data=payload,
            save=False,
        )
        if save:
            self._touch(session)
            self._save()

    def emergency_stop(
        self,
        session: CoworkSession,
        *,
        reason: str = "",
        actor_id: str = "user",
        save: bool = True,
    ) -> CoworkAgentStep:
        explanation = reason.strip() or "Emergency Stop requested by user."
        session.status = "paused"
        branch = session.branches.get(session.current_branch_id or _DEFAULT_BRANCH_ID)
        if branch:
            branch.status = "paused"
            branch.updated_at = now_iso()
        self.record_stop_reason(
            session,
            "emergency_stop",
            explanation,
            data={
                "control_scope": "emergency_stop",
                "actor_id": actor_id,
                "branch_id": session.current_branch_id or _DEFAULT_BRANCH_ID,
            },
            save=False,
        )
        step = self.start_agent_step(
            session,
            agent_id="scheduler",
            action_kind="emergency_stop",
            scheduler_reason=explanation,
            input_summary=reason,
            save=False,
        )
        self.finish_agent_step(
            session,
            step,
            status="stopped",
            output_summary="Emergency Stop recorded; future scheduling is paused.",
            detail_content=explanation,
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return step

    def create_session(
        self,
        goal: str,
        title: str,
        agents: list[dict[str, Any]],
        tasks: list[dict[str, Any]],
        *,
        workflow_mode: str = ADAPTIVE_STARTER,
        budgets: dict[str, Any] | None = None,
        blueprint: dict[str, Any] | None = None,
        blueprint_diagnostics: list[dict[str, Any]] | None = None,
    ) -> CoworkSession:
        sessions = self._load()
        session_id = self._new_id("cw")
        mode = self.normalize_workflow_mode(workflow_mode)
        policy = self.architecture_policy(mode)
        session = CoworkSession(id=session_id, title=title.strip() or "Cowork Session", goal=goal, workflow_mode=mode)  # type: ignore[arg-type]
        session.shared_memory = self._normalize_shared_memory(session.shared_memory)
        session.budget_limits = normalize_budget_limits(budgets)
        session.budget_usage = default_budget_usage()
        session.stop_reason = ""
        session.blueprint = blueprint or {}
        session.blueprint_diagnostics = blueprint_diagnostics or []
        for raw in agents:
            agent_id = self._slug(raw.get("id") or raw.get("name") or raw.get("role") or "agent")
            base_id = agent_id
            counter = 2
            while agent_id in session.agents:
                agent_id = f"{base_id}_{counter}"
                counter += 1
            session.agents[agent_id] = CoworkAgent(
                id=agent_id,
                name=str(raw.get("name") or agent_id).strip(),
                role=str(raw.get("role") or "Collaborator").strip(),
                goal=str(raw.get("goal") or goal).strip(),
                responsibilities=[str(x).strip() for x in raw.get("responsibilities", []) if str(x).strip()],
                tools=[str(x).strip() for x in raw.get("tools", []) if str(x).strip()],
                subscriptions=self._agent_subscriptions(raw),
                communication_policy=str(raw.get("communication_policy") or "").strip()
                or "Coordinate through cowork messages when another agent can unblock or verify work.",
                context_policy=str(raw.get("context_policy") or "").strip()
                or "Keep a concise private summary and refer to artifacts or thread summaries instead of full logs.",
                parent_agent_id=raw.get("parent_agent_id"),
                team_id=str(raw.get("team_id") or "").strip(),
                lifetime=str(raw.get("lifetime") or "persistent").strip() or "persistent",
                lifecycle_status=str(raw.get("lifecycle_status") or "active").strip() or "active",
                source_blueprint_id=str(raw.get("source_blueprint_id") or raw.get("id") or agent_id).strip(),
                source_event_id=str(raw.get("source_event_id") or "").strip(),
                spawn_reason=str(raw.get("spawn_reason") or "").strip(),
                delegated_task_id=str(raw.get("delegated_task_id") or "").strip(),
                delegated_brief_id=str(raw.get("delegated_brief_id") or "").strip(),
                isolated_context_id=str(raw.get("isolated_context_id") or "").strip(),
                sub_agent_scope=str(raw.get("sub_agent_scope") or "").strip(),
            )

        if not session.agents:
            for raw in self.default_team(goal, workflow_mode=mode):
                session.agents[raw["id"]] = CoworkAgent(**raw)

        for raw in tasks:
            raw_assigned = str(raw.get("assigned_agent_id") or "").strip()
            assigned = self._slug(raw_assigned) if raw_assigned else ""
            if not assigned:
                assigned_agent_id = None
            elif assigned in session.agents:
                assigned_agent_id = assigned
            else:
                assigned_agent_id = next(iter(session.agents))
            task_id = self._slug(raw.get("id") or raw.get("title") or "task")
            base_id = task_id
            counter = 2
            while task_id in session.tasks:
                task_id = f"{base_id}_{counter}"
                counter += 1
            session.tasks[task_id] = CoworkTask(
                id=task_id,
                title=str(raw.get("title") or task_id).strip(),
                description=str(raw.get("description") or raw.get("title") or goal).strip(),
                assigned_agent_id=assigned_agent_id,
                dependencies=[self._slug(x) for x in raw.get("dependencies", [])],
                priority=int(raw.get("priority", 0) or 0),
                expected_output=str(raw.get("expected_output") or "").strip(),
                review_required=bool(raw.get("review_required", False)),
                reviewer_agent_ids=[self._slug(x) for x in raw.get("reviewer_agent_ids", [])],
                fanout_group_id=str(raw.get("fanout_group_id") or "").strip(),
                merge_task_id=self._slug(raw.get("merge_task_id")) if raw.get("merge_task_id") else "",
                source_blueprint_id=str(raw.get("source_blueprint_id") or raw.get("id") or task_id).strip(),
                source_event_id=str(raw.get("source_event_id") or "").strip(),
                runtime_created=bool(raw.get("runtime_created", False)),
            )

        if not session.tasks:
            first_agent = next(iter(session.agents))
            session.tasks["1"] = CoworkTask(
                id="1",
                title="Initial analysis",
                description=f"Analyze the goal and propose concrete next steps: {goal}",
                assigned_agent_id=first_agent,
            )

        if session.workflow_mode == "swarm":
            session.swarm_plan = normalize_swarm_plan(
                (blueprint or {}).get("swarm_plan") if isinstance(blueprint, dict) else None,
                goal=goal,
                lead_agent_id=self.lead_agent_id(session),
                agents=session.agents,
                tasks=session.tasks,
                budgets=session.budget_limits,
                policy=(blueprint or {}).get("policy") if isinstance(blueprint, dict) else None,
                source_blueprint_id=(blueprint or {}).get("id", "") if isinstance(blueprint, dict) else "",
            )

        session.current_focus_task = self._derive_focus_task(session) or goal

        lead_id = self.lead_agent_id(session)
        kickoff = self.create_thread(session, "Kickoff", ["user", lead_id], save=False)
        self.send_message(
            session,
            sender_id="user",
            recipient_ids=[lead_id],
            content=f"Goal: {goal}",
            thread_id=kickoff.id,
            save=False,
        )
        self.add_event(
            session,
            "session.created",
            f"Created cowork session '{session.title}'",
            data={
                "goal": goal,
                "workflow_mode": session.workflow_mode,
                "architecture": session.workflow_mode,
                "architecture_policy": policy.__class__.__name__,
                "focus_task": session.current_focus_task,
            },
            save=False,
        )
        self.add_trace_event(
            session,
            kind="session",
            name="Session created",
            actor_id="user",
            summary=f"Created cowork session '{session.title}'",
            data={
                "goal": goal,
                "workflow_mode": session.workflow_mode,
                "architecture": session.workflow_mode,
                "architecture_policy": policy.__class__.__name__,
                "focus_task": session.current_focus_task,
            },
            save=False,
        )
        if session.swarm_plan:
            self.add_trace_event(
                session,
                kind="swarm",
                name="Swarm plan created",
                actor_id=self.lead_agent_id(session),
                status=session.swarm_plan.get("status", "active"),
                summary=f"Created swarm plan with {len(session.swarm_plan.get('work_units', []))} work unit(s)",
                data={
                    "plan_id": session.swarm_plan.get("id"),
                    "strategy": session.swarm_plan.get("strategy"),
                    "work_unit_ids": [unit.get("id") for unit in session.swarm_plan.get("work_units", [])],
                    "diagnostics": session.swarm_plan.get("diagnostics", []),
                },
                save=False,
            )
        self.assess_session(session, save=False)
        self.ensure_session_branches(session)
        self._capture_current_branch_state(session)
        sessions[session.id] = session
        self._touch(session)
        self._save()
        return session

    def create_thread(
        self,
        session: CoworkSession,
        topic: str,
        participant_ids: list[str],
        *,
        save: bool = True,
    ) -> CoworkThread:
        valid = [item for item in dict.fromkeys(participant_ids) if item in session.agents or item == "user"]
        thread_id = self._new_id("th")
        thread = CoworkThread(id=thread_id, topic=topic.strip() or "Discussion", participant_ids=valid)
        session.threads[thread_id] = thread
        self.add_event(session, "thread.created", f"Thread '{thread.topic}' created", data={"thread_id": thread_id}, save=False)
        self._touch(session)
        if save:
            self._save()
        return thread

    def send_message(
        self,
        session: CoworkSession,
        sender_id: str,
        recipient_ids: list[str],
        content: str,
        thread_id: str | None = None,
        *,
        save: bool = True,
    ) -> CoworkMessage:
        valid_recipients = [item for item in dict.fromkeys(recipient_ids) if item in session.agents or item == "user"]
        if not valid_recipients:
            valid_recipients = list(session.agents)
        if not thread_id or thread_id not in session.threads:
            thread = self.create_thread(session, "General discussion", [sender_id, *valid_recipients], save=False)
            thread_id = thread.id
        thread = session.threads[thread_id]
        for participant in [sender_id, *valid_recipients]:
            if participant not in thread.participant_ids and (participant in session.agents or participant == "user"):
                thread.participant_ids.append(participant)
        msg_id = self._new_id("msg")
        message = CoworkMessage(
            id=msg_id,
            thread_id=thread_id,
            sender_id=sender_id,
            recipient_ids=valid_recipients,
            content=content,
            read_by=[sender_id],
        )
        session.messages[msg_id] = message
        thread.message_ids.append(msg_id)
        thread.updated_at = now_iso()
        thread.last_message_at = message.created_at
        for recipient_id in valid_recipients:
            agent = session.agents.get(recipient_id)
            if agent and msg_id not in agent.inbox:
                agent.inbox.append(msg_id)
                if agent.status in {"idle", "done"}:
                    agent.status = "waiting"
        self.add_event(
            session,
            "message.sent",
            f"{sender_id} sent a message to {', '.join(valid_recipients)}",
            actor_id=sender_id,
            data={"thread_id": thread_id, "message_id": msg_id, "recipients": valid_recipients},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return message

    def add_task(
        self,
        session: CoworkSession,
        title: str,
        description: str,
        assigned_agent_id: str | None,
        dependencies: list[str] | None = None,
        *,
        priority: int = 0,
        expected_output: str = "",
        review_required: bool = False,
        reviewer_agent_ids: list[str] | None = None,
        fanout_group_id: str = "",
        merge_task_id: str = "",
        source_blueprint_id: str = "",
        source_event_id: str = "",
        runtime_created: bool = True,
        save: bool = True,
    ) -> CoworkTask:
        assigned_value = str(assigned_agent_id or "").strip()
        assigned_agent_id = self._slug(assigned_value) if assigned_value else None
        if assigned_agent_id not in session.agents:
            assigned_agent_id = None
        task_id = self._new_id("task")
        task = CoworkTask(
            id=task_id,
            title=title.strip() or "Untitled task",
            description=description.strip() or title,
            assigned_agent_id=assigned_agent_id,
            dependencies=dependencies or [],
            priority=int(priority or 0),
            expected_output=expected_output,
            review_required=review_required,
            reviewer_agent_ids=reviewer_agent_ids or [],
            fanout_group_id=fanout_group_id,
            merge_task_id=merge_task_id,
            source_blueprint_id=source_blueprint_id,
            source_event_id=source_event_id,
            runtime_created=runtime_created,
        )
        session.tasks[task_id] = task
        self._ensure_swarm_work_unit_for_task(session, task)
        if session.status == "completed":
            session.status = "active"
        session.current_focus_task = f"{task.title}: {task.description}"
        if assigned_agent_id:
            agent = session.agents[assigned_agent_id]
            if agent.status in {"idle", "done"}:
                agent.status = "waiting"
            message = f"Task '{task.title}' assigned to {agent.name}"
        else:
            message = f"Task '{task.title}' added to the shared task pool"
        self.add_event(
            session,
            "task.created",
            message,
            data={
                "task_id": task.id,
                "assigned_agent_id": assigned_agent_id,
                "dependencies": task.dependencies,
                "review_required": task.review_required,
                "fanout_group_id": task.fanout_group_id,
                "merge_task_id": task.merge_task_id,
            },
            save=False,
        )
        self.add_trace_event(
            session,
            kind="task",
            name="Task created",
            actor_id=assigned_agent_id,
            status=task.status,
            input_ref=task.description,
            summary=message,
            data={"task_id": task.id, "assigned_agent_id": assigned_agent_id, "dependencies": task.dependencies},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return task

    def _ensure_swarm_work_unit_for_task(self, session: CoworkSession, task: CoworkTask) -> None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
        if not units or any(isinstance(unit, dict) and unit.get("source_task_id") == task.id for unit in units):
            return
        unit = {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "input": {"goal": session.goal, "source_task_id": task.id},
            "expected_output_schema": {"answer": "string", "evidence": "array", "risks": "array", "artifacts": "array", "confidence": "number"},
            "completion_criteria": ["Return a structured result for the task."],
            "assigned_agent_id": task.assigned_agent_id,
            "dependencies": list(task.dependencies),
            "status": "pending" if task.dependencies else "ready",
            "priority": task.priority,
            "attempts": 0,
            "max_attempts": int((plan.get("budgets") or {}).get("max_retry_attempts") or 2),
            "tool_allowlist": list(session.agents.get(task.assigned_agent_id).tools or ["cowork_internal"]) if task.assigned_agent_id in session.agents else ["cowork_internal"],
            "result": {},
            "evidence": [],
            "risks": [],
            "open_questions": [],
            "artifacts": [],
            "confidence": None,
            "error": None,
            "source_task_id": task.id,
            "source_blueprint_id": task.source_blueprint_id,
            "source_event_id": task.source_event_id,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
        }
        units.append(unit)
        plan["work_units"] = units
        plan["updated_at"] = now_iso()
        session.swarm_plan = update_work_unit_readiness(plan, session.tasks)

    def assign_task(self, session: CoworkSession, task_id: str, agent_id: str, *, save: bool = True) -> str:
        agent_id = self._slug(agent_id)
        task = session.tasks.get(task_id)
        if not task:
            return f"Error: task '{task_id}' not found"
        if agent_id not in session.agents:
            return f"Error: agent '{agent_id}' not found"
        if task.status not in {"pending", "in_progress"}:
            return f"Error: task '{task_id}' is already {task.status}"
        task.assigned_agent_id = agent_id
        task.updated_at = now_iso()
        if session.status == "completed":
            session.status = "active"
        session.current_focus_task = f"{task.title}: {task.description}"
        agent = session.agents[agent_id]
        if agent.status in {"idle", "done"}:
            agent.status = "waiting"
        self.add_event(
            session,
            "task.assigned",
            f"Task '{task.title}' assigned to {agent.name}",
            actor_id=agent_id,
            data={"task_id": task.id, "assigned_agent_id": agent_id},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="task",
            name="Task assigned",
            actor_id=agent_id,
            status=task.status,
            summary=f"Task '{task.title}' assigned to {agent.name}",
            data={"task_id": task.id, "assigned_agent_id": agent_id},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return f"Task '{task.title}' assigned to {agent.name}."

    def _authorized_delegation_references(
        self,
        session: CoworkSession,
        parent_agent_id: str,
        references: list[dict[str, Any]] | None,
    ) -> tuple[list[dict[str, Any]], list[str], list[str], int]:
        authorized: list[dict[str, Any]] = []
        artifact_refs: list[str] = []
        detail_refs: list[str] = []
        redacted = 0
        for raw in references or []:
            item = dict(raw) if isinstance(raw, dict) else {"ref": str(raw)}
            ref = str(item.get("ref") or item.get("id") or item.get("artifact_ref") or item.get("detail_ref") or "").strip()
            ref_type = str(item.get("type") or item.get("kind") or "").strip()
            if not ref:
                redacted += 1
                continue
            sensitive_artifact = session.sensitive_artifacts.get(ref)
            detail = session.observation_details.get(ref)
            if sensitive_artifact and parent_agent_id not in sensitive_artifact.permitted_agent_ids:
                redacted += 1
                continue
            if detail and detail.sensitivity and parent_agent_id not in detail.permitted_agent_ids:
                redacted += 1
                continue
            safe_item = {
                "ref": ref,
                "type": ref_type or ("observation_detail" if detail else "artifact" if sensitive_artifact else "reference"),
                "summary": compact_text(item.get("summary") or item.get("title") or ref, 240),
            }
            authorized.append(safe_item)
            if safe_item["type"] in {"artifact", "sensitive_artifact"} or sensitive_artifact:
                artifact_refs.append(ref)
            if safe_item["type"] in {"observation_detail", "full_observation_detail"} or detail:
                detail_refs.append(ref)
        return authorized, list(dict.fromkeys(artifact_refs)), list(dict.fromkeys(detail_refs)), redacted

    def _delegation_denials(
        self,
        session: CoworkSession,
        *,
        requested_tools: list[str],
    ) -> list[str]:
        state = self.budget_state(session)
        limits = state["limits"]
        usage = state["usage"]
        denials: list[str] = []
        max_spawned = limits.get("max_spawned_agents")
        if max_spawned is not None and int(usage.get("spawned_agents", 0) or 0) >= int(max_spawned):
            denials.append("spawned_agent_budget_exhausted")
        max_concurrent = limits.get("max_concurrent_delegated_work")
        active_delegated = [
            item
            for item in getattr(session, "delegated_tasks", {}).values()
            if item.status in {"requested", "active"}
        ]
        if max_concurrent is not None and len(active_delegated) >= int(max_concurrent):
            denials.append("concurrent_delegated_work_exhausted")
        parallel_width = limits.get("parallel_width")
        active_sub_agents = [
            agent
            for agent in session.agents.values()
            if getattr(agent, "lifetime", "") == "temporary" and getattr(agent, "lifecycle_status", "active") != "retired"
        ]
        if parallel_width is not None and len(active_sub_agents) >= int(parallel_width):
            denials.append("parallel_width_exhausted")
        for limit_key, usage_key, reason in (
            ("max_agent_calls_total", "agent_calls", "agent_call_budget_exhausted"),
            ("max_tool_calls", "tool_calls", "tool_call_budget_exhausted"),
            ("max_tokens", "tokens_total", "token_budget_exhausted"),
            ("max_cost", "cost", "cost_budget_exhausted"),
        ):
            limit = limits.get(limit_key)
            if limit is not None and usage.get(usage_key, 0) >= limit:
                denials.append(reason)
        allowed_tools = {"cowork_internal", "read_file", "list_dir", "write_file", "edit_file", "exec"}
        disallowed = [item for item in requested_tools if item not in allowed_tools]
        if disallowed:
            denials.append(f"tool_not_supported:{','.join(disallowed)}")
        return denials

    def _delegation_allowed_tools(self, session: CoworkSession, requested_tools: list[str]) -> tuple[list[str], list[str]]:
        policy = (getattr(session, "swarm_plan", {}) or {}).get("policy", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        policy_allowed = {str(item).strip() for item in policy.get("allowed_tools", []) if str(item).strip()} if isinstance(policy, dict) else set()
        if not policy_allowed:
            return requested_tools or ["cowork_internal"], []
        kept = [item for item in requested_tools if item in policy_allowed]
        removed = [item for item in requested_tools if item not in policy_allowed]
        return kept or ["cowork_internal"], removed

    def _open_delegated_task(
        self,
        session: CoworkSession,
        *,
        parent_agent_id: str,
        task_goal: str,
        constraints: list[str] | None = None,
        input_references: list[dict[str, Any]] | None = None,
        expected_output: str = "",
        tools: list[str] | None = None,
        stopping_criteria: list[str] | None = None,
        work_unit_id: str = "",
        save: bool = False,
    ) -> tuple[CoworkDelegatedTask, CoworkDelegatedBrief, CoworkDelegationGuardrail, list[str]] | str:
        self.ensure_session_branches(session)
        self.ensure_session_budget(session)
        if parent_agent_id not in session.agents:
            return f"Error: parent agent '{parent_agent_id}' not found"
        requested_tools = [str(item).strip() for item in (tools or ["cowork_internal"]) if str(item).strip()]
        decision = self.architecture_policy(session.workflow_mode).handle_delegation(
            session,
            {
                "parent_agent_id": parent_agent_id,
                "task_goal": task_goal,
                "tools": requested_tools,
                "branch_id": session.current_branch_id,
                "work_unit_id": work_unit_id,
            },
        )
        allowed_by_policy = decision.status in {"allowed", "available"} and decision.payload.get("allowed", True)
        allowed_tools, removed_by_policy = self._delegation_allowed_tools(session, requested_tools)
        denials = [] if allowed_by_policy else [decision.reason or "delegation_denied_by_policy"]
        denials.extend(self._delegation_denials(session, requested_tools=allowed_tools))
        state = self.budget_state(session)
        branch = self.current_branch(session)
        guardrail = CoworkDelegationGuardrail(
            id=self._new_id("guard"),
            branch_id=branch.id,
            architecture=branch.architecture,
            parent_agent_id=parent_agent_id,
            max_spawned_agents=state["limits"].get("max_spawned_agents"),
            max_concurrent_delegated_work=state["limits"].get("max_concurrent_delegated_work"),
            max_agent_calls_total=state["limits"].get("max_agent_calls_total"),
            max_tool_calls=state["limits"].get("max_tool_calls"),
            max_tokens=state["limits"].get("max_tokens"),
            max_cost=state["limits"].get("max_cost"),
            parallel_width=state["limits"].get("parallel_width"),
            allowed_tools=list(allowed_tools),
            denied_reasons=denials,
        )
        session.delegation_guardrails[guardrail.id] = guardrail
        if denials:
            if "spawned_agent_budget_exhausted" in denials:
                self.record_stop_reason(
                    session,
                    "spawn_budget_exhausted",
                    "Cowork agent spawn request was blocked by the spawned-agent budget",
                    data={"parent_agent_id": parent_agent_id, "max_spawned_agents": state["limits"].get("max_spawned_agents")},
                    save=False,
                )
            self.add_event(
                session,
                "delegation.denied",
                "Sub-Agent delegation request was denied by guardrails",
                actor_id=parent_agent_id,
                data={"guardrail_id": guardrail.id, "denied_reasons": denials},
                save=False,
            )
            if save:
                self._touch(session)
                self._save()
            if denials == ["spawned_agent_budget_exhausted"]:
                return "Error: spawned-agent budget exhausted"
            return f"Error: delegation denied: {', '.join(denials)}"
        safe_refs, artifact_refs, detail_refs, redacted_count = self._authorized_delegation_references(session, parent_agent_id, input_references)
        brief = CoworkDelegatedBrief(
            id=self._new_id("brief"),
            parent_agent_id=parent_agent_id,
            task_goal=compact_text(task_goal, 1200),
            constraints=[compact_text(item, 240) for item in (constraints or []) if str(item).strip()],
            input_references=safe_refs,
            expected_output=compact_text(expected_output, 500),
            allowed_tools=list(allowed_tools),
            stopping_criteria=[compact_text(item, 240) for item in (stopping_criteria or []) if str(item).strip()],
            authorized_artifact_refs=artifact_refs,
            authorized_detail_refs=detail_refs,
            redacted_reference_count=redacted_count,
        )
        delegated = CoworkDelegatedTask(
            id=self._new_id("dtask"),
            parent_agent_id=parent_agent_id,
            brief_id=brief.id,
            branch_id=branch.id,
            architecture=branch.architecture,
            status="requested",
            guardrail_id=guardrail.id,
        )
        session.delegated_briefs[brief.id] = brief
        session.delegated_tasks[delegated.id] = delegated
        return delegated, brief, guardrail, removed_by_policy

    def spawn_agent(
        self,
        session: CoworkSession,
        *,
        parent_agent_id: str,
        role: str,
        goal: str,
        name: str = "",
        responsibilities: list[str] | None = None,
        tools: list[str] | None = None,
        subscriptions: list[str] | None = None,
        reason: str = "",
        source_event_id: str = "",
        team_id: str = "",
        work_unit_id: str = "",
        delegated_task_id: str = "",
        delegated_brief_id: str = "",
        save: bool = True,
    ) -> CoworkAgent | str:
        requested_tools = [str(item).strip() for item in (tools or ["cowork_internal"]) if str(item).strip()]
        removed_by_policy: list[str] = []
        delegated = session.delegated_tasks.get(delegated_task_id) if delegated_task_id else None
        brief = session.delegated_briefs.get(delegated_brief_id) if delegated_brief_id else None
        if delegated is None or brief is None:
            opened = self._open_delegated_task(
                session,
                parent_agent_id=parent_agent_id,
                task_goal=goal,
                constraints=responsibilities,
                expected_output="Compact delegated result with answer, evidence, uncertainty, artifacts, and blockers.",
                tools=requested_tools,
                stopping_criteria=["Return the compact result to the parent agent and stop."],
                work_unit_id=work_unit_id,
                save=save,
            )
            if isinstance(opened, str):
                return opened
            delegated, brief, _guardrail, removed_by_policy = opened
        requested_tools = list(brief.allowed_tools or requested_tools or ["cowork_internal"])
        base_id = self._slug(name or role or "specialist")
        agent_id = base_id
        counter = 2
        while agent_id in session.agents:
            agent_id = f"{base_id}_{counter}"
            counter += 1
        agent = CoworkAgent(
            id=agent_id,
            name=name.strip() or role.strip() or agent_id,
            role=role.strip() or "Specialist",
            goal=goal.strip() or session.goal,
            responsibilities=responsibilities or [],
            tools=requested_tools or ["cowork_internal"],
            subscriptions=subscriptions or [agent_id, self._slug(role)],
            parent_agent_id=parent_agent_id,
            team_id=team_id,
            lifetime="temporary",
            lifecycle_status="active",
            source_event_id=source_event_id,
            spawn_reason=reason,
            delegated_task_id=delegated.id,
            delegated_brief_id=brief.id,
            sub_agent_scope="parent",
        )
        session.agents[agent_id] = agent
        isolated = CoworkIsolatedSubAgentContext(
            id=self._new_id("ictx"),
            delegated_task_id=delegated.id,
            sub_agent_id=agent.id,
            parent_agent_id=parent_agent_id,
            brief_id=brief.id,
            summary=brief.task_goal,
            artifact_refs=list(brief.authorized_artifact_refs),
            detail_refs=list(brief.authorized_detail_refs),
        )
        agent.isolated_context_id = isolated.id
        session.isolated_sub_agent_contexts[isolated.id] = isolated
        delegated.sub_agent_id = agent.id
        delegated.status = "active"
        delegated.updated_at = now_iso()
        self.record_budget_usage(session, spawned_agents=1, save=False)
        self.add_event(
            session,
            "agent.spawned",
            f"Spawned agent {agent.name}",
            actor_id=parent_agent_id,
            data={
                "agent_id": agent.id,
                "parent_agent_id": parent_agent_id,
                "source_event_id": source_event_id,
                "reason": reason,
                "team_id": team_id,
                "work_unit_id": work_unit_id,
                "lifetime": agent.lifetime,
                "removed_tools_by_policy": removed_by_policy,
                "delegated_task_id": delegated.id,
                "delegated_brief_id": brief.id,
                "isolated_context_id": isolated.id,
                "sub_agent_scope": agent.sub_agent_scope,
            },
            save=False,
        )
        self.add_trace_event(
            session,
            kind="agent",
            name="Agent spawned",
            actor_id=parent_agent_id,
            summary=f"Spawned agent {agent.name}",
            data={
                "agent_id": agent.id,
                "parent_agent_id": parent_agent_id,
                "reason": reason,
                "team_id": team_id,
                "work_unit_id": work_unit_id,
                "lifetime": agent.lifetime,
                "removed_tools_by_policy": removed_by_policy,
                "delegated_task_id": delegated.id,
                "delegated_brief_id": brief.id,
                "isolated_context_id": isolated.id,
            },
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return agent

    def request_agent_delegation(
        self,
        session: CoworkSession,
        *,
        parent_agent_id: str,
        task_goal: str,
        role: str = "Delegated specialist",
        name: str = "",
        constraints: list[str] | None = None,
        input_references: list[dict[str, Any]] | None = None,
        expected_output: str = "",
        tools: list[str] | None = None,
        stopping_criteria: list[str] | None = None,
        work_unit_id: str = "",
        save: bool = True,
    ) -> dict[str, Any] | str:
        opened = self._open_delegated_task(
            session,
            parent_agent_id=parent_agent_id,
            task_goal=task_goal,
            constraints=constraints,
            input_references=input_references,
            expected_output=expected_output,
            tools=tools,
            stopping_criteria=stopping_criteria,
            work_unit_id=work_unit_id,
            save=save,
        )
        if isinstance(opened, str):
            return opened
        delegated, brief, guardrail, removed_by_policy = opened
        agent = self.spawn_agent(
            session,
            parent_agent_id=parent_agent_id,
            role=role,
            goal=brief.task_goal,
            name=name,
            responsibilities=constraints or [],
            tools=brief.allowed_tools,
            reason=task_goal,
            work_unit_id=work_unit_id,
            delegated_task_id=delegated.id,
            delegated_brief_id=brief.id,
            save=False,
        )
        if isinstance(agent, str):
            delegated.status = "denied"
            delegated.error = agent
            delegated.updated_at = now_iso()
            if save:
                self._touch(session)
                self._save()
            return agent
        self.add_event(
            session,
            "delegation.created",
            f"Delegated task '{delegated.id}' assigned to Sub-Agent {agent.name}",
            actor_id=parent_agent_id,
            data={
                "delegated_task_id": delegated.id,
                "delegated_brief_id": brief.id,
                "sub_agent_id": agent.id,
                "guardrail_id": guardrail.id,
                "removed_tools_by_policy": removed_by_policy,
            },
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return {"delegated_task": delegated, "brief": brief, "sub_agent": agent, "guardrail": guardrail}

    def spawn_subteam(
        self,
        session: CoworkSession,
        *,
        parent_agent_id: str,
        team_id: str,
        agents: list[dict[str, Any]],
        tasks: list[dict[str, Any]] | None = None,
        reason: str = "",
        save: bool = True,
    ) -> dict[str, Any] | str:
        with self._mutation_lock:
            created_agents: list[str] = []
            created_tasks: list[str] = []
            team_id = self._slug(team_id or "subteam")
            source_event_id = self._new_id("evt_src")
            for raw_agent in agents:
                result = self.spawn_agent(
                    session,
                    parent_agent_id=parent_agent_id,
                    role=str(raw_agent.get("role") or "Specialist"),
                    goal=str(raw_agent.get("goal") or session.goal),
                    name=str(raw_agent.get("name") or raw_agent.get("id") or ""),
                    responsibilities=[str(item) for item in raw_agent.get("responsibilities", [])],
                    tools=[str(item) for item in raw_agent.get("tools", ["cowork_internal"])],
                    subscriptions=[str(item) for item in raw_agent.get("subscriptions", [])],
                    reason=reason,
                    source_event_id=source_event_id,
                    team_id=team_id,
                    work_unit_id=str(raw_agent.get("work_unit_id") or raw_agent.get("source_work_unit_id") or ""),
                    save=False,
                )
                if isinstance(result, str):
                    return result
                created_agents.append(result.id)
            for raw_task in tasks or []:
                owner = self._slug(raw_task.get("assigned_agent_id") or raw_task.get("owner") or "")
                if owner not in session.agents and created_agents:
                    owner = created_agents[0]
                task = self.add_task(
                    session,
                    title=str(raw_task.get("title") or "Subteam task"),
                    description=str(raw_task.get("description") or raw_task.get("title") or session.goal),
                    assigned_agent_id=owner,
                    dependencies=[str(item) for item in raw_task.get("dependencies", [])],
                    fanout_group_id=str(raw_task.get("fanout_group_id") or team_id),
                    merge_task_id=str(raw_task.get("merge_task_id") or ""),
                    source_event_id=source_event_id,
                    runtime_created=True,
                    save=False,
                )
                created_tasks.append(task.id)
            if created_agents:
                self.send_message(
                    session,
                    sender_id=parent_agent_id,
                    recipient_ids=created_agents,
                    content=reason or f"Kick off subteam {team_id}.",
                    save=False,
                )
            self.add_event(
                session,
                "subteam.spawned",
                f"Spawned subteam {team_id}",
                actor_id=parent_agent_id,
                data={"team_id": team_id, "agent_ids": created_agents, "task_ids": created_tasks, "reason": reason},
                save=False,
            )
            if save:
                self._touch(session)
                self._save()
            return {"team_id": team_id, "agent_ids": created_agents, "task_ids": created_tasks}

    def retire_agent(self, session: CoworkSession, agent_id: str, *, reason: str = "", save: bool = True) -> str:
        agent_id = self._slug(agent_id)
        agent = session.agents.get(agent_id)
        if not agent:
            return f"Error: agent '{agent_id}' not found"
        agent.lifecycle_status = "retired"
        agent.status = "retired"  # type: ignore[assignment]
        agent.current_task_id = None
        agent.current_task_title = None
        delegated_task_id = getattr(agent, "delegated_task_id", "")
        delegated = session.delegated_tasks.get(delegated_task_id) if delegated_task_id else None
        if delegated and delegated.status not in {"completed", "failed", "denied"}:
            delegated.status = "retired"
            delegated.retired_at = now_iso()
            delegated.updated_at = delegated.retired_at
            delegated.error = delegated.error or reason or "Sub-Agent retired before returning a result."
        self.add_event(
            session,
            "agent.retired",
            f"{agent.name} retired from scheduling",
            actor_id=agent.id,
            data={"agent_id": agent.id, "reason": reason, "delegated_task_id": delegated_task_id},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="agent",
            name="Agent retired",
            actor_id=agent.id,
            status="completed",
            summary=f"{agent.name} retired from scheduling",
            data={"agent_id": agent.id, "reason": reason},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return f"Agent '{agent.name}' retired."

    def complete_sub_agent(
        self,
        session: CoworkSession,
        sub_agent_id: str,
        *,
        answer: str,
        evidence: list[dict[str, Any]] | None = None,
        sources: list[str] | None = None,
        uncertainty: str = "",
        artifacts: list[str] | None = None,
        blockers: list[str] | None = None,
        status: str = "completed",
        save: bool = True,
    ) -> CoworkSubAgentResult | str:
        agent_id = self._slug(sub_agent_id)
        agent = session.agents.get(agent_id)
        if not agent:
            return f"Error: sub-agent '{agent_id}' not found"
        delegated_task_id = getattr(agent, "delegated_task_id", "")
        delegated = session.delegated_tasks.get(delegated_task_id) if delegated_task_id else None
        if delegated is None or delegated.sub_agent_id != agent.id:
            return f"Error: agent '{agent_id}' is not attached to a delegated task"
        result_status = "failed" if status == "failed" or blockers else "completed"
        result = CoworkSubAgentResult(
            id=self._new_id("sres"),
            delegated_task_id=delegated.id,
            sub_agent_id=agent.id,
            parent_agent_id=delegated.parent_agent_id,
            answer=compact_text(answer, 2000),
            evidence=list(evidence or []),
            sources=[compact_text(item, 300) for item in (sources or []) if str(item).strip()],
            uncertainty=compact_text(uncertainty, 500),
            artifacts=list(artifacts or []),
            blockers=[compact_text(item, 300) for item in (blockers or []) if str(item).strip()],
            status=result_status,
        )
        session.sub_agent_results[result.id] = result
        delegated.result_id = result.id
        delegated.status = result_status  # type: ignore[assignment]
        delegated.updated_at = now_iso()
        agent.private_summary = self._merge_private_summary(agent.private_summary, answer)
        self.add_event(
            session,
            "delegation.result.returned",
            f"Sub-Agent {agent.name} returned a delegated result",
            actor_id=agent.id,
            data={
                "delegated_task_id": delegated.id,
                "sub_agent_id": agent.id,
                "parent_agent_id": delegated.parent_agent_id,
                "result_id": result.id,
                "status": result.status,
                "blockers": result.blockers,
            },
            save=False,
        )
        self.retire_agent(
            session,
            agent.id,
            reason="Delegated task completed." if result_status == "completed" else "Delegated task failed.",
            save=False,
        )
        delegated.status = result_status  # retirement preserves final completion/failure status
        delegated.retired_at = now_iso()
        delegated.updated_at = delegated.retired_at
        if save:
            self._touch(session)
            self._save()
        return result

    def claim_task(self, session: CoworkSession, agent_id: str, task_id: str | None = None, *, save: bool = True) -> CoworkTask | str:
        with self._mutation_lock:
            agent_id = self._slug(agent_id)
            if agent_id not in session.agents:
                return f"Error: agent '{agent_id}' not found"
            requested_task = session.tasks.get(task_id or "") if task_id else None
            if requested_task and requested_task.assigned_agent_id not in {None, "", agent_id}:
                owner = requested_task.assigned_agent_id
                winner = min([agent_id, owner or agent_id])
                self.add_event(
                    session,
                    "task.claim_conflict",
                    f"{agent_id} could not claim task '{requested_task.title}' because it is owned by {owner}",
                    actor_id=agent_id,
                    data={"task_id": requested_task.id, "requested_agent_id": agent_id, "owner_agent_id": owner, "winner_agent_id": winner},
                    save=False,
                )
                if save:
                    self._touch(session)
                    self._save()
                return f"Error: task '{requested_task.id}' is already claimed by '{owner}'"
            tasks = self.claimable_tasks_for(session, agent_id)
            task = next((item for item in tasks if item.id == task_id), None) if task_id else (tasks[0] if tasks else None)
            if task is None:
                return f"Error: no claimable task found for '{agent_id}'"
            previous_owner = task.assigned_agent_id
            task.assigned_agent_id = agent_id
            task.updated_at = now_iso()
            if session.status == "completed":
                session.status = "active"
            session.current_focus_task = f"{task.title}: {task.description}"
            agent = session.agents[agent_id]
            if agent.status in {"idle", "done"}:
                agent.status = "waiting"
            event_type = "task.claimed" if previous_owner in {None, ""} else "task.selected"
            self.add_event(
                session,
                event_type,
                f"{agent.name} claimed task '{task.title}'",
                actor_id=agent_id,
                data={"task_id": task.id, "assigned_agent_id": agent_id, "previous_owner": previous_owner},
                save=False,
            )
            self.add_trace_event(
                session,
                kind="task",
                name="Task claimed" if event_type == "task.claimed" else "Task selected",
                actor_id=agent_id,
                status=task.status,
                summary=f"{agent.name} claimed task '{task.title}'",
                data={"task_id": task.id, "assigned_agent_id": agent_id, "previous_owner": previous_owner},
                save=False,
            )
            self._touch(session)
            if save:
                self._save()
            return task

    def complete_task(self, session: CoworkSession, task_id: str, result: str, *, status: str = "completed") -> str:
        task = session.tasks.get(task_id)
        if not task:
            return f"Error: task '{task_id}' not found"
        if status not in {"completed", "failed", "skipped"}:
            status = "completed"
        result_data = self._extract_structured_result(result)
        task.status = status  # type: ignore[assignment]
        task.result = result
        task.result_data = result_data
        task.confidence = self._coerce_confidence(result_data.get("confidence")) if result_data else None
        task.error = result if status == "failed" else None
        task.updated_at = now_iso()
        agent = session.agents.get(task.assigned_agent_id)
        if agent:
            agent.current_task_id = None
            agent.current_task_title = None
            if status == "failed":
                agent.status = "failed"
            elif status == "skipped":
                agent.status = "idle"
            else:
                agent.status = "idle"
        self.add_event(
            session,
            f"task.{status}",
            f"Task '{task.title}' {status}",
            actor_id=task.assigned_agent_id,
            data={"task_id": task_id},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="task",
            name=f"Task {status}",
            actor_id=task.assigned_agent_id,
            status=status,
            input_ref=task.description,
            output_ref=result,
            summary=f"Task '{task.title}' {status}",
            data={"task_id": task_id, "confidence": task.confidence, "result_data": result_data},
            error=result if status == "failed" else None,
            save=False,
        )
        if status == "completed":
            self._merge_task_artifacts(session, result_data)
            self.refresh_shared_memory(session, save=False)
        self._sync_swarm_work_unit_from_task(session, task)
        self.process_swarm_gate_result(session, task, save=False)
        self.replan_swarm(session, source_kind="task", source_id=task.id, save=False)
        self._update_completion_state(session)
        self._touch(session)
        self._save()
        return f"Task '{task.title}' marked {status}."

    def mark_messages_read(self, session: CoworkSession, agent_id: str) -> list[CoworkMessage]:
        agent = session.agents[agent_id]
        messages = [session.messages[mid] for mid in agent.inbox if mid in session.messages]
        for message in messages:
            if agent_id not in message.read_by:
                message.read_by.append(agent_id)
            self._mark_mailbox_read_for_message(session, message.id, agent_id)
        agent.inbox.clear()
        return messages

    def ready_tasks_for(self, session: CoworkSession, agent_id: str) -> list[CoworkTask]:
        ready = []
        for task in session.tasks.values():
            if task.assigned_agent_id != agent_id or task.status != "pending":
                continue
            if self._task_dependencies_done(session, task):
                ready.append(task)
        return ready

    def claimable_tasks_for(self, session: CoworkSession, agent_id: str) -> list[CoworkTask]:
        if agent_id not in session.agents:
            return []
        tasks = [
            task
            for task in session.tasks.values()
            if task.status == "pending"
            and task.assigned_agent_id in {None, "", agent_id}
            and self._task_dependencies_done(session, task)
        ]
        return sorted(tasks, key=lambda item: item.id)

    def next_task_for(self, session: CoworkSession, agent_id: str) -> CoworkTask | None:
        assigned = self.ready_tasks_for(session, agent_id)
        if assigned:
            return sorted(assigned, key=lambda item: item.id)[0]
        claimed = self.claim_task(session, agent_id, save=False)
        return claimed if isinstance(claimed, CoworkTask) else None

    def select_active_agents(self, session: CoworkSession, limit: int = 3) -> list[CoworkAgent]:
        candidates: list[tuple[int, CoworkAgent]] = []
        if session.status != "active":
            return []
        if session.workflow_mode == "swarm":
            return self.select_swarm_active_agents(session, limit=limit)
        self.expire_mailbox_records(session, save=False)
        self.escalate_stale_blockers(session, save=False)
        profile = self.workflow_profile(session.workflow_mode)
        lead_id = self.lead_agent_id(session)
        unassigned_ready_slots = sum(
            1
            for task in session.tasks.values()
            if task.status == "pending"
            and task.assigned_agent_id in {None, ""}
            and self._task_dependencies_done(session, task)
        )
        for agent in session.agents.values():
            if agent.status in {"done", "failed", "retired"} or getattr(agent, "lifecycle_status", "active") == "retired":
                continue
            has_direct_work = (
                agent.inbox
                or self.ready_tasks_for(session, agent.id)
                or self._has_pending_mailbox_work(session, agent.id)
            )
            can_claim_shared = profile in {"hybrid", "team", "shared_state", "message_bus"}
            has_shared_task = can_claim_shared and not has_direct_work and unassigned_ready_slots > 0
            if profile == "orchestrator" and not has_direct_work and agent.id != lead_id:
                has_shared_task = False
            if has_shared_task:
                unassigned_ready_slots -= 1
            if has_direct_work or has_shared_task:
                candidates.append((self.agent_readiness_score(session, agent.id, has_shared_task=has_shared_task), agent))
        candidates.sort(key=lambda item: item[0], reverse=True)
        selected = [agent for _, agent in candidates[: max(1, limit)]]
        if profile in {"orchestrator", "peer_handoff", "generator_verifier"}:
            return selected[:1]
        return selected

    def agent_readiness_score(self, session: CoworkSession, agent_id: str, *, has_shared_task: bool = False) -> int:
        agent = session.agents[agent_id]
        score = 0
        score += min(len(agent.inbox), 5) * 8
        score += self._agent_mailbox_pressure(session, agent_id)
        if self.ready_tasks_for(session, agent_id):
            score += 45
        if has_shared_task:
            score += 18
        if agent.status == "blocked":
            score -= 25
        if agent.status == "waiting":
            score += 10
        if agent.current_task_id:
            score += 8
        if agent.rounds:
            score -= min(agent.rounds, 8)
        profile = self.workflow_profile(session.workflow_mode)
        lead_id = self.lead_agent_id(session)
        if profile == "orchestrator":
            score += 25 if agent_id == lead_id else -12
        elif profile == "team":
            score += 10 if agent_id != lead_id else 0
        elif profile == "peer_handoff":
            score += 30 if agent.current_task_id or self.ready_tasks_for(session, agent_id) else 0
        elif profile == "generator_verifier":
            is_reviewer = self._is_reviewer_agent(agent)
            has_pending_review = any(
                task.status == "pending"
                and task.assigned_agent_id == agent_id
                and self._looks_like_review_task(task.title, task.description)
                for task in session.tasks.values()
            )
            score += 40 if is_reviewer and has_pending_review else 0
            score -= 8 if is_reviewer and not has_pending_review else 0
        elif profile == "message_bus":
            score += self._agent_subscription_pressure(session, agent_id)
        elif profile == "shared_state":
            score += 10 if self._shared_memory_texts(session, "open_questions") else 0
        if agent_id == self.lead_agent_id(session) and self._lead_should_synthesize(session):
            score += 65
        return score

    def agent_readiness_scores(self, session: CoworkSession) -> list[dict[str, Any]]:
        scores = [
            {
                "agent_id": agent.id,
                "name": agent.name,
                "status": agent.status,
                "score": self.agent_readiness_score(session, agent.id),
                "inbox_count": len(agent.inbox),
                "ready_tasks": [task.id for task in self.ready_tasks_for(session, agent.id)],
                "pending_replies": self.pending_reply_records_for(session, agent.id),
                "activation_reasons": self.agent_activation_reasons(session, agent.id),
                "team_id": getattr(agent, "team_id", ""),
                "parent_agent_id": getattr(agent, "parent_agent_id", None),
            }
            for agent in session.agents.values()
            if agent.status not in {"done", "failed", "retired"} and getattr(agent, "lifecycle_status", "active") != "retired"
        ]
        return sorted(scores, key=lambda item: item["score"], reverse=True)

    def agent_activation_reasons(self, session: CoworkSession, agent_id: str) -> list[str]:
        agent = session.agents.get(agent_id)
        if not agent:
            return []
        reasons: list[str] = []
        if agent.inbox:
            reasons.append("inbox_work")
        if self.ready_tasks_for(session, agent_id):
            reasons.append("ready_task")
        if self.pending_reply_records_for(session, agent_id):
            reasons.append("pending_reply")
        if self.claimable_tasks_for(session, agent_id):
            reasons.append("shared_task_claim")
        if agent_id == self.lead_agent_id(session) and self._lead_should_synthesize(session):
            reasons.append("synthesis")
        if any(
            task.review_required and task.status == "pending" and agent_id in task.reviewer_agent_ids
            for task in session.tasks.values()
        ):
            reasons.append("review_gate")
        return reasons

    def pending_reply_records_for(self, session: CoworkSession, agent_id: str) -> list[str]:
        return [
            record.id
            for record in session.mailbox.values()
            if agent_id in record.recipient_ids
            and record.requires_reply
            and record.status in {"delivered", "read"}
        ]

    def assess_session(self, session: CoworkSession, *, save: bool = True) -> dict[str, Any]:
        session.current_focus_task = self._derive_focus_task(session)
        pending_tasks = [task for task in session.tasks.values() if task.status == "pending"]
        active_tasks = [task for task in session.tasks.values() if task.status == "in_progress"]
        failed_tasks = [task for task in session.tasks.values() if task.status == "failed"]
        review_blockers = self.review_gate_blockers(session)
        fanout_blockers = self.fanout_merge_blockers(session)
        disagreements = self.detect_disagreements(session)
        pending_replies = [
            record
            for record in session.mailbox.values()
            if record.requires_reply and record.status in {"delivered", "read"}
        ]
        inbox_messages = [
            message_id
            for agent in session.agents.values()
            if agent.status not in {"done", "failed"}
            for message_id in agent.inbox
            if message_id in session.messages
        ]
        blocked = [
            {
                "id": record.id,
                "from": record.sender_id,
                "to": record.recipient_ids,
                "request_type": record.request_type or ("reply" if record.requires_reply else record.kind),
                "blocking_task_id": record.blocking_task_id,
                "content": record.content[:240],
            }
            for record in pending_replies
        ]
        goal_review = self.review_goal_completion(session)
        if session.status == "completed":
            next_action = "complete"
            reason = "The cowork session is complete."
        elif failed_tasks:
            next_action = "review_failed_tasks"
            reason = f"{len(failed_tasks)} task(s) failed and need review."
        elif review_blockers:
            next_action = "resolve_review_gates"
            reason = f"{len(review_blockers)} review gate(s) must pass before completion."
        elif fanout_blockers:
            next_action = "merge_fanout_work"
            reason = f"{len(fanout_blockers)} fanout group(s) require synthesis."
        elif disagreements:
            next_action = "synthesize_disagreements"
            reason = f"{len(disagreements)} disagreement signal(s) need lead or reviewer synthesis."
        elif pending_replies:
            next_action = "resolve_blockers"
            reason = f"{len(pending_replies)} reply request(s) are still open."
        elif self.convergence_reached(session):
            next_action = "review_convergence"
            reason = f"No tracked progress for {session.no_progress_rounds} consecutive round(s)."
        elif inbox_messages:
            next_action = "run_next_round"
            reason = f"{len(inbox_messages)} unread message(s) need agent attention."
        elif pending_tasks or active_tasks:
            next_action = "run_next_round"
            reason = f"{len(pending_tasks) + len(active_tasks)} task(s) still need progress."
        elif session.tasks and goal_review["ready"]:
            next_action = "summarize"
            reason = "All known tasks are complete or skipped."
        elif session.tasks:
            next_action = "review_goal_completion"
            reason = goal_review["reason"]
        else:
            next_action = "plan"
            reason = "No tasks exist yet."
        decision = {
            "next_action": next_action,
            "reason": reason,
            "blocked": blocked,
            "review_blockers": review_blockers,
            "fanout_blockers": fanout_blockers,
            "disagreements": disagreements,
            "ready_to_finish": next_action == "summarize",
            "no_progress_rounds": getattr(session, "no_progress_rounds", 0),
            "convergence_limit": _CONVERGENCE_IDLE_ROUNDS,
            "readiness": self.agent_readiness_scores(session)[:6],
            "budget": self.budget_state(session),
            "stop_reason": getattr(session, "stop_reason", ""),
            "workflow_mode": session.workflow_mode,
            "workflow_profile": self.workflow_profile(session.workflow_mode),
            "focus_task": session.current_focus_task,
            "workspace_dir": session.workspace_dir,
            "artifacts": session.artifacts[-8:],
            "shared_memory_counts": self.shared_memory_counts(session),
            "goal_review": goal_review,
            "updated_at": now_iso(),
        }
        session.completion_decision = decision
        if save:
            self._touch(session)
            self._save()
        return decision

    def progress_signature(self, session: CoworkSession) -> tuple[int, int, int, int, int, int]:
        memory_count = sum(len(entries) for entries in self._normalize_shared_memory(getattr(session, "shared_memory", {})).values())
        completed_count = sum(1 for task in session.tasks.values() if task.status == "completed")
        active_records = sum(1 for record in session.mailbox.values() if record.status not in {"replied", "expired"})
        return (len(session.messages), len(session.tasks), completed_count, len(session.artifacts), memory_count, active_records)

    def record_round_progress(
        self,
        session: CoworkSession,
        before: tuple[int, int, int, int, int, int],
        *,
        save: bool = True,
    ) -> bool:
        after = self.progress_signature(session)
        progressed = after != before
        session.no_progress_rounds = 0 if progressed else getattr(session, "no_progress_rounds", 0) + 1
        if not progressed:
            self.add_event(
                session,
                "scheduler.no_progress",
                f"Cowork round produced no new tracked progress ({session.no_progress_rounds}/{_CONVERGENCE_IDLE_ROUNDS})",
                data={"before": list(before), "after": list(after), "no_progress_rounds": session.no_progress_rounds},
                save=False,
            )
        if save:
            self._touch(session)
            self._save()
        return progressed

    def convergence_reached(self, session: CoworkSession) -> bool:
        return getattr(session, "no_progress_rounds", 0) >= _CONVERGENCE_IDLE_ROUNDS

    def shared_memory_counts(self, session: CoworkSession) -> dict[str, int]:
        memory = self._normalize_shared_memory(getattr(session, "shared_memory", {}))
        return {bucket: len(memory.get(bucket, [])) for bucket in _SHARED_MEMORY_BUCKETS}

    def refresh_shared_memory(self, session: CoworkSession, *, save: bool = True) -> str:
        completed = [task for task in session.tasks.values() if task.status == "completed"]
        session.shared_memory = self._normalize_shared_memory(getattr(session, "shared_memory", {}))
        for task in completed[-8:]:
            data = task.result_data or {}
            source = {
                "source_task_id": task.id,
                "source_task_title": task.title,
                "author": task.assigned_agent_id,
                "confidence": task.confidence,
                "updated_at": task.updated_at,
            }
            for key, bucket in (
                ("findings", "findings"),
                ("claims", "claims"),
                ("risks", "risks"),
                ("open_questions", "open_questions"),
                ("decisions", "decisions"),
            ):
                self._merge_shared_memory_values(session, bucket, data.get(key), source)
            if data.get("answer"):
                self._merge_shared_memory_values(session, "claims", [data.get("answer")], source)
            self._merge_task_artifacts(session, data)
            if not data and task.result:
                self._merge_shared_memory_values(session, "findings", [f"{task.title}: {task.result[:280]}"], source)
        for artifact in session.artifacts[-20:]:
            self._merge_shared_memory_values(session, "artifacts", [artifact], {"source_task_id": "", "author": "", "confidence": None})
        lines = []
        findings = self._shared_memory_texts(session, "findings") + self._shared_memory_texts(session, "claims")
        risks = self._shared_memory_texts(session, "risks")
        open_questions = self._shared_memory_texts(session, "open_questions")
        decisions = self._shared_memory_texts(session, "decisions")
        if findings:
            lines.append("Confirmed findings:\n" + "\n".join(f"- {item}" for item in findings[-10:]))
        if decisions:
            lines.append("Decisions:\n" + "\n".join(f"- {item}" for item in decisions[-6:]))
        if risks:
            lines.append("Risks:\n" + "\n".join(f"- {item}" for item in risks[-6:]))
        if open_questions:
            lines.append("Open questions:\n" + "\n".join(f"- {item}" for item in open_questions[-6:]))
        session.shared_summary = "\n\n".join(lines)[-4000:]
        session.final_draft = self._build_final_draft(session)
        if save:
            self._touch(session)
            self._save()
        return session.shared_summary

    def _merge_shared_memory_values(
        self,
        session: CoworkSession,
        bucket: str,
        values: Any,
        source: dict[str, Any],
    ) -> None:
        if bucket not in _SHARED_MEMORY_BUCKETS:
            return
        if isinstance(values, str):
            items = [values]
        elif isinstance(values, list):
            items = values
        else:
            return
        session.shared_memory = self._normalize_shared_memory(getattr(session, "shared_memory", {}))
        existing = {
            (str(entry.get("text") or "").strip(), str(entry.get("source_task_id") or ""))
            for entry in session.shared_memory[bucket]
        }
        for value in items:
            text = str(value or "").strip()
            if not text:
                continue
            key = (text, str(source.get("source_task_id") or ""))
            if key in existing:
                continue
            entry = {"text": text, **{k: v for k, v in source.items() if v not in {None, ""}}}
            session.shared_memory[bucket].append(entry)
            existing.add(key)
        if len(session.shared_memory[bucket]) > 80:
            session.shared_memory[bucket] = session.shared_memory[bucket][-80:]

    @staticmethod
    def _shared_memory_texts(session: CoworkSession, bucket: str) -> list[str]:
        memory = getattr(session, "shared_memory", {}) or {}
        entries = memory.get(bucket, []) if isinstance(memory, dict) else []
        return [str(entry.get("text") or "").strip() for entry in entries if isinstance(entry, dict) and str(entry.get("text") or "").strip()]

    def review_goal_completion(self, session: CoworkSession) -> dict[str, Any]:
        """Heuristic root-goal review inspired by peer handoff workflows.

        This is intentionally deterministic: it prevents obvious early exits
        without adding an extra LLM call to every cowork round.
        """

        completed = [task for task in session.tasks.values() if task.status == "completed"]
        open_questions = [
            item
            for task in completed
            if isinstance(task.result_data.get("open_questions"), list)
            for item in (task.result_data.get("open_questions") or [])
            if str(item).strip()
        ]
        failed = [task for task in session.tasks.values() if task.status == "failed"]
        if failed:
            return {"ready": False, "reason": f"{len(failed)} failed task(s) need review.", "missing": ["failed_tasks"]}
        review_blockers = self.review_gate_blockers(session)
        if review_blockers:
            return {"ready": False, "reason": "Review-required outputs have not passed review.", "missing": ["review_gates"]}
        fanout_blockers = self.fanout_merge_blockers(session)
        if fanout_blockers:
            return {"ready": False, "reason": "Fanout work needs an explicit merge or synthesis task.", "missing": ["fanout_merge"]}
        disagreements = self.detect_disagreements(session)
        if disagreements:
            return {"ready": False, "reason": "Completed work contains disagreement signals requiring synthesis.", "missing": ["disagreements"]}
        if open_questions:
            return {"ready": False, "reason": "Completed work still contains open questions.", "missing": ["open_questions"]}

        goal_text = session.goal.lower()
        delivery_markers = (
            "code",
            "implement",
            "build",
            "edit",
            "write file",
            "create file",
            "fix",
            "test",
            "docs",
            "document",
            "app",
            "page",
            "代码",
            "实现",
            "修复",
            "文件",
            "页面",
            "文档",
        )
        likely_delivery_goal = any(marker in goal_text for marker in delivery_markers)
        has_artifacts = bool(session.artifacts)
        has_structured_answer = any(
            task.result_data.get("answer") or task.result_data.get("findings")
            for task in completed
        )
        has_visible_result = any(
            message.sender_id != "user" and "user" in message.recipient_ids and message.content.strip()
            for message in session.messages.values()
        )
        if likely_delivery_goal and not has_artifacts:
            return {
                "ready": False,
                "reason": "The goal appears to require concrete deliverables, but no artifact paths are confirmed yet.",
                "missing": ["artifacts"],
            }
        if completed and not (has_structured_answer or has_visible_result or session.final_draft):
            return {
                "ready": False,
                "reason": "Tasks are marked complete, but there is no structured answer or user-facing result yet.",
                "missing": ["final_answer"],
            }
        return {"ready": bool(completed), "reason": "Known task results appear sufficient.", "missing": []}

    def review_gate_blockers(self, session: CoworkSession) -> list[dict[str, Any]]:
        blockers: list[dict[str, Any]] = []
        for task in session.tasks.values():
            if not getattr(task, "review_required", False):
                continue
            review_status = str(getattr(task, "review_status", "") or task.result_data.get("review_status", "")).lower()
            if review_status in {"passed", "waived", "expired"}:
                continue
            if task.status not in {"completed", "failed"}:
                continue
            blockers.append(
                {
                    "task_id": task.id,
                    "task_title": task.title,
                    "review_status": review_status or "required",
                    "reviewer_agent_ids": list(getattr(task, "reviewer_agent_ids", []) or []),
                }
            )
        return blockers

    def fanout_merge_blockers(self, session: CoworkSession) -> list[dict[str, Any]]:
        fanout_groups: dict[str, list[CoworkTask]] = {}
        for task in session.tasks.values():
            group_id = getattr(task, "fanout_group_id", "")
            if group_id:
                fanout_groups.setdefault(group_id, []).append(task)
        blockers: list[dict[str, Any]] = []
        for group_id, tasks in fanout_groups.items():
            merge_ids = {task.merge_task_id for task in tasks if getattr(task, "merge_task_id", "")}
            completed_fanout = [task for task in tasks if task.status in {"completed", "skipped"}]
            if len(completed_fanout) < len(tasks):
                continue
            merge_done = any(
                merge_id in session.tasks and session.tasks[merge_id].status in {"completed", "skipped"}
                for merge_id in merge_ids
            )
            if not merge_ids or not merge_done:
                blockers.append(
                    {
                        "fanout_group_id": group_id,
                        "task_ids": [task.id for task in tasks],
                        "merge_task_ids": sorted(merge_ids),
                    }
                )
        return blockers

    def detect_disagreements(self, session: CoworkSession) -> list[dict[str, Any]]:
        signals: list[dict[str, Any]] = []
        claims_by_text: dict[str, set[str]] = {}
        for task in session.tasks.values():
            data = task.result_data or {}
            for key in ("conflicts", "disagreements"):
                values = data.get(key)
                if isinstance(values, list):
                    for value in values:
                        text = str(value or "").strip()
                        if text:
                            signals.append({"task_id": task.id, "kind": key, "text": text})
            for claim in data.get("claims", []) if isinstance(data.get("claims"), list) else []:
                text = str(claim or "").strip().lower()
                if text:
                    claims_by_text.setdefault(text, set()).add(task.assigned_agent_id or "")
            confidence = task.confidence
            if confidence is not None and confidence < 0.35 and task.status == "completed":
                signals.append({"task_id": task.id, "kind": "low_confidence", "confidence": confidence})
        for text, authors in claims_by_text.items():
            if len(authors) > 1 and any(marker in text for marker in ("not ", "no ", "cannot", "risk", "conflict")):
                signals.append({"kind": "claim_conflict", "text": text, "authors": sorted(authors)})
        return signals[:20]

    def add_mailbox_record(self, session: CoworkSession, record: CoworkMailboxRecord, *, save: bool = True) -> CoworkMailboxRecord:
        session.mailbox[record.id] = record
        self.trim_mailbox_records(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return record

    def update_mailbox_record(self, session: CoworkSession, record: CoworkMailboxRecord, *, save: bool = True) -> None:
        record.updated_at = now_iso()
        self._touch(session)
        if save:
            self._save()

    def expire_mailbox_records(self, session: CoworkSession, *, save: bool = True) -> list[CoworkMailboxRecord]:
        expired = []
        for record in session.mailbox.values():
            if (
                record.deadline_round is not None
                and session.rounds >= record.deadline_round
                and record.status not in {"replied", "expired"}
            ):
                record.status = "expired"
                record.updated_at = now_iso()
                expired.append(record)
                self.add_event(
                    session,
                    "mailbox.expired",
                    f"Mailbox envelope {record.id} expired",
                    actor_id=record.sender_id,
                    data={"envelope_id": record.id, "correlation_id": record.correlation_id},
                    save=False,
                )
        if expired:
            self._touch(session)
            if save:
                self._save()
        return expired

    def escalate_stale_blockers(self, session: CoworkSession, *, save: bool = True) -> list[CoworkMailboxRecord]:
        escalated: list[CoworkMailboxRecord] = []
        lead_id = self.lead_agent_id(session)
        reviewer = next((agent for agent in session.agents.values() if self._is_reviewer_agent(agent)), None)
        target_id = reviewer.id if reviewer else lead_id
        for record in session.mailbox.values():
            if (
                not record.requires_reply
                or record.status not in {"delivered", "read"}
                or not record.escalate_after_rounds
                or record.escalated_at
            ):
                continue
            if session.rounds < record.escalate_after_rounds:
                continue
            record.escalated_at = now_iso()
            record.updated_at = record.escalated_at
            escalated.append(record)
            if target_id in session.agents and target_id not in record.recipient_ids:
                self.send_message(
                    session,
                    sender_id="user",
                    recipient_ids=[target_id],
                    content=(
                        f"Escalate stale blocker {record.id} from {record.sender_id}: "
                        f"{record.content[:500]}"
                    ),
                    thread_id=record.thread_id,
                    save=False,
                )
            self.add_event(
                session,
                "mailbox.stale_blocker",
                f"Mailbox envelope {record.id} escalated as a stale blocker",
                actor_id=target_id,
                data={
                    "envelope_id": record.id,
                    "target_agent_id": target_id,
                    "blocking_task_id": record.blocking_task_id,
                    "caused_by_envelope_id": record.caused_by_envelope_id,
                },
                save=False,
            )
        if escalated:
            self._touch(session)
            if save:
                self._save()
        return escalated

    def trim_mailbox_records(self, session: CoworkSession, *, save: bool = True) -> None:
        if len(session.mailbox) <= _MAX_MAILBOX_RECORDS:
            return
        ordered = sorted(
            session.mailbox.values(),
            key=lambda record: (record.status not in {"replied", "expired"}, record.created_at),
        )
        remove_count = len(session.mailbox) - _MAX_MAILBOX_RECORDS
        for record in ordered[:remove_count]:
            session.mailbox.pop(record.id, None)
        self.add_event(
            session,
            "mailbox.trimmed",
            f"Mailbox trimmed {remove_count} old envelopes",
            data={"removed": remove_count, "limit": _MAX_MAILBOX_RECORDS},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()

    def update_agent_after_run(
        self,
        session: CoworkSession,
        agent_id: str,
        content: str,
        status: str = "idle",
        *,
        publish_note: bool = True,
    ) -> None:
        agent = session.agents[agent_id]
        agent.private_summary = self._merge_private_summary(agent.private_summary, content)
        agent.last_active_at = now_iso()
        agent.rounds += 1
        agent.status = status if status in {"idle", "working", "waiting", "blocked", "done", "failed"} else "idle"  # type: ignore[assignment]
        if agent.status == "working":
            agent.status = "idle"
        session.rounds += 1
        if publish_note and content.strip():
            thread_id = next(iter(session.threads), None)
            self.send_message(
                session,
                sender_id=agent_id,
                recipient_ids=["user"],
                content=content,
                thread_id=thread_id,
                save=False,
            )
        self.add_event(session, "agent.ran", f"{agent.name} completed a cowork round", actor_id=agent_id, save=False)
        self._update_completion_state(session)
        self._touch(session)
        self._save()

    def add_trace_span(
        self,
        session: CoworkSession,
        span: CoworkTraceSpan,
        *,
        save: bool = True,
    ) -> CoworkTraceSpan:
        if span not in session.trace_spans:
            session.trace_spans.append(span)
        if len(session.trace_spans) > _MAX_TRACE_SPAN_COUNT:
            session.trace_spans = session.trace_spans[-_MAX_TRACE_SPAN_COUNT:]
        self.event_log.append(
            session.id,
            "trace.span_recorded",
            category="trace",
            actor_id=span.actor_id,
            event_id=span.id,
            created_at=span.ended_at or span.started_at,
            payload={"span": asdict(span)},
        )
        if save:
            self._touch(session)
            self._save()
        return span

    def start_trace_span(
        self,
        session: CoworkSession,
        *,
        kind: str,
        name: str,
        run_id: str | None = None,
        round_id: str | None = None,
        actor_id: str | None = None,
        parent_id: str | None = None,
        input_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
        save: bool = False,
    ) -> CoworkTraceSpan:
        span = self.traces.start_span(
            session,
            kind=kind,
            name=name,
            run_id=run_id,
            round_id=round_id,
            actor_id=actor_id,
            parent_id=parent_id,
            input_ref=input_ref,
            summary=summary,
            data=data,
        )
        self.add_trace_span(session, span, save=save)
        return span

    def finish_trace_span(
        self,
        session: CoworkSession,
        span: CoworkTraceSpan,
        *,
        status: str = "completed",
        output_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
        error: str | None = None,
        save: bool = False,
    ) -> CoworkTraceSpan:
        if error:
            self.traces.fail_span(span, error, summary=summary)
        else:
            self.traces.finish_span(span, status=status, output_ref=output_ref, summary=summary, data=data)
        self.add_trace_span(session, span, save=save)
        return span

    def start_agent_step(
        self,
        session: CoworkSession,
        *,
        agent_id: str | None,
        action_kind: str,
        scheduler_reason: str = "",
        task_id: str | None = None,
        work_unit_id: str | None = None,
        input_summary: str = "",
        linked_message_ids: list[str] | None = None,
        linked_envelope_ids: list[str] | None = None,
        source_span_id: str | None = None,
        save: bool = False,
    ) -> CoworkAgentStep:
        """Record the beginning of a native Agent Step."""

        branch_id = session.current_branch_id or _DEFAULT_BRANCH_ID
        branch = session.branches.get(branch_id)
        architecture = getattr(branch, "architecture", session.workflow_mode) if branch else session.workflow_mode
        step = CoworkAgentStep(
            id=self._new_id("step"),
            session_id=session.id,
            branch_id=branch_id,
            architecture=self.normalize_workflow_mode(architecture),
            agent_id=agent_id,
            action_kind=action_kind,
            scheduler_reason=compact_text(scheduler_reason, 240),
            status="running",
            task_id=task_id,
            work_unit_id=work_unit_id,
            input_summary=compact_text(input_summary, 500),
            linked_message_ids=list(linked_message_ids or []),
            linked_envelope_ids=list(linked_envelope_ids or []),
            source_span_id=source_span_id,
        )
        session.agent_steps.append(step)
        if len(session.agent_steps) > _MAX_AGENT_STEP_COUNT:
            session.agent_steps = session.agent_steps[-_MAX_AGENT_STEP_COUNT:]
        self.event_log.append(
            session.id,
            "agent_step.started",
            category="observation",
            actor_id=agent_id,
            event_id=step.id,
            created_at=step.started_at,
            payload={"agent_step": asdict(step)},
        )
        if save:
            self._touch(session)
            self._save()
        return step

    def finish_agent_step(
        self,
        session: CoworkSession,
        step: CoworkAgentStep,
        *,
        status: str = "completed",
        output_summary: str = "",
        error: str | None = None,
        linked_message_ids: list[str] | None = None,
        linked_artifact_refs: list[str] | None = None,
        linked_task_ids: list[str] | None = None,
        detail_content: str = "",
        detail_content_type: str = "text/plain",
        redacted: bool = False,
        save: bool = False,
    ) -> CoworkAgentStep:
        ended_at = now_iso()
        step.status = self._agent_step_status(status, error=error)
        step.ended_at = ended_at
        step.duration_ms = duration_ms(step.started_at, ended_at)
        step.output_summary = compact_text(output_summary or error or step.output_summary, 600)
        step.error = compact_text(error, 500) if error else None
        if linked_message_ids:
            step.linked_message_ids = list(dict.fromkeys([*step.linked_message_ids, *linked_message_ids]))
        if linked_artifact_refs:
            step.linked_artifact_refs = list(dict.fromkeys([*step.linked_artifact_refs, *linked_artifact_refs]))
        if linked_task_ids:
            step.linked_task_ids = list(dict.fromkeys([*step.linked_task_ids, *linked_task_ids]))
        if detail_content:
            detail = self.record_full_observation_detail(
                session,
                subject_id=step.id,
                subject_type="agent_step",
                summary=step.output_summary,
                content=detail_content,
                content_type=detail_content_type,
                redacted=redacted,
                save=False,
            )
            step.detail_ref = detail.id
        step.summary = CoworkStepSummary(
            id=f"summary:{step.id}",
            step_id=step.id,
            purpose=step.scheduler_reason or step.action_kind.replace("_", " ").title(),
            action_kind=step.action_kind,
            input_summary=compact_text(step.input_summary, 220),
            outcome_summary=compact_text(step.output_summary or step.error or step.status, 240),
            next_effect=compact_text(self._agent_step_next_effect(step), 180),
            has_full_detail=bool(step.detail_ref),
            detail_ref=step.detail_ref,
            redacted=redacted,
            created_at=ended_at,
        )
        self.event_log.append(
            session.id,
            "agent_step.finished",
            category="observation",
            actor_id=step.agent_id,
            event_id=step.id,
            created_at=ended_at,
            payload={"agent_step": asdict(step)},
        )
        if save:
            self._touch(session)
            self._save()
        return step

    def record_tool_observation(
        self,
        session: CoworkSession,
        step: CoworkAgentStep,
        *,
        tool_name: str,
        purpose: str = "",
        parameters: dict[str, Any] | None = None,
        result: Any = "",
        status: str = "completed",
        started_at: str | None = None,
        ended_at: str | None = None,
        detail_content: str = "",
        redacted: bool = False,
        save: bool = False,
    ) -> CoworkToolObservation:
        started = started_at or now_iso()
        ended = ended_at or now_iso()
        observation = CoworkToolObservation(
            id=self._new_id("toolobs"),
            step_id=step.id,
            tool_name=tool_name,
            calling_agent_id=step.agent_id,
            purpose=compact_text(purpose or f"Call {tool_name}", 240),
            parameter_summary=self._sanitize_observation_parameters(parameters or {}),
            result_summary=compact_text(result, 400),
            status=self._observation_status(status, result=result),
            started_at=started,
            ended_at=ended,
            duration_ms=duration_ms(started, ended),
            redacted=redacted,
        )
        if detail_content:
            detail = self.record_full_observation_detail(
                session,
                subject_id=observation.id,
                subject_type="tool_observation",
                summary=observation.result_summary,
                content=detail_content,
                redacted=redacted,
                save=False,
            )
            observation.detail_ref = detail.id
        step.tool_observations.append(observation)
        self.event_log.append(
            session.id,
            "tool_observation.recorded",
            category="observation",
            actor_id=step.agent_id,
            event_id=observation.id,
            created_at=ended,
            payload={"tool_observation": asdict(observation)},
        )
        if save:
            self._touch(session)
            self._save()
        return observation

    def record_browser_observation(
        self,
        session: CoworkSession,
        step: CoworkAgentStep,
        *,
        purpose: str,
        resource_ref: str = "",
        title: str = "",
        result_summary: str = "",
        status: str = "completed",
        accessed_at: str | None = None,
        ended_at: str | None = None,
        artifact_refs: list[str] | None = None,
        detail_content: str = "",
        sensitive: bool = False,
        redacted: bool = False,
        save: bool = False,
    ) -> CoworkBrowserObservation:
        started = accessed_at or now_iso()
        ended = ended_at or now_iso()
        observation = CoworkBrowserObservation(
            id=self._new_id("browserobs"),
            step_id=step.id,
            purpose=compact_text(purpose, 240),
            resource_ref=compact_text(resource_ref, 500),
            title=compact_text(title, 240),
            result_summary=compact_text(result_summary, 400),
            status=self._observation_status(status),
            accessed_at=started,
            ended_at=ended,
            duration_ms=duration_ms(started, ended),
            artifact_refs=list(artifact_refs or []),
            sensitive=sensitive,
            redacted=redacted or sensitive,
        )
        if detail_content:
            detail = self.record_full_observation_detail(
                session,
                subject_id=observation.id,
                subject_type="browser_observation",
                summary=observation.result_summary,
                content=detail_content,
                redacted=redacted or sensitive,
                sensitivity="sensitive" if sensitive else "",
                artifact_refs=observation.artifact_refs,
                save=False,
            )
            observation.detail_ref = detail.id
        if sensitive:
            artifact = CoworkSensitiveArtifact(
                id=self._new_id("sartifact"),
                source_step_id=step.id,
                source_observation_id=observation.id,
                summary=observation.result_summary,
                artifact_ref=observation.detail_ref or (observation.artifact_refs[0] if observation.artifact_refs else ""),
            )
            session.sensitive_artifacts[artifact.id] = artifact
        step.browser_observations.append(observation)
        self.event_log.append(
            session.id,
            "browser_observation.recorded",
            category="observation",
            actor_id=step.agent_id,
            event_id=observation.id,
            created_at=ended,
            payload={"browser_observation": asdict(observation)},
        )
        if save:
            self._touch(session)
            self._save()
        return observation

    def record_full_observation_detail(
        self,
        session: CoworkSession,
        *,
        subject_id: str,
        subject_type: str,
        summary: str = "",
        content: str = "",
        content_type: str = "text/plain",
        state: str = "available",
        redacted: bool = False,
        sensitivity: str = "",
        unavailable_reason: str = "",
        permitted_agent_ids: list[str] | None = None,
        artifact_refs: list[str] | None = None,
        save: bool = False,
    ) -> CoworkFullObservationDetail:
        detail = CoworkFullObservationDetail(
            id=self._new_id("obsdetail"),
            subject_id=subject_id,
            subject_type=subject_type,
            state=state if state in {"available", "redacted", "unavailable", "unauthorized"} else "available",  # type: ignore[arg-type]
            summary=compact_text(summary, 400),
            content=content,
            content_type=content_type,
            redacted=redacted,
            sensitivity=sensitivity,
            unavailable_reason=compact_text(unavailable_reason, 240),
            permitted_agent_ids=list(permitted_agent_ids or []),
            artifact_refs=list(artifact_refs or []),
        )
        session.observation_details[detail.id] = detail
        if save:
            self._touch(session)
            self._save()
        return detail

    def get_observation_detail(
        self,
        session: CoworkSession,
        detail_id: str,
        *,
        requester_agent_id: str | None = None,
    ) -> CoworkFullObservationDetail:
        detail = session.observation_details.get(detail_id)
        if detail is None:
            return CoworkFullObservationDetail(
                id=detail_id,
                subject_id=detail_id,
                subject_type="unknown",
                state="unavailable",
                summary="Observation detail is not available.",
                unavailable_reason="Detail was not persisted or has expired.",
            )
        if detail.state != "available":
            return detail
        if detail.sensitivity and requester_agent_id is not None and requester_agent_id not in detail.permitted_agent_ids:
            return CoworkFullObservationDetail(
                id=detail.id,
                subject_id=detail.subject_id,
                subject_type=detail.subject_type,
                state="unauthorized",
                summary=detail.summary,
                content="",
                content_type=detail.content_type,
                redacted=True,
                sensitivity=detail.sensitivity,
                unavailable_reason="Requester is not permitted to open this sensitive observation detail.",
                artifact_refs=list(detail.artifact_refs),
                created_at=detail.created_at,
            )
        return detail

    @staticmethod
    def _agent_step_status(status: str, *, error: str | None = None) -> str:
        if error:
            return "failed"
        value = str(status or "completed").strip().lower()
        if value in {"completed", "failed", "blocked", "stopped", "running", "pending"}:
            return value
        if value in {"idle", "done", "success"}:
            return "completed"
        if value in {"cancelled", "canceled", "interrupted"}:
            return "stopped"
        return "completed"

    @staticmethod
    def _observation_status(status: str, *, result: Any = "") -> str:
        value = str(status or "completed").strip().lower()
        result_text = str(result or "").lstrip()
        if result_text.startswith("Error"):
            return "failed"
        if value == "ok":
            return "completed"
        if value == "error":
            return "failed"
        if value in {"pending", "running", "completed", "failed", "redacted", "unavailable"}:
            return value
        return "completed"

    @staticmethod
    def _sanitize_observation_parameters(parameters: dict[str, Any]) -> dict[str, Any]:
        sensitive_terms = ("secret", "token", "password", "api_key", "apikey", "credential", "authorization")
        sanitized: dict[str, Any] = {}
        for key, value in (parameters or {}).items():
            key_text = str(key)
            if any(term in key_text.lower() for term in sensitive_terms):
                sanitized[key_text] = "[redacted]"
            elif isinstance(value, (str, int, float, bool)) or value is None:
                sanitized[key_text] = compact_text(value, 160)
            elif isinstance(value, list):
                sanitized[key_text] = f"list[{len(value)}]"
            elif isinstance(value, dict):
                sanitized[key_text] = f"object[{len(value)}]"
            else:
                sanitized[key_text] = type(value).__name__
        return sanitized

    @staticmethod
    def _agent_step_next_effect(step: CoworkAgentStep) -> str:
        if step.linked_task_ids:
            return f"Updated task(s): {', '.join(step.linked_task_ids[:4])}"
        if step.linked_message_ids:
            return f"Linked message(s): {', '.join(step.linked_message_ids[:4])}"
        if step.linked_artifact_refs:
            return f"Linked artifact(s): {', '.join(step.linked_artifact_refs[:4])}"
        return ""

    def add_trace_event(
        self,
        session: CoworkSession,
        *,
        kind: str,
        name: str,
        status: str = "completed",
        actor_id: str | None = None,
        run_id: str | None = None,
        round_id: str | None = None,
        parent_id: str | None = None,
        input_ref: str = "",
        output_ref: str = "",
        summary: str = "",
        data: dict[str, Any] | None = None,
        error: str | None = None,
        save: bool = False,
    ) -> CoworkTraceSpan:
        span = self.traces.event_span(
            session,
            kind=kind,
            name=name,
            status=status,
            actor_id=actor_id,
            run_id=run_id,
            round_id=round_id,
            parent_id=parent_id,
            input_ref=input_ref,
            output_ref=output_ref,
            summary=summary,
            data=data,
            error=error,
        )
        self.add_trace_span(session, span, save=save)
        return span

    def start_run_metrics(self, session: CoworkSession, run_id: str) -> CoworkRunMetrics:
        metric = CoworkRunMetrics(run_id=run_id)
        session.run_metrics.append(metric)
        if len(session.run_metrics) > _MAX_RUN_METRIC_COUNT:
            session.run_metrics = session.run_metrics[-_MAX_RUN_METRIC_COUNT:]
        return metric

    def finish_run_metrics(
        self,
        session: CoworkSession,
        run_id: str,
        *,
        status: str = "completed",
        rounds: int = 0,
        agent_calls: int = 0,
    ) -> CoworkRunMetrics | None:
        metric = next((item for item in reversed(session.run_metrics) if item.run_id == run_id), None)
        if metric is None:
            return None
        metric.status = status
        metric.rounds = rounds
        metric.agent_calls = agent_calls
        metric.messages = len(session.messages)
        metric.tasks_created = len(session.tasks)
        metric.tasks_completed = sum(1 for task in session.tasks.values() if task.status == "completed")
        metric.artifacts_created = len(session.artifacts)
        metric.stop_reason = getattr(session, "stop_reason", "") or session.budget_usage.get("stop_reason", "")
        metric.ended_at = now_iso()
        return metric

    def record_scheduler_decision(
        self,
        session: CoworkSession,
        *,
        run_id: str | None,
        round_id: str,
        selected_agent_ids: list[str],
        candidate_scores: list[dict[str, Any]],
        reason: str,
        budget_remaining: dict[str, Any] | None = None,
        save: bool = False,
    ) -> dict[str, Any]:
        decision = {
            "id": self._new_id("dec"),
            "run_id": run_id,
            "round_id": round_id,
            "selected_agent_ids": selected_agent_ids,
            "candidate_scores": candidate_scores,
            "reason": reason,
            "blocked": list((session.completion_decision or {}).get("blocked", [])),
            "budget_remaining": budget_remaining or {},
            "created_at": now_iso(),
        }
        session.scheduler_decisions.append(decision)
        if len(session.scheduler_decisions) > _MAX_SCHEDULER_DECISION_COUNT:
            session.scheduler_decisions = session.scheduler_decisions[-_MAX_SCHEDULER_DECISION_COUNT:]
        self.event_log.append(
            session.id,
            "scheduler.decision",
            category="scheduler",
            actor_id="scheduler",
            event_id=decision["id"],
            created_at=decision["created_at"],
            payload={"decision": decision},
        )
        if save:
            self._touch(session)
            self._save()
        return decision

    def add_event(
        self,
        session: CoworkSession,
        event_type: str,
        message: str,
        *,
        actor_id: str | None = None,
        data: dict[str, Any] | None = None,
        save: bool = True,
    ) -> CoworkEvent:
        event = CoworkEvent(id=self._new_id("evt"), type=event_type, message=message, actor_id=actor_id, data=data or {})
        session.events.append(event)
        if len(session.events) > _MAX_EVENT_COUNT:
            session.events = session.events[-_MAX_EVENT_COUNT:]
        self.event_log.append(
            session.id,
            event_type,
            category="event",
            actor_id=actor_id,
            event_id=event.id,
            created_at=event.created_at,
            payload={"event": asdict(event)},
        )
        self._notify_listeners(session, event)
        if save:
            self._touch(session)
            self._save()
        return event

    def _notify_listeners(self, session: CoworkSession, event: CoworkEvent) -> None:
        for listener in list(self._listeners):
            try:
                listener(session, event)
            except Exception as exc:
                logger.debug("Cowork listener failed: {}", exc)

    def fail_agent_run(self, session: CoworkSession, agent_id: str, error: str) -> None:
        agent = session.agents[agent_id]
        agent.status = "failed"
        agent.last_active_at = now_iso()
        task_id = agent.current_task_id
        if task_id and task_id in session.tasks:
            task = session.tasks[task_id]
            task.status = "failed"
            task.error = error
            task.result = error
            task.updated_at = now_iso()
            agent.current_task_id = None
            agent.current_task_title = None
            self.add_event(
                session,
                "task.failed",
                f"Task '{task.title}' failed",
                actor_id=agent_id,
                data={"task_id": task.id, "error": error},
                save=False,
            )
        self.add_event(session, "agent.failed", f"{agent.name} failed: {error}", actor_id=agent_id, save=False)
        self.add_trace_event(
            session,
            kind="agent",
            name="Agent failed",
            actor_id=agent_id,
            status="failed",
            summary=f"{agent.name} failed",
            data={"agent_id": agent_id, "task_id": task_id},
            error=error,
            save=False,
        )
        self._touch(session)
        self._save()

    def retry_task(self, session: CoworkSession, task_id: str, *, save: bool = True) -> str:
        task = session.tasks.get(task_id)
        if not task:
            return f"Error: task '{task_id}' not found"
        if task.status not in {"failed", "skipped", "completed"}:
            return f"Error: task '{task_id}' is {task.status}; only failed, skipped, or completed tasks can be retried"
        previous_status = task.status
        task.status = "pending"
        task.error = None
        task.updated_at = now_iso()
        self._sync_swarm_work_unit_from_task(session, task)
        if session.status == "completed":
            session.status = "active"
        if task.assigned_agent_id in session.agents:
            agent = session.agents[task.assigned_agent_id]
            if agent.status in {"done", "failed", "idle"}:
                agent.status = "waiting"
        self.add_event(
            session,
            "task.retried",
            f"Task '{task.title}' queued for retry",
            actor_id="user",
            data={"task_id": task.id, "previous_status": previous_status},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="task",
            name="Task retried",
            actor_id="user",
            status="pending",
            summary=f"Task '{task.title}' queued for retry",
            data={"task_id": task.id, "previous_status": previous_status, "assigned_agent_id": task.assigned_agent_id},
            save=False,
        )
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return f"Task '{task.title}' queued for retry."

    def _sync_swarm_work_unit_from_task(self, session: CoworkSession, task: CoworkTask) -> None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
        if not units:
            return
        status_map = {
            "pending": "pending",
            "in_progress": "in_progress",
            "completed": "completed",
            "failed": "failed",
            "skipped": "skipped",
        }
        for unit in units:
            if not isinstance(unit, dict):
                continue
            if unit.get("source_task_id") != task.id and unit.get("id") != task.id:
                continue
            unit["assigned_agent_id"] = task.assigned_agent_id
            unit["status"] = status_map.get(task.status, unit.get("status", "pending"))
            unit["updated_at"] = now_iso()
            if task.status == "completed":
                result = work_unit_result_from_task(task)
                unit["result"] = {"answer": result["answer"], "findings": result["findings"]}
                unit["evidence"] = result["evidence"]
                unit["risks"] = result["risks"]
                unit["open_questions"] = result["open_questions"]
                unit["artifacts"] = result["artifacts"]
                unit["confidence"] = result["confidence"]
            elif task.status == "failed":
                unit["error"] = task.error or task.result
            elif task.status == "pending":
                unit["error"] = None
                unit["attempts"] = int(unit.get("attempts", 0) or 0) + 1
        session.swarm_plan = update_work_unit_readiness(plan, session.tasks)

    def ready_swarm_work_units(self, session: CoworkSession) -> list[dict[str, Any]]:
        plan = update_work_unit_readiness(getattr(session, "swarm_plan", {}), session.tasks)
        session.swarm_plan = plan
        units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
        return [unit for unit in units if isinstance(unit, dict) and unit.get("status") == "ready"]

    def select_swarm_active_agents(self, session: CoworkSession, limit: int = 3) -> list[CoworkAgent]:
        """Select bounded swarm workers and mark their units in progress."""

        if session.status != "active":
            return []
        self.expire_mailbox_records(session, save=False)
        self.escalate_stale_blockers(session, save=False)
        state = self.ensure_session_budget(session)
        parallel_width = max(1, int(state["limits"].get("parallel_width") or 1))
        active_agent_ids = {
            agent.id
            for agent in session.agents.values()
            if agent.status == "working" and getattr(agent, "lifecycle_status", "active") != "retired"
        }
        slots = max(0, min(max(1, int(limit or 1)), parallel_width) - len(active_agent_ids))
        if slots <= 0:
            return []

        if self.swarm_reducer_should_run(session):
            reducer_task = self.ensure_swarm_reducer_task(session, save=False)
            if reducer_task and reducer_task.assigned_agent_id in session.agents and reducer_task.status == "pending":
                unit = self.swarm_work_unit_for_task(session, reducer_task.id)
                if unit and unit.get("status") == "ready":
                    self.start_work_unit(session, str(unit.get("id")), reducer_task.assigned_agent_id or self.lead_agent_id(session), save=False)
                return [session.agents[reducer_task.assigned_agent_id or self.lead_agent_id(session)]]

        queues = self.swarm_scheduler_queues(session)
        session.runtime_state["swarm_queues"] = queues
        running_signatures = {
            self._swarm_unit_signature(unit)
            for unit in self._swarm_work_units(session)
            if isinstance(unit, dict) and unit.get("status") == "in_progress"
        }
        selected: list[CoworkAgent] = []
        selected_ids: set[str] = set()
        queued_unit_ids = [
            str(item.get("id"))
            for item in [*queues.get("queues", {}).get("ready", []), *queues.get("queues", {}).get("failed_retry", [])]
            if item.get("id")
        ]
        units_by_id = {str(unit.get("id")): unit for unit in self._swarm_work_units(session) if isinstance(unit, dict)}
        for unit_id in queued_unit_ids:
            unit = units_by_id.get(unit_id)
            if not unit:
                continue
            if len(selected) >= slots:
                break
            signature = self._swarm_unit_signature(unit)
            if signature in running_signatures:
                self.add_event(
                    session,
                    "swarm.duplicate_activation_skipped",
                    f"Skipped duplicate work-unit activation for '{unit.get('title') or unit.get('id')}'",
                    actor_id="scheduler",
                    data={"work_unit_id": unit.get("id"), "signature": signature},
                    save=False,
                )
                continue
            source_task_id = str(unit.get("source_task_id") or "")
            if source_task_id in session.tasks and session.tasks[source_task_id].status == "in_progress":
                continue
            agent_id = self._swarm_agent_for_unit(session, unit)
            if not agent_id or agent_id in selected_ids:
                continue
            result = self.start_work_unit(session, str(unit.get("id")), agent_id, save=False)
            if result.startswith("Error:"):
                continue
            selected.append(session.agents[agent_id])
            selected_ids.add(agent_id)
            running_signatures.add(signature)
        return selected

    def swarm_work_unit_for_task(self, session: CoworkSession, task_id: str) -> dict[str, Any] | None:
        for unit in self._swarm_work_units(session):
            if isinstance(unit, dict) and unit.get("source_task_id") == task_id:
                return unit
        return None

    def swarm_reducer_should_run(self, session: CoworkSession) -> bool:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if session.workflow_mode != "swarm" or not plan or plan.get("status") in {"completed", "failed", "cancelled", "blocked"}:
            return False
        base_units = [
            unit
            for unit in self._swarm_work_units(session)
            if isinstance(unit, dict) and unit.get("kind") not in {"reducer", "reviewer"} and unit.get("status") != "cancelled"
        ]
        if not base_units:
            return False
        unfinished = [unit for unit in base_units if unit.get("status") in {"pending", "ready", "in_progress", "needs_revision"}]
        if unfinished:
            return False
        reducer_task = self._existing_swarm_gate_task(session, "reducer")
        if reducer_task and reducer_task.status == "completed":
            plan["status"] = "completed"
            plan["updated_at"] = now_iso()
            return False
        return True

    def ensure_swarm_reducer_task(self, session: CoworkSession, *, save: bool = True) -> CoworkTask | None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if session.workflow_mode != "swarm" or not plan:
            return None
        existing = self._existing_swarm_gate_task(session, "reducer")
        if existing:
            return existing
        reducer_agent_id = str(plan.get("reducer_agent_id") or self.lead_agent_id(session))
        if reducer_agent_id not in session.agents:
            reducer_agent_id = self.lead_agent_id(session)
        source_units = [
            unit
            for unit in self._swarm_work_units(session)
            if isinstance(unit, dict) and unit.get("kind") not in {"reducer", "reviewer"} and unit.get("status") in {"completed", "failed", "skipped"}
        ]
        dependency_ids = [
            str(unit.get("source_task_id"))
            for unit in source_units
            if str(unit.get("source_task_id") or "") in session.tasks and session.tasks[str(unit.get("source_task_id"))].status in {"completed", "skipped"}
        ]
        summaries = []
        for unit in source_units[-12:]:
            result = unit.get("result") if isinstance(unit.get("result"), dict) else {}
            answer = str(result.get("answer") or unit.get("error") or unit.get("skip_reason") or "").strip()
            summaries.append(f"- {unit.get('id')}: {unit.get('title')} [{unit.get('status')}]" + (f" - {answer[:240]}" if answer else ""))
        task = self.add_task(
            session,
            title="Reduce swarm results",
            description=(
                "Synthesize the swarm work units into a structured final answer. Include findings, decisions, "
                "risks, open questions, artifact summary, confidence, missing work, and source_work_unit_ids.\n\n"
                + "\n".join(summaries)
            ),
            assigned_agent_id=reducer_agent_id,
            dependencies=dependency_ids,
            expected_output="Structured reducer synthesis with answer, findings, risks, open questions, artifact_summary, confidence, missing_work, and source_work_unit_ids.",
            source_event_id=f"swarm_reducer:{plan.get('id', session.id)}",
            runtime_created=True,
            save=False,
        )
        unit = self.swarm_work_unit_for_task(session, task.id)
        if unit:
            unit["kind"] = "reducer"
            unit["source_work_unit_ids"] = [unit.get("id") for unit in source_units]
            unit["status"] = "pending" if task.dependencies else "ready"
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        session.swarm_plan["status"] = "reducing"
        session.swarm_plan["updated_at"] = now_iso()
        self.add_event(
            session,
            "swarm.reducer_scheduled",
            "Swarm reducer scheduled after required work units finished",
            actor_id="scheduler",
            data={"task_id": task.id, "source_work_unit_ids": [unit.get("id") for unit in source_units]},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="swarm",
            name="Reducer scheduled",
            actor_id="scheduler",
            status="pending",
            summary="Swarm reducer scheduled after required work units finished",
            data={"task_id": task.id, "source_work_unit_ids": [unit.get("id") for unit in source_units]},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return task

    def ensure_swarm_reviewer_task(self, session: CoworkSession, reducer_task: CoworkTask, *, save: bool = True) -> CoworkTask | None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if session.workflow_mode != "swarm" or not plan:
            return None
        review = plan.get("review") if isinstance(plan.get("review"), dict) else {}
        if not review.get("required"):
            return None
        existing = self._existing_swarm_gate_task(session, "reviewer")
        if existing:
            return existing
        reviewer_id = str(review.get("agent_id") or plan.get("reviewer_agent_id") or "")
        if reviewer_id not in session.agents:
            reviewer = next((agent for agent in session.agents.values() if self._is_reviewer_agent(agent)), None)
            reviewer_id = reviewer.id if reviewer else self.lead_agent_id(session)
        task = self.add_task(
            session,
            title="Review swarm synthesis",
            description=(
                "Review the reducer synthesis using this rubric: correctness, completeness, evidence coverage, "
                "conflict detection, safety/tool risk, and whether the original goal is satisfied. "
                "Return JSON with verdict pass, needs_revision, or blocked; issues; required_fixes; and confidence.\n\n"
                f"Reducer task: {reducer_task.id}\nReducer output: {(reducer_task.result or '')[:1800]}"
            ),
            assigned_agent_id=reviewer_id,
            dependencies=[reducer_task.id],
            expected_output="Reviewer verdict JSON with verdict, issues, required_fixes, confidence.",
            source_event_id=f"swarm_reviewer:{plan.get('id', session.id)}",
            runtime_created=True,
            save=False,
        )
        unit = self.swarm_work_unit_for_task(session, task.id)
        if unit:
            unit["kind"] = "reviewer"
            unit["source_work_unit_ids"] = [unit.get("id") for unit in self._swarm_work_units(session) if unit.get("kind") == "reducer"]
            unit["status"] = "pending" if task.dependencies else "ready"
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        session.swarm_plan["status"] = "reviewing"
        session.swarm_plan["updated_at"] = now_iso()
        self.add_event(
            session,
            "swarm.reviewer_scheduled",
            "Swarm reviewer gate scheduled after reducer synthesis",
            actor_id="scheduler",
            data={"task_id": task.id, "reducer_task_id": reducer_task.id, "reviewer_agent_id": reviewer_id},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="review",
            name="Reviewer scheduled",
            actor_id="scheduler",
            status="pending",
            summary="Swarm reviewer gate scheduled after reducer synthesis",
            data={"task_id": task.id, "reducer_task_id": reducer_task.id, "reviewer_agent_id": reviewer_id},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return task

    def process_swarm_gate_result(self, session: CoworkSession, task: CoworkTask, *, save: bool = True) -> None:
        if session.workflow_mode != "swarm" or task.status != "completed":
            return
        source_event_id = str(getattr(task, "source_event_id", "") or "")
        if source_event_id.startswith("swarm_reducer:"):
            self._process_swarm_reducer_result(session, task)
        elif source_event_id.startswith("swarm_reviewer:"):
            self._process_swarm_reviewer_result(session, task)
        if save:
            self._touch(session)
            self._save()

    def _process_swarm_reducer_result(self, session: CoworkSession, task: CoworkTask) -> None:
        data = task.result_data if isinstance(task.result_data, dict) else {}
        answer = str(data.get("answer") or task.result or "").strip()
        if answer:
            session.final_draft = answer
        unit = self.swarm_work_unit_for_task(session, task.id)
        if unit:
            unit["result"] = {
                "answer": answer,
                "findings": data.get("findings") if isinstance(data.get("findings"), list) else [],
                "decisions": data.get("decisions") if isinstance(data.get("decisions"), list) else [],
                "risks": data.get("risks") if isinstance(data.get("risks"), list) else [],
                "open_questions": data.get("open_questions") if isinstance(data.get("open_questions"), list) else [],
                "artifact_summary": data.get("artifact_summary") if isinstance(data.get("artifact_summary"), list) else data.get("artifact_summary", ""),
                "missing_work": data.get("missing_work") if isinstance(data.get("missing_work"), list) else self._string_list_from_any(data.get("missing_work")),
                "source_work_unit_ids": data.get("source_work_unit_ids") if isinstance(data.get("source_work_unit_ids"), list) else [],
            }
            unit["confidence"] = task.confidence
        missing_work = self._string_list_from_any(data.get("missing_work"))
        open_questions = self._string_list_from_any(data.get("open_questions"))
        if missing_work or open_questions:
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            plan["status"] = "active"
            plan["updated_at"] = now_iso()
            session.swarm_plan = plan
            self.add_event(
                session,
                "swarm.reducer_missing_work",
                "Reducer reported missing work before completion",
                actor_id=task.assigned_agent_id,
                data={"task_id": task.id, "missing_work": missing_work, "open_questions": open_questions},
                save=False,
            )
            return
        reviewer = self.ensure_swarm_reviewer_task(session, task, save=False)
        if reviewer is None:
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            if plan:
                plan["status"] = "completed"
                plan["updated_at"] = now_iso()
                session.swarm_plan = plan
        self.add_trace_event(
            session,
            kind="synthesis",
            name="Reducer output accepted",
            actor_id=task.assigned_agent_id,
            status="completed",
            output_ref=answer,
            summary="Reducer synthesis stored as the session final draft",
            data={"task_id": task.id, "confidence": task.confidence, "review_required": reviewer is not None},
            save=False,
        )

    def _process_swarm_reviewer_result(self, session: CoworkSession, task: CoworkTask) -> None:
        data = task.result_data if isinstance(task.result_data, dict) else {}
        verdict = str(data.get("verdict") or "").strip().lower()
        if verdict not in {"pass", "needs_revision", "blocked"}:
            task.status = "failed"
            task.error = "Reviewer verdict was missing or invalid."
            self.add_trace_event(
                session,
                kind="review",
                name="Reviewer verdict invalid",
                actor_id=task.assigned_agent_id,
                status="failed",
                summary="Reviewer result could not be parsed into a valid verdict",
                data={"task_id": task.id, "raw_result": task.result},
                error=task.error,
                save=False,
            )
            return
        task.result_data["review_status"] = verdict
        if verdict == "pass":
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            if plan:
                plan["status"] = "completed"
                plan["updated_at"] = now_iso()
                session.swarm_plan = plan
        elif verdict == "needs_revision":
            fixes = self._string_list_from_any(data.get("required_fixes")) or self._string_list_from_any(data.get("issues"))
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            if plan:
                plan["status"] = "active"
                plan["updated_at"] = now_iso()
                session.swarm_plan = plan
            for index, fix in enumerate(fixes[:4], start=1):
                self.add_swarm_work_unit(
                    session,
                    title=f"Revision {index}: {fix[:80]}",
                    description=fix,
                    assigned_agent_id=self.lead_agent_id(session),
                    dependencies=[task.id],
                    tool_allowlist=["cowork_internal"],
                    kind="revision",
                    source_work_unit_id=str(self.swarm_work_unit_for_task(session, task.id).get("id") if self.swarm_work_unit_for_task(session, task.id) else task.id),
                    reason="reviewer_needs_revision",
                    save=False,
                )
        else:
            self.record_stop_reason(
                session,
                "review_blocked",
                "Swarm reviewer blocked completion",
                data={"task_id": task.id, "issues": data.get("issues", []), "required_fixes": data.get("required_fixes", [])},
                save=False,
            )
            plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
            if plan:
                plan["status"] = "blocked"
                plan["updated_at"] = now_iso()
                session.swarm_plan = plan
        self.add_trace_event(
            session,
            kind="review",
            name="Reviewer verdict accepted",
            actor_id=task.assigned_agent_id,
            status="blocked" if verdict == "blocked" else "completed",
            summary=f"Reviewer verdict: {verdict}",
            data={"task_id": task.id, "verdict": verdict, "issues": data.get("issues", []), "required_fixes": data.get("required_fixes", [])},
            save=False,
        )

    def evaluate_swarm_completion(self, session: CoworkSession, *, save: bool = True) -> list[dict[str, Any]]:
        if session.workflow_mode != "swarm":
            return []
        evaluations = [
            self._evaluate_swarm_goal_coverage(session),
            self._evaluate_swarm_evidence_coverage(session),
            self._evaluate_swarm_conflicts(session),
            self._evaluate_swarm_artifacts(session),
            self._evaluate_swarm_safety(session),
            self._evaluate_swarm_budget(session),
        ]
        payload = [asdict(item) for item in evaluations]
        session.runtime_state["swarm_evaluations"] = payload
        blocking = [item for item in payload if item.get("status") in {"block", "error"}]
        self.add_trace_event(
            session,
            kind="evaluation",
            name="Swarm evaluations updated",
            status="blocked" if blocking else "completed",
            actor_id="scheduler",
            summary=f"Swarm evaluations produced {len(blocking)} blocker(s)",
            data={"evaluations": payload},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return payload

    def _evaluate_swarm_goal_coverage(self, session: CoworkSession) -> CoworkEvaluationResult:
        units = [unit for unit in self._swarm_work_units(session) if unit.get("kind") not in {"reducer", "reviewer"}]
        incomplete = [unit for unit in units if unit.get("status") not in {"completed", "skipped"}]
        reducer_done = any(
            task.status == "completed" and str(getattr(task, "source_event_id", "")).startswith("swarm_reducer:")
            for task in session.tasks.values()
        )
        if incomplete:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="goal_coverage",
                status="block",
                summary=f"{len(incomplete)} required work unit(s) are still unfinished.",
                blocking_work_unit_ids=[str(unit.get("id")) for unit in incomplete],
                recommended_actions=["finish_required_work_units"],
            )
        if not reducer_done:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="goal_coverage",
                status="block",
                summary="Reducer synthesis has not completed.",
                recommended_actions=["run_reducer"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="goal_coverage", status="pass", score=1.0, summary="Required work units and reducer synthesis are complete.")

    def _evaluate_swarm_evidence_coverage(self, session: CoworkSession) -> CoworkEvaluationResult:
        reducer_task = self._existing_swarm_gate_task(session, "reducer")
        data = reducer_task.result_data if reducer_task and isinstance(reducer_task.result_data, dict) else {}
        source_ids = data.get("source_work_unit_ids") if isinstance(data.get("source_work_unit_ids"), list) else []
        completed_ids = [unit.get("id") for unit in self._swarm_work_units(session) if unit.get("kind") not in {"reducer", "reviewer"} and unit.get("status") == "completed"]
        if completed_ids and not source_ids:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="evidence_coverage",
                status="warn",
                score=0.4,
                summary="Reducer output does not cite source work-unit ids.",
                recommended_actions=["add_source_work_unit_ids"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="evidence_coverage", status="pass", score=1.0, summary="Reducer output cites source work units.")

    def _evaluate_swarm_conflicts(self, session: CoworkSession) -> CoworkEvaluationResult:
        conflicts = self.detect_disagreements(session)
        if conflicts:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="conflict_detection",
                status="block",
                summary=f"{len(conflicts)} unresolved conflict signal(s) detected.",
                issues=conflicts,
                blocking_task_ids=[str(item.get("task_id")) for item in conflicts if item.get("task_id")],
                recommended_actions=["resolve_conflicts"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="conflict_detection", status="pass", score=1.0, summary="No unresolved conflict signals detected.")

    def _evaluate_swarm_artifacts(self, session: CoworkSession) -> CoworkEvaluationResult:
        goal = session.goal.lower()
        needs_artifact = any(marker in goal for marker in ("file", "artifact", "report", "code", "implement", "edit", "write", "文档", "文件", "代码"))
        if needs_artifact and not getattr(session, "artifacts", []):
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="artifact_validation",
                status="block",
                summary="The goal appears to require an artifact, but no artifact is indexed.",
                recommended_actions=["produce_or_link_required_artifacts"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="artifact_validation", status="pass", score=1.0, summary="No missing required artifacts detected.")

    def _evaluate_swarm_safety(self, session: CoworkSession) -> CoworkEvaluationResult:
        if getattr(session, "stop_reason", "") in {"autonomy_boundary", "review_blocked"}:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="safety_policy",
                status="block",
                summary=f"Completion is blocked by {session.stop_reason}.",
                recommended_actions=["resolve_safety_or_review_blocker"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="safety_policy", status="pass", score=1.0, summary="No safety policy blocker is active.")

    def _evaluate_swarm_budget(self, session: CoworkSession) -> CoworkEvaluationResult:
        stop_reason = getattr(session, "stop_reason", "")
        if "budget_exhausted" in stop_reason:
            return CoworkEvaluationResult(
                id=self._new_id("eval"),
                kind="budget_state",
                status="block",
                summary=f"Completion is blocked by budget state: {stop_reason}.",
                recommended_actions=["increase_budget_or_skip_work"],
            )
        return CoworkEvaluationResult(id=self._new_id("eval"), kind="budget_state", status="pass", score=1.0, summary="No budget blocker is active.")

    def replan_swarm(
        self,
        session: CoworkSession,
        *,
        source_kind: str = "scheduler",
        source_id: str = "",
        save: bool = True,
    ) -> list[dict[str, Any]]:
        """Create bounded follow-up units from deterministic replanning signals."""

        if session.workflow_mode != "swarm" or not isinstance(getattr(session, "swarm_plan", {}), dict) or not session.swarm_plan:
            return []
        plan = session.swarm_plan
        if plan.get("status") in {"blocked", "failed", "cancelled", "completed"}:
            return []
        created: list[dict[str, Any]] = []
        for unit in list(self._swarm_work_units(session)):
            if not isinstance(unit, dict):
                continue
            if unit.get("kind") in {"follow_up", "revision"}:
                continue
            if source_id and source_kind == "task" and unit.get("source_task_id") != source_id:
                continue
            if unit.get("status") == "completed":
                signals = self._swarm_follow_up_signals(unit)
                for index, signal in enumerate(signals, start=1):
                    result = self.add_swarm_work_unit(
                        session,
                        title=f"Follow up {unit.get('title') or unit.get('id')} #{index}",
                        description=signal,
                        assigned_agent_id=str(unit.get("assigned_agent_id") or self.lead_agent_id(session)),
                        dependencies=[str(unit.get("source_task_id") or unit.get("id"))],
                        tool_allowlist=list(unit.get("tool_allowlist") or ["cowork_internal"]),
                        kind="follow_up",
                        source_work_unit_id=str(unit.get("id") or ""),
                        reason="missing_work" if signal in self._string_list_from_any((unit.get("result") or {}).get("missing_work")) else "open_question",
                        save=False,
                    )
                    if result:
                        created.append(result)
            if unit.get("status") == "failed" and self._swarm_unit_needs_split(unit):
                first = self.add_swarm_work_unit(
                    session,
                    title=f"Narrow scope for {unit.get('title') or unit.get('id')}",
                    description=f"Reduce the scope and define a smaller completion path for failed work unit {unit.get('id')}: {unit.get('error') or unit.get('description')}",
                    assigned_agent_id=str(unit.get("assigned_agent_id") or self.lead_agent_id(session)),
                    dependencies=[],
                    tool_allowlist=list(unit.get("tool_allowlist") or ["cowork_internal"]),
                    kind="revision",
                    source_work_unit_id=str(unit.get("id") or ""),
                    reason="split_failed_or_broad_unit",
                    save=False,
                )
                if first:
                    created.append(first)
                    second = self.add_swarm_work_unit(
                        session,
                        title=f"Complete reduced scope for {unit.get('title') or unit.get('id')}",
                        description=f"Complete the narrowed version of failed work unit {unit.get('id')} using the scope defined by {first.get('id')}.",
                        assigned_agent_id=str(unit.get("assigned_agent_id") or self.lead_agent_id(session)),
                        dependencies=[str(first.get("source_task_id") or first.get("id"))],
                        tool_allowlist=list(unit.get("tool_allowlist") or ["cowork_internal"]),
                        kind="revision",
                        source_work_unit_id=str(unit.get("id") or ""),
                        reason="split_failed_or_broad_unit",
                        save=False,
                    )
                    if second:
                        created.append(second)
        if created:
            plan["updated_at"] = now_iso()
            session.swarm_plan = update_work_unit_readiness(plan, session.tasks)
            self.assess_session(session, save=False)
            self._touch(session)
            if save:
                self._save()
        return created

    def add_swarm_work_unit(
        self,
        session: CoworkSession,
        *,
        title: str,
        description: str,
        assigned_agent_id: str,
        dependencies: list[str] | None = None,
        tool_allowlist: list[str] | None = None,
        kind: str = "follow_up",
        source_work_unit_id: str = "",
        reason: str = "",
        input_data: dict[str, Any] | None = None,
        save: bool = True,
    ) -> dict[str, Any] | None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if not plan:
            return None
        boundary = self._swarm_autonomy_boundary(session, tool_allowlist or ["cowork_internal"])
        if boundary:
            self._record_swarm_replan_boundary(session, boundary, source_work_unit_id=source_work_unit_id, reason=reason)
            if save:
                self._touch(session)
                self._save()
            return None
        state = self.ensure_session_budget(session)
        max_work_units = state["limits"].get("max_work_units")
        units = self._swarm_work_units(session)
        if max_work_units is not None and len(units) >= int(max_work_units):
            self.record_stop_reason(
                session,
                "work_unit_budget_exhausted",
                "Swarm replanning stopped because the work-unit budget is exhausted",
                data={"max_work_units": max_work_units, "source_work_unit_id": source_work_unit_id, "reason": reason},
                save=False,
            )
            return None
        proposed = {
            "title": title,
            "description": description,
            "input": input_data or {"source_work_unit_id": source_work_unit_id, "reason": reason},
            "expected_output_schema": {"answer": "string", "evidence": "array", "risks": "array", "artifacts": "array", "confidence": "number"},
        }
        signature = self._swarm_unit_signature(proposed)
        if any(self._swarm_unit_signature(unit) == signature for unit in units):
            self.add_event(
                session,
                "swarm.replan_duplicate_rejected",
                f"Rejected duplicate replanned work unit '{title}'",
                actor_id="scheduler",
                data={"source_work_unit_id": source_work_unit_id, "reason": reason, "signature": signature},
                save=False,
            )
            return None
        task = self.add_task(
            session,
            title=title,
            description=description,
            assigned_agent_id=assigned_agent_id if assigned_agent_id in session.agents else self.lead_agent_id(session),
            dependencies=[dep for dep in (dependencies or []) if dep in session.tasks],
            expected_output="Structured swarm follow-up result with answer, evidence, risks, artifacts, confidence, and open_questions.",
            source_event_id=f"swarm_replan:{source_work_unit_id or reason or self._new_id('src')}",
            runtime_created=True,
            save=False,
        )
        unit = self.swarm_work_unit_for_task(session, task.id)
        if not unit:
            return None
        unit["kind"] = kind
        unit["source_work_unit_id"] = source_work_unit_id
        unit["replan_reason"] = reason
        unit["tool_allowlist"] = [tool for tool in dict.fromkeys(tool_allowlist or unit.get("tool_allowlist") or ["cowork_internal"])]
        unit["input"] = proposed["input"]
        unit["expected_output_schema"] = proposed["expected_output_schema"]
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        self.add_event(
            session,
            "swarm.work_unit_added",
            f"Added replanned work unit '{title}'",
            actor_id="scheduler",
            data={"work_unit_id": unit.get("id"), "source_work_unit_id": source_work_unit_id, "reason": reason, "kind": kind},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit replanned",
            actor_id="scheduler",
            status=unit.get("status", "pending"),
            summary=f"Added replanned work unit '{title}'",
            data={"work_unit_id": unit.get("id"), "source_work_unit_id": source_work_unit_id, "reason": reason, "kind": kind},
            save=False,
        )
        if save:
            self._touch(session)
            self._save()
        return unit

    def start_work_unit(
        self,
        session: CoworkSession,
        work_unit_id: str,
        agent_id: str,
        *,
        run_id: str | None = None,
        round_id: str | None = None,
        save: bool = True,
    ) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        if unit.get("status") == "in_progress":
            return f"Error: work unit '{work_unit_id}' is already in progress"
        if unit.get("status") not in {"ready", "pending", "failed", "needs_revision"}:
            return f"Error: work unit '{work_unit_id}' is {unit.get('status')}"
        agent_id = self._slug(agent_id)
        if agent_id not in session.agents:
            return f"Error: agent '{agent_id}' not found"
        dependencies = set(unit.get("dependencies") or [])
        completed_units = {
            item.get("id")
            for item in (session.swarm_plan.get("work_units", []) if isinstance(session.swarm_plan, dict) else [])
            if isinstance(item, dict) and item.get("status") in {"completed", "skipped"}
        }
        completed_tasks = {task_id for task_id, task in session.tasks.items() if task.status in {"completed", "skipped"}}
        if not dependencies <= (completed_units | completed_tasks):
            missing = sorted(dependencies - (completed_units | completed_tasks))
            return f"Error: work unit '{work_unit_id}' is blocked by dependencies: {', '.join(missing)}"
        unit["status"] = "in_progress"
        unit["assigned_agent_id"] = agent_id
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            task = session.tasks[source_task_id]
            task.status = "in_progress"
            task.assigned_agent_id = agent_id
            task.updated_at = unit["updated_at"]
        agent = session.agents[agent_id]
        agent.status = "working"
        agent.current_task_id = source_task_id if source_task_id in session.tasks else agent.current_task_id
        agent.current_task_title = unit.get("title") or agent.current_task_title
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit started",
            actor_id=agent_id,
            run_id=run_id,
            round_id=round_id,
            status="in_progress",
            summary=f"{agent.name} started work unit '{unit.get('title') or work_unit_id}'",
            data={"work_unit_id": work_unit_id, "agent_id": agent_id, "source_task_id": source_task_id},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' started by {agent.name}."

    def complete_work_unit(
        self,
        session: CoworkSession,
        work_unit_id: str,
        result: dict[str, Any] | str,
        *,
        confidence: float | None = None,
        save: bool = True,
    ) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        payload = result if isinstance(result, dict) else {"answer": str(result)}
        unit["status"] = "completed"
        unit["result"] = payload
        unit["evidence"] = payload.get("evidence", []) if isinstance(payload.get("evidence", []), list) else []
        unit["risks"] = payload.get("risks", []) if isinstance(payload.get("risks", []), list) else []
        unit["open_questions"] = payload.get("open_questions", []) if isinstance(payload.get("open_questions", []), list) else []
        unit["artifacts"] = payload.get("artifacts", []) if isinstance(payload.get("artifacts", []), list) else []
        unit["confidence"] = self._coerce_confidence(payload.get("confidence", confidence))
        unit["error"] = None
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            self.complete_task(session, source_task_id, json.dumps(payload, ensure_ascii=False), status="completed")
            return f"Work unit '{unit.get('title') or work_unit_id}' completed."
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit completed",
            actor_id=unit.get("assigned_agent_id"),
            status="completed",
            output_ref=payload.get("answer", ""),
            summary=f"Work unit '{unit.get('title') or work_unit_id}' completed",
            data={"work_unit_id": work_unit_id, "confidence": unit["confidence"]},
            save=False,
        )
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' completed."

    def fail_work_unit(self, session: CoworkSession, work_unit_id: str, error: str, *, save: bool = True) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        unit["status"] = "failed"
        unit["error"] = error
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            task = session.tasks[source_task_id]
            task.status = "failed"
            task.error = error
            task.updated_at = unit["updated_at"]
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit failed",
            actor_id=unit.get("assigned_agent_id"),
            status="failed",
            summary=f"Work unit '{unit.get('title') or work_unit_id}' failed",
            data={"work_unit_id": work_unit_id, "source_task_id": source_task_id},
            error=error,
            save=False,
        )
        self.replan_swarm(session, source_kind="work_unit", source_id=work_unit_id, save=False)
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' failed."

    def retry_work_unit(self, session: CoworkSession, work_unit_id: str, *, reason: str = "", save: bool = True) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        attempts = int(unit.get("attempts", 0) or 0)
        max_attempts = int(unit.get("max_attempts", 1) or 1)
        if attempts >= max_attempts:
            return f"Error: work unit '{work_unit_id}' reached max attempts"
        unit["attempts"] = attempts + 1
        unit["status"] = "pending"
        unit["error"] = None
        unit["priority"] = int(unit.get("priority", 0) or 0) + 10
        unit["priority_boost_reason"] = reason or "user_retry"
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            task = session.tasks[source_task_id]
            task.status = "pending"
            task.error = None
            task.updated_at = unit["updated_at"]
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit retried",
            actor_id="user",
            status=unit["status"],
            summary=f"Retry requested for work unit '{unit.get('title') or work_unit_id}'",
            data={"work_unit_id": work_unit_id, "reason": reason, "attempts": unit["attempts"]},
            save=False,
        )
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' queued for retry."

    def skip_work_unit(self, session: CoworkSession, work_unit_id: str, *, reason: str = "", save: bool = True) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        unit["status"] = "skipped"
        unit["skip_reason"] = reason
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            task = session.tasks[source_task_id]
            task.status = "skipped"
            task.result = reason or "Skipped."
            task.updated_at = unit["updated_at"]
        session.swarm_plan = update_work_unit_readiness(session.swarm_plan, session.tasks)
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit skipped",
            actor_id="user",
            status="skipped",
            summary=f"Work unit '{unit.get('title') or work_unit_id}' skipped",
            data={"work_unit_id": work_unit_id, "reason": reason, "source_task_id": source_task_id},
            save=False,
        )
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' skipped."

    def cancel_work_unit(self, session: CoworkSession, work_unit_id: str, *, reason: str = "", save: bool = True) -> str:
        unit = self._find_swarm_work_unit(session, work_unit_id)
        if unit is None:
            return f"Error: work unit '{work_unit_id}' not found"
        unit["status"] = "cancelled"
        unit["cancel_reason"] = reason
        unit["updated_at"] = now_iso()
        source_task_id = unit.get("source_task_id")
        if source_task_id in session.tasks:
            task = session.tasks[source_task_id]
            task.status = "skipped"
            task.result = reason or "Cancelled."
            task.updated_at = unit["updated_at"]
        self.add_trace_event(
            session,
            kind="swarm",
            name="Work unit cancelled",
            actor_id="user",
            status="cancelled",
            summary=f"Work unit '{unit.get('title') or work_unit_id}' cancelled",
            data={"work_unit_id": work_unit_id, "reason": reason},
            save=False,
        )
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return f"Work unit '{unit.get('title') or work_unit_id}' cancelled."

    @staticmethod
    def _find_swarm_work_unit(session: CoworkSession, work_unit_id: str) -> dict[str, Any] | None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
        for unit in units:
            if isinstance(unit, dict) and unit.get("id") == work_unit_id:
                return unit
        return None

    @staticmethod
    def _swarm_work_units(session: CoworkSession) -> list[dict[str, Any]]:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        units = plan.get("work_units") if isinstance(plan.get("work_units"), list) else []
        return [unit for unit in units if isinstance(unit, dict)]

    @staticmethod
    def _swarm_unit_signature(unit: dict[str, Any]) -> str:
        input_data = unit.get("input") if isinstance(unit.get("input"), dict) else {}
        schema = unit.get("expected_output_schema") if isinstance(unit.get("expected_output_schema"), dict) else {}
        material = json.dumps(
            {
                "title": " ".join(str(unit.get("title") or "").lower().split()),
                "description": " ".join(str(unit.get("description") or "").lower().split()),
                "input": input_data,
                "schema": schema,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        return hashlib.sha1(material.encode("utf-8")).hexdigest()

    def _swarm_unit_priority(self, unit: dict[str, Any]) -> tuple[int, str]:
        score = int(unit.get("priority", 0) or 0) * 10
        if unit.get("error") or unit.get("status") == "needs_revision":
            score += 40
        title = f"{unit.get('title', '')} {unit.get('description', '')}".lower()
        if any(marker in title for marker in ("unblock", "blocked", "fix", "review", "risk")):
            score += 20
        return (-score, str(unit.get("id") or ""))

    def _swarm_agent_for_unit(self, session: CoworkSession, unit: dict[str, Any]) -> str:
        owner = str(unit.get("assigned_agent_id") or "").strip()
        if owner in session.agents and getattr(session.agents[owner], "lifecycle_status", "active") != "retired":
            return owner
        source_task_id = str(unit.get("source_task_id") or "")
        task = session.tasks.get(source_task_id)
        if task and task.assigned_agent_id in session.agents:
            unit["assigned_agent_id"] = task.assigned_agent_id
            return task.assigned_agent_id or ""
        lead_id = self.lead_agent_id(session)
        unit["assigned_agent_id"] = lead_id
        if task:
            task.assigned_agent_id = lead_id
        return lead_id

    def _existing_swarm_gate_task(self, session: CoworkSession, gate: str) -> CoworkTask | None:
        prefix = f"swarm_{gate}:"
        return next((task for task in session.tasks.values() if str(getattr(task, "source_event_id", "")).startswith(prefix)), None)

    def _swarm_follow_up_signals(self, unit: dict[str, Any]) -> list[str]:
        result = unit.get("result") if isinstance(unit.get("result"), dict) else {}
        signals = []
        signals.extend(self._string_list_from_any(result.get("missing_work")))
        signals.extend(self._string_list_from_any(unit.get("open_questions")))
        signals.extend(self._string_list_from_any(result.get("open_questions")))
        seen: set[str] = set()
        unique = []
        for signal in signals:
            text = " ".join(str(signal or "").split())
            if text and text.lower() not in seen:
                unique.append(text)
                seen.add(text.lower())
        return unique[:4]

    @staticmethod
    def _swarm_unit_needs_split(unit: dict[str, Any]) -> bool:
        attempts = int(unit.get("attempts", 0) or 0)
        max_attempts = int(unit.get("max_attempts", 1) or 1)
        text = f"{unit.get('title', '')} {unit.get('description', '')} {unit.get('error', '')}".lower()
        return attempts >= max_attempts or any(marker in text for marker in ("too broad", "broad scope", "scope too large", "split", "too large"))

    @staticmethod
    def _string_list_from_any(value: Any) -> list[str]:
        if isinstance(value, str):
            return [value] if value.strip() else []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item or "").strip()]
        return []

    @staticmethod
    def _swarm_autonomy_boundary(session: CoworkSession, tool_allowlist: list[str]) -> dict[str, Any] | None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        policy = plan.get("policy", {}) if isinstance(plan.get("policy", {}), dict) else {}
        allowed_tools = {str(item).strip() for item in policy.get("allowed_tools", []) if str(item).strip()}
        requested = [str(tool).strip() for tool in tool_allowlist if str(tool).strip()]
        if allowed_tools:
            disallowed = [tool for tool in requested if tool not in allowed_tools]
            if disallowed:
                return {"code": "disallowed_tool", "tools": disallowed}
        checks = (
            ("allow_file_writes", {"write_file", "edit_file"}, "file_write_requires_approval"),
            ("allow_exec", {"exec"}, "exec_requires_approval"),
            ("allow_web", {"web", "web_search", "browser"}, "network_requires_approval"),
        )
        for policy_key, tools, code in checks:
            if policy.get(policy_key) is False and any(tool in tools for tool in requested):
                return {"code": code, "tools": sorted(tools & set(requested))}
        if any(marker in " ".join(requested).lower() for marker in ("credential", "secret")):
            return {"code": "credentials_required", "tools": requested}
        return None

    def _record_swarm_replan_boundary(
        self,
        session: CoworkSession,
        boundary: dict[str, Any],
        *,
        source_work_unit_id: str,
        reason: str,
    ) -> None:
        plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
        if plan:
            plan["status"] = "blocked"
            plan["updated_at"] = now_iso()
            session.swarm_plan = plan
        self.record_stop_reason(
            session,
            "autonomy_boundary",
            "Swarm replanning stopped at an autonomy boundary",
            data={"boundary": boundary, "source_work_unit_id": source_work_unit_id, "reason": reason},
            save=False,
        )

    def request_task_review(
        self,
        session: CoworkSession,
        task_id: str,
        reviewer_agent_id: str | None = None,
        *,
        save: bool = True,
    ) -> CoworkTask | str:
        source = session.tasks.get(task_id)
        if not source:
            return f"Error: task '{task_id}' not found"
        reviewer_id = self._slug(reviewer_agent_id) if reviewer_agent_id else ""
        if reviewer_id not in session.agents:
            reviewer = next((agent for agent in session.agents.values() if self._is_reviewer_agent(agent)), None)
            reviewer_id = reviewer.id if reviewer else self.lead_agent_id(session)
        title = f"Review {source.title}"
        existing = next(
            (
                task
                for task in session.tasks.values()
                if task.status in {"pending", "in_progress"}
                and task.assigned_agent_id == reviewer_id
                and task.dependencies == [source.id]
                and self._looks_like_review_task(task.title, task.description)
            ),
            None,
        )
        if existing:
            return existing
        review_task = self.add_task(
            session,
            title=title,
            description=(
                "Review the source task for correctness, completeness, risks, missing evidence, "
                f"and whether it satisfies the original goal. Source task: {source.id}. "
                f"Result: {(source.result or '')[:1000]}"
            ),
            assigned_agent_id=reviewer_id,
            dependencies=[source.id],
            save=False,
        )
        self.add_event(
            session,
            "task.review_requested",
            f"Review requested for task '{source.title}'",
            actor_id="user",
            data={"task_id": source.id, "review_task_id": review_task.id, "reviewer_agent_id": reviewer_id},
            save=False,
        )
        self.add_trace_event(
            session,
            kind="review",
            name="Review requested",
            actor_id="user",
            status="pending",
            summary=f"Review requested for task '{source.title}'",
            data={"task_id": source.id, "review_task_id": review_task.id, "reviewer_agent_id": reviewer_id},
            save=False,
        )
        self.assess_session(session, save=False)
        self._touch(session)
        if save:
            self._save()
        return review_task

    def format_status(self, session: CoworkSession, *, verbose: bool = False) -> str:
        lines = [
            f"## {session.title} ({session.id})",
            f"Status: {session.status}",
            f"Architecture: {session.workflow_mode} ({architecture_label(session.workflow_mode)})",
            f"Goal: {session.goal}",
            f"Focus: {session.current_focus_task or '-'}",
            f"Rounds: {session.rounds}",
            "",
            "### Agents",
        ]
        for agent in session.agents.values():
            inbox = len(agent.inbox)
            task_count = sum(1 for task in session.tasks.values() if task.assigned_agent_id == agent.id and task.status in {"pending", "in_progress"})
            lines.append(f"- {agent.id}: {agent.name} / {agent.role} [{agent.status}], inbox={inbox}, active_tasks={task_count}")
            if verbose and agent.private_summary:
                lines.append(f"  Summary: {agent.private_summary[:240]}")
        lines.append("")
        lines.append("### Tasks")
        for task in session.tasks.values():
            owner = task.assigned_agent_id or "unassigned"
            lines.append(f"- {task.id}: {task.title} -> {owner} [{task.status}]")
            if verbose and task.result:
                lines.append(f"  Result: {task.result[:240]}")
        open_threads = [t for t in session.threads.values() if t.status == "open"]
        lines.append("")
        lines.append(f"### Open Threads ({len(open_threads)})")
        for thread in open_threads[:10]:
            lines.append(f"- {thread.id}: {thread.topic} ({len(thread.message_ids)} messages)")
        if verbose and session.events:
            lines.append("")
            lines.append("### Recent Events")
            for event in session.events[-10:]:
                lines.append(f"- [{event.created_at}] {event.type}: {event.message}")
        decision = session.completion_decision or self.assess_session(session, save=False)
        if verbose and decision:
            lines.append("")
            lines.append("### Cowork Intelligence")
            lines.append(f"- Next action: {decision.get('next_action', '-')}")
            lines.append(f"- Reason: {decision.get('reason', '-')}")
            if decision.get("goal_review"):
                goal_review = decision["goal_review"]
                lines.append(f"- Goal review: {goal_review.get('reason', '-')}")
            if session.artifacts:
                lines.append(f"- Artifacts: {', '.join(session.artifacts[-5:])}")
        return "\n".join(lines)

    @staticmethod
    def default_team(goal: str, *, workflow_mode: str = ADAPTIVE_STARTER) -> list[dict[str, Any]]:
        mode = CoworkService.normalize_workflow_mode(workflow_mode)
        lead = {
            "id": "coordinator",
            "name": "Coordinator",
            "role": "Team coordinator",
            "goal": f"Keep the collaboration focused on: {goal}",
            "responsibilities": ["Break down work", "Route questions", "Synthesize final progress"],
            "tools": ["cowork_internal"],
            "subscriptions": ["coordination", "handoff", "unblock", "decision", "summary"],
        }
        researcher = {
            "id": "researcher",
            "name": "Researcher",
            "role": "Information gatherer",
            "goal": f"Gather useful facts and constraints for: {goal}",
            "responsibilities": ["Investigate relevant sources", "Summarize findings", "Flag uncertainty"],
            "tools": ["read_file", "list_dir", "cowork_internal"],
            "subscriptions": ["research", "produce", "finding", "source", "context"],
        }
        analyst = {
            "id": "analyst",
            "name": "Analyst",
            "role": "Reasoning and verification partner",
            "goal": f"Check assumptions and turn findings into decisions for: {goal}",
            "responsibilities": ["Compare options", "Verify claims", "Identify risks"],
            "tools": ["read_file", "list_dir", "cowork_internal"],
            "subscriptions": ["analysis", "review", "verify", "risk", "decision"],
        }
        if mode in {"orchestrator", "supervisor"}:
            return [lead]
        if mode == "generator_verifier":
            return [
                {
                    "id": "producer",
                    "name": "Producer",
                    "role": "Primary answer producer",
                    "goal": f"Produce a concrete answer or artifact for: {goal}",
                    "responsibilities": ["Create the main output", "State assumptions", "Hand off for verification"],
                    "tools": ["read_file", "list_dir", "cowork_internal"],
                    "subscriptions": ["produce", "draft", "artifact", "handoff"],
                },
                {
                    "id": "verifier",
                    "name": "Verifier",
                    "role": "Quality verifier",
                    "goal": f"Verify correctness, gaps, and risks for: {goal}",
                    "responsibilities": ["Check the output", "Identify issues", "Recommend fixes or approval"],
                    "tools": ["read_file", "list_dir", "cowork_internal"],
                    "subscriptions": ["verify", "review", "risk", "quality"],
                },
            ]
        if mode == "message_bus":
            return [
                lead,
                {
                    "id": "router",
                    "name": "Router",
                    "role": "Message bus router",
                    "goal": f"Route topic-specific requests for: {goal}",
                    "responsibilities": ["Classify requests", "Maintain lineage", "Escalate blockers"],
                    "tools": ["cowork_internal"],
                    "subscriptions": ["routing", "event", "lineage", "unblock"],
                },
            ]
        if mode == "shared_state":
            return [
                lead,
                {
                    "id": "memory_curator",
                    "name": "Memory Curator",
                    "role": "Shared-state curator",
                    "goal": f"Keep durable findings, risks, decisions, and artifacts organized for: {goal}",
                    "responsibilities": ["Extract shared memory", "Track open questions", "Keep decisions explicit"],
                    "tools": ["read_file", "list_dir", "cowork_internal"],
                    "subscriptions": ["finding", "risk", "decision", "artifact", "memory"],
                },
            ]
        if mode == "peer_handoff":
            return [
                {
                    "id": "planner",
                    "name": "Planner",
                    "role": "First-step planner",
                    "goal": f"Define the next concrete handoff step for: {goal}",
                    "responsibilities": ["Frame the next step", "Hand off clearly", "Avoid parallel duplication"],
                    "tools": ["cowork_internal"],
                    "subscriptions": ["plan", "handoff", "next_step"],
                },
                {
                    "id": "finisher",
                    "name": "Finisher",
                    "role": "Completion owner",
                    "goal": f"Complete the final handoff and synthesize the answer for: {goal}",
                    "responsibilities": ["Receive handoffs", "Complete the last step", "Summarize results"],
                    "tools": ["read_file", "list_dir", "cowork_internal"],
                    "subscriptions": ["handoff", "complete", "summary"],
                },
            ]
        if mode in {"team", "swarm"}:
            return [lead, researcher]
        return [lead, researcher, analyst]

    @staticmethod
    def lead_agent_id(session: CoworkSession) -> str:
        for candidate in ("coordinator", "lead", "team_lead", "team-lead"):
            if candidate in session.agents:
                return candidate
        return next(iter(session.agents))

    @staticmethod
    def _merge_private_summary(previous: str, addition: str) -> str:
        text = (previous + "\n\n" + addition.strip()).strip() if previous else addition.strip()
        if len(text) <= _MAX_PRIVATE_SUMMARY_CHARS:
            return text
        return text[-_MAX_PRIVATE_SUMMARY_CHARS:]

    @staticmethod
    def _new_id(prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:8]}"

    @staticmethod
    def _slug(value: Any) -> str:
        text = str(value or "").strip().lower()
        text = re.sub(r"[^a-z0-9_\-]+", "_", text)
        text = re.sub(r"_+", "_", text).strip("_")
        return text[:40] or "item"

    @staticmethod
    def _agent_subscriptions(raw: dict[str, Any]) -> list[str]:
        explicit = raw.get("subscriptions", [])
        values = explicit if isinstance(explicit, list) else []
        if not values:
            values = [
                raw.get("id", ""),
                raw.get("role", ""),
                *(raw.get("responsibilities", []) if isinstance(raw.get("responsibilities", []), list) else []),
            ]
        seen = []
        for value in values:
            text = str(value or "").strip().lower().replace(" ", "_")
            text = re.sub(r"[^a-z0-9_\-\u4e00-\u9fff]+", "_", text).strip("_")
            if text and text not in seen:
                seen.append(text)
        return seen[:12]

    def _touch(self, session: CoworkSession) -> None:
        session.updated_at = now_iso()

    def _update_completion_state(self, session: CoworkSession) -> None:
        unresolved_replies = any(
            record.requires_reply and record.status in {"delivered", "read"}
            for record in session.mailbox.values()
        )
        if session.tasks and not unresolved_replies and all(task.status in {"completed", "skipped"} for task in session.tasks.values()):
            self.refresh_shared_memory(session, save=False)
            if session.workflow_mode == "swarm" and self.swarm_reducer_should_run(session):
                self.ensure_swarm_reducer_task(session, save=False)
                session.status = "active"
                session.current_focus_task = "Swarm reducer is ready to synthesize completed work units."
                session.completion_decision = {
                    "next_action": "reduce_swarm",
                    "reason": "Required swarm work units are finished; reducer synthesis must run before completion.",
                    "blocked": [],
                    "ready_to_finish": False,
                    "budget": self.budget_state(session),
                    "swarm_plan": getattr(session, "swarm_plan", {}),
                    "updated_at": now_iso(),
                }
                return
            if session.workflow_mode == "swarm":
                plan = getattr(session, "swarm_plan", {}) if isinstance(getattr(session, "swarm_plan", {}), dict) else {}
                if plan.get("status") == "blocked":
                    session.status = "active"
                    session.completion_decision = {
                        "next_action": "resolve_swarm_blocker",
                        "reason": "The swarm plan is blocked and needs user intervention or an allowed alternative.",
                        "blocked": [{"id": "swarm_plan", "request_type": getattr(session, "stop_reason", "") or "blocked", "content": "Swarm plan is blocked."}],
                        "ready_to_finish": False,
                        "swarm_plan": plan,
                        "updated_at": now_iso(),
                    }
                    return
                evaluations = self.evaluate_swarm_completion(session, save=False)
                blocking_evaluations = [item for item in evaluations if item.get("status") in {"block", "error"}]
                if blocking_evaluations:
                    session.status = "active"
                    session.completion_decision = {
                        "next_action": "resolve_evaluation_blockers",
                        "reason": f"{len(blocking_evaluations)} swarm evaluation(s) block completion.",
                        "blocked": [
                            {
                                "id": item.get("id"),
                                "request_type": item.get("kind"),
                                "content": item.get("summary", ""),
                            }
                            for item in blocking_evaluations
                        ],
                        "ready_to_finish": False,
                        "evaluations": evaluations,
                        "updated_at": now_iso(),
                    }
                    return
                if plan:
                    plan["status"] = "completed"
                    plan["updated_at"] = now_iso()
                    session.swarm_plan = plan
            goal_review = self.review_goal_completion(session)
            if not goal_review.get("ready"):
                session.current_focus_task = str(goal_review.get("reason") or session.current_focus_task or session.goal)
                session.completion_decision = {
                    "next_action": "review_goal_completion",
                    "reason": goal_review.get("reason", "Review whether the original goal is fully satisfied."),
                    "blocked": [],
                    "ready_to_finish": False,
                    "goal_review": goal_review,
                    "updated_at": now_iso(),
                }
                return
            session.status = "completed"
            for agent in session.agents.values():
                if agent.status not in {"failed", "blocked"}:
                    agent.status = "done"
            session.completion_decision = {
                "next_action": "complete",
                "reason": "All tasks are complete and there are no unresolved reply requests.",
                "blocked": [],
                "ready_to_finish": True,
                "goal_review": goal_review,
                "updated_at": now_iso(),
            }
            self._capture_current_branch_state(session)

    @staticmethod
    def _task_dependencies_done(session: CoworkSession, task: CoworkTask) -> bool:
        return all(
            session.tasks.get(dep_id) is not None and session.tasks[dep_id].status == "completed"
            for dep_id in task.dependencies
        )

    @staticmethod
    def _agent_mailbox_pressure(session: CoworkSession, agent_id: str) -> int:
        pressure = 0
        for record in session.mailbox.values():
            if agent_id not in record.recipient_ids or record.status in {"replied", "expired"}:
                continue
            if record.message_id in session.agents[agent_id].inbox:
                pressure = max(pressure, record.priority)
            if record.requires_reply and record.status in {"delivered", "read"}:
                pressure = max(pressure, record.priority + 20)
        return pressure

    @staticmethod
    def _agent_subscription_pressure(session: CoworkSession, agent_id: str) -> int:
        agent = session.agents[agent_id]
        subscriptions = {item.lower() for item in getattr(agent, "subscriptions", [])}
        if not subscriptions:
            return 0
        pressure = 0
        for record in session.mailbox.values():
            if record.status in {"replied", "expired"}:
                continue
            labels = {
                str(getattr(record, "topic", "") or "").lower(),
                str(getattr(record, "event_type", "") or "").lower(),
                str(getattr(record, "request_type", "") or "").lower(),
                str(record.kind or "").lower(),
            }
            if labels & subscriptions:
                pressure = max(pressure, 10 + min(record.priority, 40))
        return pressure

    @staticmethod
    def _is_reviewer_agent(agent: CoworkAgent) -> bool:
        text = " ".join([agent.id, agent.name, agent.role, *agent.responsibilities]).lower()
        return any(marker in text for marker in ("review", "verify", "quality", "risk", "评审", "验证", "质量", "风险"))

    @staticmethod
    def _looks_like_review_task(title: str, description: str) -> bool:
        text = f"{title} {description}".lower()
        return any(marker in text for marker in ("review", "verify", "validate", "check", "评审", "验证", "检查", "验收"))

    @staticmethod
    def _has_pending_mailbox_work(session: CoworkSession, agent_id: str) -> bool:
        return any(
            agent_id in record.recipient_ids
            and record.requires_reply
            and record.status in {"delivered", "read"}
            for record in session.mailbox.values()
        )

    @staticmethod
    def _extract_structured_result(result: str) -> dict[str, Any]:
        text = result.strip()
        if not text:
            return {}
        candidates = [text]
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            candidates.append(text[start : end + 1])
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
            except Exception:
                continue
            if isinstance(parsed, dict):
                return parsed
        return {}

    @staticmethod
    def _coerce_confidence(value: Any) -> float | None:
        try:
            confidence = float(value)
        except Exception:
            return None
        if confidence > 1:
            confidence = confidence / 100
        return min(max(confidence, 0), 1)

    def _derive_focus_task(self, session: CoworkSession) -> str:
        pending_replies = [
            record
            for record in session.mailbox.values()
            if record.requires_reply and record.status in {"delivered", "read"}
        ]
        if pending_replies:
            record = max(pending_replies, key=lambda item: (item.priority, item.created_at))
            return f"Resolve {record.request_type or 'reply'} request from {record.sender_id}: {record.content[:220]}"

        active = [task for task in session.tasks.values() if task.status == "in_progress"]
        if active:
            task = sorted(active, key=lambda item: item.updated_at)[0]
            return f"{task.title}: {task.description}"

        ready = [
            task
            for task in session.tasks.values()
            if task.status == "pending" and self._task_dependencies_done(session, task)
        ]
        if ready:
            task = sorted(ready, key=lambda item: item.id)[0]
            return f"{task.title}: {task.description}"

        completed = [task for task in session.tasks.values() if task.status == "completed"]
        if completed:
            review = self.review_goal_completion(session)
            if not review.get("ready"):
                return str(review.get("reason") or "Review whether the original goal is fully satisfied.")
            return "Synthesize completed work into the final answer."
        return session.goal

    def _merge_task_artifacts(self, session: CoworkSession, result_data: dict[str, Any]) -> None:
        values: list[Any] = []
        for key in ("artifacts", "artifact_paths", "generated_files", "files", "paths"):
            raw = result_data.get(key)
            if isinstance(raw, list):
                values.extend(raw)
            elif isinstance(raw, str):
                values.append(raw)
        output_dir = result_data.get("output_dir") or result_data.get("workspace_dir")
        if isinstance(output_dir, str) and output_dir.strip():
            session.workspace_dir = output_dir.strip()
        for value in values:
            text = str(value or "").strip()
            if text and text not in session.artifacts:
                session.artifacts.append(text)
        if len(session.artifacts) > 80:
            session.artifacts = session.artifacts[-80:]

    @staticmethod
    def _lead_should_synthesize(session: CoworkSession) -> bool:
        if not session.tasks:
            return False
        has_completed = any(task.status == "completed" for task in session.tasks.values())
        has_open_work = any(task.status in {"pending", "in_progress"} for task in session.tasks.values())
        has_user_visible_result = any(
            message.sender_id != "user" and "user" in message.recipient_ids
            for message in session.messages.values()
        )
        return has_completed and (not has_open_work or not has_user_visible_result)

    @staticmethod
    def _build_final_draft(session: CoworkSession) -> str:
        completed = [task for task in session.tasks.values() if task.status == "completed"]
        if not completed:
            return ""
        lines = [f"# {session.title}", "", f"Goal: {session.goal}", "", "## Current Answer"]
        for task in completed[-10:]:
            data = task.result_data or {}
            answer = str(data.get("answer") or task.result or "").strip()
            confidence = f" (confidence {task.confidence:.0%})" if task.confidence is not None else ""
            lines.append(f"- {task.title}{confidence}: {answer[:700] if answer else 'Completed.'}")
        open_questions = [
            item
            for task in completed
            if isinstance(task.result_data.get("open_questions"), list)
            for item in (task.result_data.get("open_questions") or [])
            if str(item).strip()
        ]
        if open_questions:
            lines.extend(["", "## Open Questions"])
            lines.extend(f"- {str(item).strip()}" for item in open_questions[-8:])
        return "\n".join(lines)

    def _mark_mailbox_read_for_message(self, session: CoworkSession, message_id: str, agent_id: str) -> None:
        for record in session.mailbox.values():
            if record.message_id != message_id or record.status in {"replied", "expired"}:
                continue
            if agent_id not in record.read_by:
                record.read_by.append(agent_id)
            agent_recipients = [recipient for recipient in record.recipient_ids if recipient in session.agents]
            if agent_recipients and all(recipient in record.read_by for recipient in agent_recipients):
                record.status = "read"
                record.updated_at = now_iso()
                self.add_event(
                    session,
                    "mailbox.read",
                    f"Mailbox envelope {record.id} was read",
                    actor_id=agent_id,
                    data={"envelope_id": record.id, "message_id": message_id},
                    save=False,
                )
