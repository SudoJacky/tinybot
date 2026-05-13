"""Derived Cowork graph and trace snapshots for UI/API surfaces."""

from __future__ import annotations

import math
import hashlib
from collections import Counter, defaultdict
from typing import Any

from tinybot.cowork.types import CoworkEvent, CoworkSession, now_iso


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


def build_cowork_graph(
    session: CoworkSession,
    *,
    node_limit: int = 160,
    edge_limit: int = 260,
) -> dict[str, Any]:
    """Return a stable graph projection of a Cowork session.

    The shape intentionally includes both ``from/to`` and ``source/target`` so
    current WebUI code and teacher-inspired graph components can consume it.
    """

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    node_rank: dict[str, int] = {}

    def add_node(node: dict[str, Any], *, rank: int = 100) -> None:
        node.setdefault("label", node.get("title", node.get("id", "")))
        node.setdefault("title", node.get("label", node.get("id", "")))
        node.setdefault("detail", "")
        node.setdefault("status", "idle")
        node.setdefault("tone", _status_tone(str(node.get("status", ""))))
        nodes.append(node)
        node_rank[node["id"]] = rank

    def agent_priority(agent: Any) -> tuple[int, int, int, int, int]:
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
        retired = 1 if getattr(agent, "lifecycle_status", "active") == "retired" else 0
        return (active_status, waiting, open_tasks, len(agent.inbox), -retired)

    add_node(
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
            "workflow_mode": getattr(session, "workflow_mode", "hybrid"),
            "source_blueprint_id": (getattr(session, "blueprint", {}) or {}).get("id", ""),
        },
        rank=0,
    )

    budget_state = getattr(session, "budget_usage", {}) or {}
    add_node(
        {
            "id": "budget",
            "kind": "budget",
            "label": "Budget",
            "title": "Budget",
            "detail": _compact(f"calls {budget_state.get('agent_calls', 0)} / rounds {budget_state.get('rounds', 0)} / stop {getattr(session, 'stop_reason', '') or '-'}", 180),
            "status": "blocked" if getattr(session, "stop_reason", "") and "budget" in getattr(session, "stop_reason", "") else "active",
            "badge": getattr(session, "stop_reason", "") or "limits",
            "x": 980,
            "y": 82,
        },
        rank=8,
    )
    _add_edge(edges, "session", "budget", "has_budget")

    all_agents = sorted(session.agents.values(), key=agent_priority, reverse=True)
    agent_radius_x = max(260, min(390, 190 + min(len(all_agents), 12) * 16))
    agent_radius_y = max(165, min(245, 122 + min(len(all_agents), 12) * 9))
    for index, agent in enumerate(all_agents):
        angle = -math.pi / 2 + (math.tau * index) / max(len(all_agents), 1)
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
        add_node(
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
                "parent_agent_id": getattr(agent, "parent_agent_id", None),
                "team_id": getattr(agent, "team_id", ""),
                "lifecycle_status": getattr(agent, "lifecycle_status", "active"),
                "source_blueprint_id": getattr(agent, "source_blueprint_id", ""),
                "source_event_id": getattr(agent, "source_event_id", ""),
                "runtime_created": not bool(getattr(agent, "source_blueprint_id", "")),
            },
            rank=10 + index,
        )
        _add_edge(edges, "session", f"agent:{agent.id}", "member")
        parent_agent_id = getattr(agent, "parent_agent_id", None)
        if parent_agent_id and parent_agent_id in session.agents:
            _add_edge(edges, f"agent:{parent_agent_id}", f"agent:{agent.id}", "parent_of", team_id=getattr(agent, "team_id", ""))
            _add_edge(edges, f"agent:{parent_agent_id}", f"agent:{agent.id}", "spawned", source_event_id=getattr(agent, "source_event_id", ""))

    task_base_y = 72
    for index, task in enumerate(session.tasks.values()):
        add_node(
            {
                "id": f"task:{task.id}",
                "entity_id": task.id,
                "kind": "task",
                "label": task.title,
                "title": task.title,
                "detail": _compact(task.result_data.get("answer") or task.result or task.description, 220),
                "status": task.status,
                "tone": _status_tone(task.status),
                "badge": task.assigned_agent_id or "shared",
                "x": 160 + (index % 4) * 190,
                "y": task_base_y + (index // 4) * 74,
                "owner": task.assigned_agent_id,
                "dependencies": task.dependencies,
                "priority": getattr(task, "priority", 0),
                "review_required": getattr(task, "review_required", False),
                "review_status": getattr(task, "review_status", ""),
                "fanout_group_id": getattr(task, "fanout_group_id", ""),
                "merge_task_id": getattr(task, "merge_task_id", ""),
                "source_blueprint_id": getattr(task, "source_blueprint_id", ""),
                "source_event_id": getattr(task, "source_event_id", ""),
                "runtime_created": getattr(task, "runtime_created", False),
            },
            rank=40 + index,
        )
        _add_edge(edges, "session", f"task:{task.id}", "has_task")
        if task.assigned_agent_id and task.assigned_agent_id in session.agents:
            _add_edge(edges, f"task:{task.id}", f"agent:{task.assigned_agent_id}", "assigned_to")
        for dependency in task.dependencies:
            if dependency in session.tasks:
                _add_edge(edges, f"task:{dependency}", f"task:{task.id}", "depends_on")
        if getattr(task, "merge_task_id", "") and task.merge_task_id in session.tasks:
            _add_edge(edges, f"task:{task.id}", f"task:{task.merge_task_id}", "synthesizes")

    for index, thread in enumerate(session.threads.values()):
        add_node(
            {
                "id": f"thread:{thread.id}",
                "entity_id": thread.id,
                "kind": "thread",
                "label": thread.topic,
                "title": thread.topic,
                "detail": _compact(thread.summary or f"{len(thread.message_ids)} message(s)", 160),
                "status": thread.status,
                "badge": f"{len(thread.message_ids)} msg",
                "x": 1080,
                "y": 170 + index * 58,
            },
            rank=70 + index,
        )
        _add_edge(edges, "session", f"thread:{thread.id}", "has_thread")
        for participant_id in thread.participant_ids:
            if participant_id in session.agents:
                _add_edge(edges, f"thread:{thread.id}", f"agent:{participant_id}", "participant")

    for index, message in enumerate(list(session.messages.values())[-80:]):
        node_id = f"message:{message.id}"
        add_node(
            {
                "id": node_id,
                "entity_id": message.id,
                "kind": "message",
                "label": _compact(message.content, 52),
                "title": _compact(message.content, 80),
                "detail": _compact(message.content, 220),
                "status": "read" if message.read_by else "delivered",
                "badge": message.sender_id,
                "x": 1040,
                "y": 430 + (index % 8) * 42,
                "thread_id": message.thread_id,
            },
            rank=110 + index,
        )
        sender = f"agent:{message.sender_id}" if message.sender_id in session.agents else "session"
        _add_edge(edges, sender, node_id, "sent")
        if message.thread_id in session.threads:
            _add_edge(edges, f"thread:{message.thread_id}", node_id, "contains")
        for recipient_id in message.recipient_ids:
            if recipient_id in session.agents:
                _add_edge(edges, node_id, f"agent:{recipient_id}", "delivered_to")

    for index, record in enumerate(session.mailbox.values()):
        node_id = f"mailbox:{record.id}"
        add_node(
            {
                "id": node_id,
                "entity_id": record.id,
                "kind": "mailbox",
                "label": record.request_type or record.kind or "mailbox",
                "title": record.request_type or record.kind or "Mailbox",
                "detail": _compact(record.content, 220),
                "status": record.status,
                "badge": "reply" if record.requires_reply else record.kind,
                "x": 72 + (index % 5) * 145,
                "y": 540 + (index // 5) * 48,
                "sender_id": record.sender_id,
                "recipient_ids": record.recipient_ids,
                "topic": getattr(record, "topic", ""),
                "event_type": getattr(record, "event_type", ""),
                "request_type": record.request_type,
                "correlation_id": record.correlation_id,
                "lineage_id": getattr(record, "lineage_id", None),
                "reply_to_envelope_id": record.reply_to_envelope_id,
                "caused_by_envelope_id": getattr(record, "caused_by_envelope_id", None),
                "blocking_task_id": record.blocking_task_id,
                "escalated_at": getattr(record, "escalated_at", None),
            },
            rank=90 + index,
        )
        sender = f"agent:{record.sender_id}" if record.sender_id in session.agents else "session"
        _add_edge(edges, sender, node_id, "sent", topic=getattr(record, "topic", ""), event_type=getattr(record, "event_type", ""))
        for recipient_id in record.recipient_ids:
            if recipient_id not in session.agents:
                continue
            _add_edge(
                edges,
                node_id,
                f"agent:{recipient_id}",
                "delivered_to",
                pulse=record.requires_reply,
                status=record.status,
                topic=getattr(record, "topic", ""),
                event_type=getattr(record, "event_type", ""),
                lineage_id=getattr(record, "lineage_id", None),
                request_type=record.request_type,
                requires_reply=record.requires_reply,
                detail=_compact(record.content, 180),
            )
        if record.message_id in session.messages:
            _add_edge(edges, node_id, f"message:{record.message_id}", "materialized_as")
        if record.thread_id in session.threads:
            _add_edge(edges, node_id, f"thread:{record.thread_id}", "in_thread")
        if record.reply_to_envelope_id and record.reply_to_envelope_id in session.mailbox:
            _add_edge(edges, node_id, f"mailbox:{record.reply_to_envelope_id}", "replied_to")
        if record.caused_by_envelope_id and record.caused_by_envelope_id in session.mailbox:
            _add_edge(edges, node_id, f"mailbox:{record.caused_by_envelope_id}", "caused_by")
        if record.blocking_task_id and record.blocking_task_id in session.tasks:
            _add_edge(edges, node_id, f"task:{record.blocking_task_id}", "blocks")

    for index, artifact in enumerate(_session_artifacts(session)):
        artifact_id = artifact["id"]
        add_node(
            {
                "id": artifact_id,
                "kind": "artifact",
                "label": _compact(artifact["value"], 70),
                "title": artifact["value"],
                "detail": artifact["value"],
                "status": "completed",
                "badge": artifact.get("kind", "artifact"),
                "x": 980,
                "y": 520 + index * 46,
                "source_task_id": artifact.get("source_task_id"),
                "source_agent_id": artifact.get("source_agent_id"),
            },
            rank=130 + index,
        )
        if artifact.get("source_task_id") in session.tasks:
            _add_edge(edges, f"task:{artifact['source_task_id']}", artifact_id, "produced")
        if artifact.get("source_agent_id") in session.agents:
            _add_edge(edges, f"agent:{artifact['source_agent_id']}", artifact_id, "produced")

    memory_index = 0
    memory = getattr(session, "shared_memory", {}) or {}
    if isinstance(memory, dict):
        for bucket, entries in memory.items():
            if not isinstance(entries, list):
                continue
            for entry in entries[-12:]:
                if not isinstance(entry, dict):
                    continue
                memory_id = f"memory:{bucket}:{memory_index}"
                memory_index += 1
                add_node(
                    {
                        "id": memory_id,
                        "kind": "memory",
                        "label": bucket,
                        "title": bucket,
                        "detail": _compact(entry.get("text", ""), 220),
                        "status": "completed",
                        "badge": bucket,
                        "x": 56 + (memory_index % 6) * 150,
                        "y": 24 + (memory_index // 6) * 50,
                        "source_task_id": entry.get("source_task_id"),
                        "author": entry.get("author"),
                    },
                    rank=140 + memory_index,
                )
                if entry.get("source_task_id") in session.tasks:
                    _add_edge(edges, f"task:{entry['source_task_id']}", memory_id, "uses_memory")
                if entry.get("author") in session.agents:
                    _add_edge(edges, f"agent:{entry['author']}", memory_id, "uses_memory")

    if getattr(session, "completion_decision", None):
        decision = session.completion_decision
        add_node(
            {
                "id": "decision:latest",
                "kind": "decision",
                "label": decision.get("next_action", "decision"),
                "title": decision.get("next_action", "Decision"),
                "detail": _compact(decision.get("reason", ""), 220),
                "status": "completed" if decision.get("ready_to_finish") else "pending",
                "badge": getattr(session, "stop_reason", "") or "latest",
                "x": 600,
                "y": 36,
            },
            rank=5,
        )
        _add_edge(edges, "session", "decision:latest", "has_decision")
        for blocker in decision.get("blocked", []) if isinstance(decision.get("blocked", []), list) else []:
            if blocker.get("id") in session.mailbox:
                _add_edge(edges, f"mailbox:{blocker['id']}", "decision:latest", "blocks")

    total_nodes = len(nodes)
    total_edges = len(edges)
    visible_ids = _focused_node_ids(nodes, node_rank, node_limit)
    visible_nodes = [node for node in nodes if node["id"] in visible_ids]
    visible_edges = [edge for edge in edges if edge.get("from") in visible_ids and edge.get("to") in visible_ids][:edge_limit]
    hidden_nodes = max(0, total_nodes - len(visible_nodes))
    hidden_edges = max(0, total_edges - len(visible_edges))
    node_kinds = Counter(node["kind"] for node in nodes)
    edge_kinds = Counter(edge["kind"] for edge in edges)
    visible_node_kinds = Counter(node["kind"] for node in visible_nodes)
    visible_edge_kinds = Counter(edge["kind"] for edge in visible_edges)

    return {
        "schema_version": "cowork.graph.v2",
        "generated_at": now_iso(),
        "nodes": visible_nodes,
        "edges": visible_edges,
        "stats": {
            "nodes": len(visible_nodes),
            "edges": len(visible_edges),
            "total_nodes": total_nodes,
            "total_edges": total_edges,
            "hidden_nodes": hidden_nodes,
            "hidden_edges": hidden_edges,
            "node_kinds": dict(sorted(visible_node_kinds.items())),
            "edge_kinds": dict(sorted(visible_edge_kinds.items())),
            "total_node_kinds": dict(sorted(node_kinds.items())),
            "total_edge_kinds": dict(sorted(edge_kinds.items())),
            "agents": visible_node_kinds.get("agent", 0),
            "total_agents": len(session.agents),
            "tasks": len(session.tasks),
            "threads": len(session.threads),
            "mailbox": len(session.mailbox),
            "artifacts": len(_session_artifacts(session)),
            "memory": sum(len(entries) for entries in (getattr(session, "shared_memory", {}) or {}).values() if isinstance(entries, list)),
            "communications": sum(1 for edge in visible_edges if edge.get("kind") in {"delivered_to", "sent"}),
        },
        "truncated": {
            "nodes": hidden_nodes > 0,
            "edges": hidden_edges > 0,
            "hidden_nodes": hidden_nodes,
            "hidden_edges": hidden_edges,
            "limits": {"nodes": node_limit, "edges": edge_limit},
        },
    }


def _focused_node_ids(nodes: list[dict[str, Any]], node_rank: dict[str, int], limit: int) -> set[str]:
    if len(nodes) <= limit:
        return {node["id"] for node in nodes}
    per_kind_limits = {
        "session": 1,
        "budget": 1,
        "decision": 2,
        "agent": 40,
        "task": 50,
        "thread": 18,
        "mailbox": 34,
        "message": 28,
        "artifact": 18,
        "memory": 18,
    }
    by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes:
        by_kind[str(node.get("kind") or "other")].append(node)
    selected: set[str] = set()
    for kind, items in by_kind.items():
        kind_limit = per_kind_limits.get(kind, 10)
        ordered = sorted(items, key=lambda node: node_rank.get(node["id"], 1000))
        selected.update(node["id"] for node in ordered[:kind_limit])
    if len(selected) > limit:
        ordered_selected = sorted((node for node in nodes if node["id"] in selected), key=lambda node: node_rank.get(node["id"], 1000))
        selected = {node["id"] for node in ordered_selected[:limit]}
    elif len(selected) < limit:
        for node in sorted(nodes, key=lambda item: node_rank.get(item["id"], 1000)):
            selected.add(node["id"])
            if len(selected) >= limit:
                break
    return selected


def _session_artifacts(session: CoworkSession) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for task in session.tasks.values():
        for value in _task_artifacts(task):
            key = (task.id, value)
            if key in seen:
                continue
            seen.add(key)
            artifacts.append(
                {
                    "id": f"artifact:{hashlib.sha1(f'{task.id}:{value}'.encode('utf-8')).hexdigest()[:12]}",
                    "value": value,
                    "kind": _artifact_kind(value),
                    "source_task_id": task.id,
                    "source_agent_id": task.assigned_agent_id,
                }
            )
    for value in getattr(session, "artifacts", []):
        text = str(value or "").strip()
        if not text or any(item["value"] == text for item in artifacts):
            continue
        artifacts.append(
            {
                "id": f"artifact:{hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]}",
                "value": text,
                "kind": _artifact_kind(text),
                "source_task_id": None,
                "source_agent_id": None,
            }
        )
    return artifacts


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
    """Return timeline trace cards derived from events, spans, and scheduler decisions."""

    trace: list[dict[str, Any]] = []
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
                "source": "event",
            }
        )
    for decision in getattr(session, "scheduler_decisions", [])[-limit:]:
        selected = decision.get("selected_agent_ids", [])
        reasons = {
            item.get("agent_id"): item.get("activation_reasons", [])
            for item in decision.get("candidate_scores", [])
            if isinstance(item, dict)
        }
        trace.append(
            {
                "id": decision.get("id"),
                "type": "scheduler.decision",
                "stage": "scheduler",
                "action": "Scheduler selected agents",
                "detail": decision.get("reason", ""),
                "actor_id": "scheduler",
                "actor_name": "Scheduler",
                "at": decision.get("created_at", ""),
                "status": "active" if selected else "skipped",
                "node_id": "session",
                "next_node_id": f"agent:{selected[0]}" if selected else "",
                "payload": {
                    **decision,
                    "readiness_scores": decision.get("candidate_scores", []),
                    "activation_reasons": reasons,
                    "budget_usage": getattr(session, "budget_usage", {}),
                },
                "source": "scheduler_decision",
            }
        )
    for span in getattr(session, "trace_spans", [])[-limit:]:
        payload = dict(getattr(span, "data", {}) or {})
        stage = getattr(span, "kind", "trace") or "trace"
        trace.append(
            {
                "id": span.id,
                "type": f"span.{stage}",
                "stage": stage,
                "action": span.name,
                "detail": span.summary or span.output_ref or span.input_ref,
                "actor_id": span.actor_id,
                "actor_name": session.agents.get(span.actor_id).name if span.actor_id in session.agents else span.actor_id,
                "at": span.ended_at or span.started_at,
                "status": span.status,
                "node_id": f"agent:{span.actor_id}" if span.actor_id in session.agents else "session",
                "next_node_id": f"task:{payload.get('task_id')}" if payload.get("task_id") in session.tasks else "",
                "payload": {
                    **payload,
                    "run_id": span.run_id,
                    "round_id": span.round_id,
                    "input_ref": span.input_ref,
                    "output_ref": span.output_ref,
                    "error": span.error,
                },
                "source": "trace_span",
            }
        )
    if getattr(session, "stop_reason", "") and not any(item.get("payload", {}).get("stop_reason") == session.stop_reason for item in trace):
        trace.append(
            {
                "id": f"stop:{session.id}:{session.stop_reason}",
                "type": "scheduler.stop",
                "stage": "scheduler",
                "action": "Stop reason",
                "detail": session.stop_reason.replace("_", " "),
                "actor_id": "scheduler",
                "actor_name": "Scheduler",
                "at": session.updated_at,
                "status": "blocked" if "budget" in session.stop_reason or "blocker" in session.stop_reason else "completed",
                "node_id": "session",
                "next_node_id": "",
                "payload": {"stop_reason": session.stop_reason, "budget_usage": getattr(session, "budget_usage", {})},
                "source": "derived",
            }
        )
    return sorted(trace, key=lambda item: str(item.get("at") or ""))[-limit:]


def build_cowork_task_dag(session: CoworkSession) -> dict[str, Any]:
    """Return a task-first DAG projection for observable Cowork planning."""

    nodes: list[dict[str, Any]] = [
        {
            "id": "goal",
            "kind": "goal",
            "label": session.title,
            "title": session.title,
            "detail": _compact(session.goal, 260),
            "status": session.status,
            "tone": _status_tone(session.status),
        }
    ]
    edges: list[dict[str, Any]] = []

    for task in session.tasks.values():
        nodes.append(
            {
                "id": f"task:{task.id}",
                "entity_id": task.id,
                "kind": "task",
                "label": task.title,
                "title": task.title,
                "detail": _compact(task.result_data.get("answer") or task.result or task.description, 260),
                "status": task.status,
                "tone": _status_tone(task.status),
                "owner": task.assigned_agent_id,
                "confidence": task.confidence,
                "updated_at": task.updated_at,
            }
        )
        if task.dependencies:
            for dependency in task.dependencies:
                if dependency in session.tasks:
                    _add_edge(edges, f"task:{dependency}", f"task:{task.id}", "depends_on")
                else:
                    _add_edge(edges, "goal", f"task:{task.id}", "root")
        else:
            _add_edge(edges, "goal", f"task:{task.id}", "root")
        if task.assigned_agent_id and task.assigned_agent_id in session.agents:
            agent = session.agents[task.assigned_agent_id]
            agent_node_id = f"agent:{agent.id}"
            if not any(node["id"] == agent_node_id for node in nodes):
                nodes.append(
                    {
                        "id": agent_node_id,
                        "entity_id": agent.id,
                        "kind": "agent",
                        "label": agent.name,
                        "title": agent.name,
                        "detail": _compact(agent.role, 120),
                        "status": agent.status,
                        "tone": _status_tone(agent.status),
                    }
                )
            _add_edge(edges, agent_node_id, f"task:{task.id}", "owns")
        for artifact in _task_artifacts(task):
            artifact_id = f"artifact:{hashlib.sha1(f'{task.id}:{artifact}'.encode('utf-8')).hexdigest()[:12]}"
            nodes.append(
                {
                    "id": artifact_id,
                    "kind": "artifact",
                    "label": _compact(artifact, 80),
                    "title": artifact,
                    "detail": artifact,
                    "status": "completed",
                    "tone": "completed",
                    "source_task_id": task.id,
                }
            )
            _add_edge(edges, f"task:{task.id}", artifact_id, "produced")

    for record in session.mailbox.values():
        if not record.requires_reply or record.status not in {"delivered", "read"}:
            continue
        blocked_task_id = record.blocking_task_id
        if not blocked_task_id or blocked_task_id not in session.tasks:
            continue
        blocker_id = f"blocker:{record.id}"
        nodes.append(
            {
                "id": blocker_id,
                "entity_id": record.id,
                "kind": "blocker",
                "label": record.request_type or "Reply needed",
                "title": record.request_type or "Reply needed",
                "detail": _compact(record.content, 220),
                "status": record.status,
                "tone": _status_tone(record.status),
                "sender_id": record.sender_id,
                "recipient_ids": record.recipient_ids,
            }
        )
        _add_edge(edges, blocker_id, f"task:{blocked_task_id}", "blocks")

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodes": len(nodes),
            "edges": len(edges),
            "tasks": len(session.tasks),
            "blocked_tasks": sum(1 for node in nodes if node.get("kind") == "blocker"),
            "artifacts": sum(1 for node in nodes if node.get("kind") == "artifact"),
        },
    }


def build_cowork_artifact_index(session: CoworkSession) -> list[dict[str, Any]]:
    """Return artifacts linked back to their source tasks and agents."""

    artifacts: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for task in session.tasks.values():
        for value in _task_artifacts(task):
            key = (task.id, value)
            if key in seen:
                continue
            seen.add(key)
            artifacts.append(
                {
                    "id": f"artifact_{len(artifacts) + 1}",
                    "kind": _artifact_kind(value),
                    "path_or_url": value,
                    "source_agent_id": task.assigned_agent_id,
                    "source_task_id": task.id,
                    "source_task_title": task.title,
                    "created_at": task.updated_at,
                    "summary": _compact(value, 160),
                    "confidence": task.confidence,
                }
            )
    for value in getattr(session, "artifacts", []):
        text = str(value or "").strip()
        if not text or any(item["path_or_url"] == text for item in artifacts):
            continue
        artifacts.append(
            {
                "id": f"artifact_{len(artifacts) + 1}",
                "kind": _artifact_kind(text),
                "path_or_url": text,
                "source_agent_id": None,
                "source_task_id": None,
                "source_task_title": "",
                "created_at": session.updated_at,
                "summary": _compact(text, 160),
                "confidence": None,
            }
        )
    return artifacts


def _task_artifacts(task: Any) -> list[str]:
    data = getattr(task, "result_data", {}) or {}
    values: list[Any] = []
    for key in ("artifacts", "artifact_paths", "generated_files", "files", "paths"):
        raw = data.get(key)
        if isinstance(raw, list):
            values.extend(raw)
        elif isinstance(raw, str):
            values.append(raw)
    return [str(value).strip() for value in values if str(value or "").strip()]


def _artifact_kind(value: str) -> str:
    text = value.lower()
    if text.startswith(("http://", "https://")):
        return "url"
    if text.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg")):
        return "image"
    if text.endswith((".csv", ".tsv", ".xlsx", ".xls")):
        return "table"
    if text.endswith((".patch", ".diff")):
        return "diff"
    return "file"
