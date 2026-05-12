"""Derived Cowork graph and trace snapshots for UI/API surfaces."""

from __future__ import annotations

import math
from typing import Any

from tinybot.cowork.types import CoworkEvent, CoworkSession


def _compact(value: Any, limit: int = 180) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "..."


def _status_tone(status: str) -> str:
    value = str(status or "").lower()
    if value in {"completed", "done", "replied"}:
        return "completed"
    if value in {"failed", "blocked", "expired"}:
        return "failed"
    if value in {"working", "in_progress", "active"}:
        return "active"
    if value in {"waiting", "queued", "delivered", "read", "pending", "paused"}:
        return "pending"
    return "idle"


def _add_edge(edges: list[dict[str, Any]], source: str, target: str, kind: str, **extra: Any) -> None:
    if not source or not target or source == target:
        return
    key = (source, target, kind)
    if any((edge.get("from"), edge.get("to"), edge.get("kind")) == key for edge in edges):
        return
    payload = {"from": source, "to": target, "source": source, "target": target, "kind": kind}
    payload.update(extra)
    edges.append(payload)


def build_cowork_graph(session: CoworkSession) -> dict[str, Any]:
    """Return a stable graph projection of a Cowork session.

    The shape intentionally includes both ``from/to`` and ``source/target`` so
    current WebUI code and teacher-inspired graph components can consume it.
    """

    visible_agent_limit = 6
    nodes: list[dict[str, Any]] = [
        {
            "id": "session",
            "kind": "session",
            "label": session.title,
            "title": session.title,
            "detail": _compact(session.current_focus_task or session.goal, 220),
            "status": session.status,
            "tone": _status_tone(session.status),
            "badge": getattr(session, "workflow_mode", "hybrid"),
            "x": 600,
            "y": 310,
        }
    ]
    edges: list[dict[str, Any]] = []

    def agent_priority(agent: Any) -> tuple[int, int, int, int]:
        waiting = sum(
            1
            for record in session.mailbox.values()
            if agent.id in record.recipient_ids and record.requires_reply and record.status in {"delivered", "read"}
        )
        open_tasks = sum(
            1
            for task in session.tasks.values()
            if task.assigned_agent_id == agent.id and task.status in {"pending", "in_progress"}
        )
        active_status = 1 if agent.status in {"working", "waiting", "blocked"} else 0
        return (active_status, waiting, open_tasks, len(agent.inbox))

    agents = sorted(session.agents.values(), key=agent_priority, reverse=True)[:visible_agent_limit]
    visible_agent_ids = {agent.id for agent in agents}
    agent_radius_x = max(240, min(360, 180 + len(agents) * 26))
    agent_radius_y = max(155, min(230, 118 + len(agents) * 14))
    for index, agent in enumerate(agents):
        angle = -math.pi / 2 + (math.tau * index) / max(len(agents), 1)
        x = 600 + math.cos(angle) * agent_radius_x
        y = 310 + math.sin(angle) * agent_radius_y
        pending_replies = [
            record.id
            for record in session.mailbox.values()
            if agent.id in record.recipient_ids and record.requires_reply and record.status in {"delivered", "read"}
        ]
        latest_direct = next(
            (
                record
                for record in reversed(list(session.mailbox.values()))
                if agent.id in record.recipient_ids or record.sender_id == agent.id
            ),
            None,
        )
        detail_parts = [
            agent.role or "Agent",
            agent.current_task_title or agent.goal,
            latest_direct.content if latest_direct else "",
        ]
        nodes.append(
            {
                "id": f"agent:{agent.id}",
                "entity_id": agent.id,
                "kind": "agent",
                "label": agent.name,
                "title": agent.name,
                "detail": _compact(" - ".join(part for part in detail_parts if part), 220),
                "status": agent.status,
                "tone": _status_tone(agent.status),
                "badge": f"in {len(agent.inbox)} / wait {len(pending_replies)} / r{agent.rounds or 0}",
                "x": round(x, 2),
                "y": round(y, 2),
            }
        )
        _add_edge(edges, "session", f"agent:{agent.id}", "member")

    recent_mailbox = list(session.mailbox.values())[-14:]
    for index, record in enumerate(recent_mailbox):
        sender = f"agent:{record.sender_id}" if record.sender_id in visible_agent_ids else "session"
        for recipient_id in record.recipient_ids:
            if recipient_id not in visible_agent_ids:
                continue
            _add_edge(
                edges,
                sender,
                f"agent:{recipient_id}",
                "communication",
                pulse=index >= max(0, len(recent_mailbox) - 4) or record.requires_reply,
                status=record.status,
                topic=getattr(record, "topic", ""),
                event_type=getattr(record, "event_type", ""),
                lineage_id=getattr(record, "lineage_id", None),
                request_type=record.request_type,
                requires_reply=record.requires_reply,
                detail=_compact(record.content, 180),
            )

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges),
            "agents": len(agents),
            "total_agents": len(session.agents),
            "tasks": len(session.tasks),
            "threads": len(session.threads),
            "mailbox": len(session.mailbox),
            "artifacts": len(getattr(session, "artifacts", [])),
            "communications": sum(1 for edge in edges if edge.get("kind") == "communication"),
        },
    }


def _event_stage(event: CoworkEvent) -> str:
    event_type = str(event.type or "")
    if event_type.startswith("scheduler."):
        return "scheduler"
    if event_type.startswith("agent."):
        return "agent"
    if event_type.startswith("task."):
        return "task"
    if event_type.startswith("mailbox.") or event_type.startswith("message."):
        return "message"
    if event_type.startswith("session."):
        return "session"
    return "event"


def _event_action(event: CoworkEvent) -> str:
    labels = {
        "session.created": "Session created",
        "scheduler.round": "Scheduler round",
        "scheduler.idle": "Scheduler idle",
        "scheduler.lead_synthesis": "Lead synthesis",
        "agent.started": "Agent started",
        "agent.ran": "Agent finished",
        "agent.failed": "Agent failed",
        "task.added": "Task added",
        "task.assigned": "Task assigned",
        "task.completed": "Task completed",
        "mailbox.delivered": "Mailbox delivered",
        "mailbox.read": "Mailbox read",
    }
    return labels.get(str(event.type or ""), str(event.type or "Event").replace(".", " ").title())


def build_cowork_trace(session: CoworkSession, *, limit: int = 80) -> list[dict[str, Any]]:
    """Return teacher-style trace cards derived from Cowork events."""

    trace = []
    for event in session.events[-limit:]:
        actor_id = event.actor_id or str(event.data.get("agent_id") or "")
        actor = session.agents.get(actor_id)
        node_id = f"agent:{actor_id}" if actor_id in session.agents else "session"
        next_node_id = ""
        data_next = event.data.get("next_agent_id") or event.data.get("assigned_agent_id")
        if data_next in session.agents:
            next_node_id = f"agent:{data_next}"
        task_id = event.data.get("task_id") or event.data.get("blocking_task_id")
        if task_id in session.tasks:
            next_node_id = f"task:{task_id}"

        trace.append(
            {
                "id": event.id,
                "type": event.type,
                "stage": _event_stage(event),
                "action": _event_action(event),
                "detail": event.message,
                "actor_id": actor_id or None,
                "actor_name": actor.name if actor else None,
                "at": event.created_at,
                "status": _status_tone(str(event.data.get("status") or event.type.rsplit(".", 1)[-1])),
                "node_id": node_id,
                "next_node_id": next_node_id,
                "payload": event.data,
            }
        )
    return trace
