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

    nodes: list[dict[str, Any]] = [
        {
            "id": "session",
            "kind": "session",
            "label": session.title,
            "title": session.title,
            "detail": _compact(session.goal, 220),
            "status": session.status,
            "tone": _status_tone(session.status),
            "x": 600,
            "y": 310,
        }
    ]
    edges: list[dict[str, Any]] = []

    agents = list(session.agents.values())
    agent_radius_x = max(240, min(360, 180 + len(agents) * 26))
    agent_radius_y = max(155, min(230, 118 + len(agents) * 14))
    agent_positions: dict[str, tuple[float, float]] = {}
    for index, agent in enumerate(agents):
        angle = -math.pi / 2 + (math.tau * index) / max(len(agents), 1)
        x = 600 + math.cos(angle) * agent_radius_x
        y = 310 + math.sin(angle) * agent_radius_y
        ready_tasks = [
            task.id
            for task in session.tasks.values()
            if task.assigned_agent_id == agent.id and task.status in {"pending", "in_progress"}
        ]
        pending_replies = [
            record.id
            for record in session.mailbox.values()
            if agent.id in record.recipient_ids and record.requires_reply and record.status in {"delivered", "read"}
        ]
        detail = agent.current_task_title or agent.goal or agent.role
        nodes.append(
            {
                "id": f"agent:{agent.id}",
                "entity_id": agent.id,
                "kind": "agent",
                "label": agent.name,
                "title": agent.name,
                "detail": _compact(f"{agent.role} - {detail}", 180),
                "status": agent.status,
                "tone": _status_tone(agent.status),
                "badge": f"in {len(agent.inbox)} / wait {len(pending_replies)} / tasks {len(ready_tasks)}",
                "x": round(x, 2),
                "y": round(y, 2),
            }
        )
        agent_positions[agent.id] = (x, y)
        _add_edge(edges, "session", f"agent:{agent.id}", "member")

    tasks = list(session.tasks.values())[:16]
    for index, task in enumerate(tasks):
        column = index % 2
        row = index // 2
        owner = f"agent:{task.assigned_agent_id}" if task.assigned_agent_id in session.agents else "session"
        node_id = f"task:{task.id}"
        nodes.append(
            {
                "id": node_id,
                "entity_id": task.id,
                "kind": "task",
                "label": task.title,
                "title": task.title,
                "detail": _compact(task.result_data.get("answer") or task.result or task.description, 190),
                "status": task.status,
                "tone": _status_tone(task.status),
                "badge": task.assigned_agent_id or "unassigned",
                "x": 190 if column == 0 else 1010,
                "y": 98 + row * 76,
            }
        )
        _add_edge(edges, owner, node_id, "task")
        for dependency in task.dependencies:
            if dependency in session.tasks:
                _add_edge(edges, f"task:{dependency}", node_id, "depends_on")

    for thread_index, thread in enumerate(list(session.threads.values())[:8]):
        x = 600 + (-1 if thread_index % 2 == 0 else 1) * 315
        y = 72 + (thread_index // 2) * 66
        node_id = f"thread:{thread.id}"
        nodes.append(
            {
                "id": node_id,
                "entity_id": thread.id,
                "kind": "thread",
                "label": thread.topic,
                "title": thread.topic,
                "detail": _compact(thread.summary or f"{len(thread.message_ids)} message(s)", 160),
                "status": thread.status,
                "tone": _status_tone(thread.status),
                "badge": f"{len(thread.participant_ids)} participants",
                "x": x,
                "y": y,
            }
        )
        for participant_id in thread.participant_ids:
            if participant_id in session.agents:
                _add_edge(edges, f"agent:{participant_id}", node_id, "discussion")

    recent_mailbox = list(session.mailbox.values())[-14:]
    for index, record in enumerate(recent_mailbox):
        sender = f"agent:{record.sender_id}" if record.sender_id in session.agents else "session"
        for recipient_id in record.recipient_ids:
            if recipient_id not in session.agents:
                continue
            _add_edge(
                edges,
                sender,
                f"agent:{recipient_id}",
                "mailbox",
                pulse=index >= max(0, len(recent_mailbox) - 4) or record.requires_reply,
                status=record.status,
                request_type=record.request_type,
                requires_reply=record.requires_reply,
            )
            if record.blocking_task_id in session.tasks:
                _add_edge(edges, f"agent:{recipient_id}", f"task:{record.blocking_task_id}", "blocks")

    messages_by_agent: dict[str, list[Any]] = {}
    for message in session.messages.values():
        if message.sender_id in session.agents and str(message.content or "").strip():
            messages_by_agent.setdefault(message.sender_id, []).append(message)
    for agent_id, messages in messages_by_agent.items():
        position = agent_positions.get(agent_id)
        if position is None:
            continue
        for index, message in enumerate(messages[-2:]):
            node_id = f"message:{message.id}"
            x, y = position
            side = -1 if y > 330 else 1
            spread = 0 if len(messages[-2:]) == 1 else (-68 if index == 0 else 68)
            nodes.append(
                {
                    "id": node_id,
                    "entity_id": message.id,
                    "kind": "message",
                    "label": session.agents[agent_id].name,
                    "title": session.agents[agent_id].name,
                    "detail": _compact(message.content, 180),
                    "status": "delivered",
                    "tone": "active",
                    "badge": _compact(message.created_at, 32),
                    "x": max(120, min(1080, x + spread)),
                    "y": max(74, min(560, y + side * (92 + index * 10))),
                }
            )
            _add_edge(edges, f"agent:{agent_id}", node_id, "message", pulse=index == len(messages[-2:]) - 1)

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges),
            "agents": len(session.agents),
            "tasks": len(session.tasks),
            "threads": len(session.threads),
            "mailbox": len(session.mailbox),
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
