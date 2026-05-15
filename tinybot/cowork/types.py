"""Persistent data types for cowork sessions."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


AgentStatus = Literal["idle", "working", "waiting", "blocked", "done", "failed", "retired"]
TaskStatus = Literal["pending", "in_progress", "completed", "failed", "skipped"]
SessionStatus = Literal["active", "paused", "completed", "failed"]
ThreadStatus = Literal["open", "resolved"]
MailboxStatus = Literal["queued", "delivered", "read", "replied", "expired"]
SwarmPlanStatus = Literal["draft", "active", "reducing", "reviewing", "completed", "blocked", "failed", "cancelled"]
SwarmWorkUnitStatus = Literal[
    "pending",
    "ready",
    "in_progress",
    "completed",
    "failed",
    "skipped",
    "needs_revision",
    "cancelled",
]
WorkflowMode = Literal[
    "adaptive_starter",
    "hybrid",
    "supervisor",
    "orchestrator",
    "team",
    "generator_verifier",
    "message_bus",
    "shared_state",
    "peer_handoff",
    "swarm",
]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


@dataclass
class CoworkAgent:
    """A long-lived participant with private context and an inbox."""

    id: str
    name: str
    role: str
    goal: str
    responsibilities: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    subscriptions: list[str] = field(default_factory=list)
    communication_policy: str = "Ask other agents for missing information, validation, or review when useful."
    context_policy: str = "Use private context plus relevant shared session state; avoid repeating full history."
    status: AgentStatus = "idle"
    private_summary: str = ""
    inbox: list[str] = field(default_factory=list)
    current_task_id: str | None = None
    current_task_title: str | None = None
    last_active_at: str | None = None
    rounds: int = 0
    parent_agent_id: str | None = None
    team_id: str = ""
    lifetime: str = "persistent"
    lifecycle_status: str = "active"
    source_blueprint_id: str = ""
    source_event_id: str = ""
    spawn_reason: str = ""


@dataclass
class CoworkTask:
    """A task assigned to a cowork agent."""

    id: str
    title: str
    description: str
    assigned_agent_id: str | None = None
    dependencies: list[str] = field(default_factory=list)
    status: TaskStatus = "pending"
    result: str | None = None
    result_data: dict[str, Any] = field(default_factory=dict)
    confidence: float | None = None
    error: str | None = None
    priority: int = 0
    expected_output: str = ""
    review_required: bool = False
    reviewer_agent_ids: list[str] = field(default_factory=list)
    review_status: str = ""
    fanout_group_id: str = ""
    merge_task_id: str = ""
    source_blueprint_id: str = ""
    source_event_id: str = ""
    runtime_created: bool = False
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass
class CoworkMessage:
    """A message in an agent-to-agent or user-to-agent discussion."""

    id: str
    thread_id: str
    sender_id: str
    recipient_ids: list[str]
    content: str
    created_at: str = field(default_factory=now_iso)
    read_by: list[str] = field(default_factory=list)


@dataclass
class CoworkMailboxRecord:
    """A persisted communication envelope tracked by the cowork mailbox."""

    id: str
    sender_id: str
    recipient_ids: list[str]
    content: str
    visibility: str = "direct"
    kind: str = "message"
    topic: str = ""
    event_type: str = ""
    request_type: str = ""
    status: MailboxStatus = "queued"
    thread_id: str | None = None
    message_id: str | None = None
    requires_reply: bool = False
    priority: int = 0
    deadline_round: int | None = None
    correlation_id: str | None = None
    lineage_id: str | None = None
    reply_to_envelope_id: str | None = None
    caused_by_envelope_id: str | None = None
    expected_output_schema: dict[str, Any] = field(default_factory=dict)
    blocking_task_id: str | None = None
    escalate_after_rounds: int | None = None
    escalated_at: str | None = None
    read_by: list[str] = field(default_factory=list)
    replied_by: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    delivered_at: str | None = None


@dataclass
class CoworkThread:
    """A scoped discussion thread among agents."""

    id: str
    topic: str
    participant_ids: list[str]
    status: ThreadStatus = "open"
    summary: str = ""
    message_ids: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    last_message_at: str | None = None


@dataclass
class CoworkEvent:
    """Append-only event for status and UI updates."""

    id: str
    type: str
    message: str
    actor_id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)


@dataclass
class CoworkTraceSpan:
    """A structured observability span for Cowork runtime activity."""

    id: str
    session_id: str
    run_id: str | None
    round_id: str | None
    kind: str
    name: str
    actor_id: str | None = None
    parent_id: str | None = None
    status: str = "completed"
    started_at: str = field(default_factory=now_iso)
    ended_at: str | None = None
    duration_ms: int | None = None
    input_ref: str = ""
    output_ref: str = ""
    summary: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class CoworkRunMetrics:
    """Compact metrics for a user-triggered Cowork run."""

    run_id: str
    status: str = "running"
    rounds: int = 0
    agent_calls: int = 0
    tool_calls: int = 0
    messages: int = 0
    tasks_created: int = 0
    tasks_completed: int = 0
    artifacts_created: int = 0
    tokens_prompt: int = 0
    tokens_completion: int = 0
    tokens_total: int = 0
    stop_reason: str = ""
    started_at: str = field(default_factory=now_iso)
    ended_at: str | None = None


@dataclass
class CoworkWorkUnit:
    """A deterministic unit of swarm work."""

    id: str
    title: str
    description: str
    input: dict[str, Any] = field(default_factory=dict)
    expected_output_schema: dict[str, Any] = field(default_factory=dict)
    completion_criteria: list[str] = field(default_factory=list)
    assigned_agent_id: str | None = None
    dependencies: list[str] = field(default_factory=list)
    status: SwarmWorkUnitStatus = "pending"
    priority: int = 0
    attempts: int = 0
    max_attempts: int = 2
    tool_allowlist: list[str] = field(default_factory=list)
    result: dict[str, Any] = field(default_factory=dict)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    confidence: float | None = None
    error: str | None = None
    source_task_id: str | None = None
    source_blueprint_id: str = ""
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass
class CoworkSwarmPlan:
    """A first-class swarm execution plan."""

    id: str
    goal: str
    status: SwarmPlanStatus = "draft"
    strategy: str = "map_reduce"
    lead_agent_id: str = ""
    reducer_agent_id: str = ""
    reviewer_agent_id: str | None = None
    work_units: list[CoworkWorkUnit] = field(default_factory=list)
    reducer: dict[str, Any] = field(default_factory=dict)
    review: dict[str, Any] = field(default_factory=dict)
    budgets: dict[str, Any] = field(default_factory=dict)
    policy: dict[str, Any] = field(default_factory=dict)
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass
class CoworkEvaluationResult:
    """A deterministic evaluation record for swarm completion checks."""

    id: str
    kind: str
    status: Literal["pass", "warn", "block", "error"] = "warn"
    score: float | None = None
    summary: str = ""
    issues: list[dict[str, Any]] = field(default_factory=list)
    blocking_work_unit_ids: list[str] = field(default_factory=list)
    blocking_task_ids: list[str] = field(default_factory=list)
    recommended_actions: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)


@dataclass
class CoworkSession:
    """A dynamic multi-agent collaboration session."""

    id: str
    title: str
    goal: str
    status: SessionStatus = "active"
    workflow_mode: WorkflowMode = "adaptive_starter"
    agents: dict[str, CoworkAgent] = field(default_factory=dict)
    tasks: dict[str, CoworkTask] = field(default_factory=dict)
    threads: dict[str, CoworkThread] = field(default_factory=dict)
    messages: dict[str, CoworkMessage] = field(default_factory=dict)
    mailbox: dict[str, CoworkMailboxRecord] = field(default_factory=dict)
    events: list[CoworkEvent] = field(default_factory=list)
    trace_spans: list[CoworkTraceSpan] = field(default_factory=list)
    run_metrics: list[CoworkRunMetrics] = field(default_factory=list)
    scheduler_decisions: list[dict[str, Any]] = field(default_factory=list)
    budget_limits: dict[str, Any] = field(default_factory=dict)
    budget_usage: dict[str, Any] = field(default_factory=dict)
    stop_reason: str = ""
    blueprint: dict[str, Any] = field(default_factory=dict)
    blueprint_diagnostics: list[dict[str, Any]] = field(default_factory=list)
    runtime_state: dict[str, Any] = field(default_factory=dict)
    current_focus_task: str = ""
    workspace_dir: str = ""
    artifacts: list[str] = field(default_factory=list)
    shared_memory: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    shared_summary: str = ""
    final_draft: str = ""
    completion_decision: dict[str, Any] = field(default_factory=dict)
    swarm_plan: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    rounds: int = 0
    no_progress_rounds: int = 0

    def agent(self, agent_id: str) -> CoworkAgent | None:
        return self.agents.get(agent_id)

    def task(self, task_id: str) -> CoworkTask | None:
        return self.tasks.get(task_id)

    def open_threads_for(self, agent_id: str) -> list[CoworkThread]:
        return [
            thread
            for thread in self.threads.values()
            if thread.status == "open" and agent_id in thread.participant_ids
        ]
