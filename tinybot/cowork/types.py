"""Persistent data types for cowork sessions."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal


AgentStatus = Literal["idle", "working", "waiting", "blocked", "done", "failed"]
TaskStatus = Literal["pending", "in_progress", "completed", "failed", "skipped"]
SessionStatus = Literal["active", "paused", "completed", "failed"]
ThreadStatus = Literal["open", "resolved"]


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
    communication_policy: str = "Ask other agents for missing information, validation, or review when useful."
    context_policy: str = "Use private context plus relevant shared session state; avoid repeating full history."
    status: AgentStatus = "idle"
    private_summary: str = ""
    inbox: list[str] = field(default_factory=list)
    current_task_id: str | None = None
    last_active_at: str | None = None
    rounds: int = 0


@dataclass
class CoworkTask:
    """A task assigned to a cowork agent."""

    id: str
    title: str
    description: str
    assigned_agent_id: str
    dependencies: list[str] = field(default_factory=list)
    status: TaskStatus = "pending"
    result: str | None = None
    error: str | None = None
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
class CoworkSession:
    """A dynamic multi-agent collaboration session."""

    id: str
    title: str
    goal: str
    status: SessionStatus = "active"
    agents: dict[str, CoworkAgent] = field(default_factory=dict)
    tasks: dict[str, CoworkTask] = field(default_factory=dict)
    threads: dict[str, CoworkThread] = field(default_factory=dict)
    messages: dict[str, CoworkMessage] = field(default_factory=dict)
    events: list[CoworkEvent] = field(default_factory=list)
    shared_summary: str = ""
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    rounds: int = 0

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
