"""Persistent cowork session service."""

from __future__ import annotations

import json
import re
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path
from typing import Any

from loguru import logger

from tinybot.cowork.types import (
    CoworkAgent,
    CoworkEvent,
    CoworkMailboxRecord,
    CoworkMessage,
    CoworkSession,
    CoworkTask,
    CoworkThread,
    now_iso,
)


_MAX_PRIVATE_SUMMARY_CHARS = 6000
_MAX_EVENT_COUNT = 500
_MAX_MAILBOX_RECORDS = 300
_CONVERGENCE_IDLE_ROUNDS = 2
_SHARED_MEMORY_BUCKETS = ("findings", "claims", "risks", "open_questions", "decisions", "artifacts")
_WORKFLOW_MODES = {
    "hybrid",
    "supervisor",
    "orchestrator",
    "team",
    "generator_verifier",
    "message_bus",
    "shared_state",
    "peer_handoff",
}


class CoworkService:
    """Create, persist, and mutate cowork sessions."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.cowork_dir = workspace / "cowork"
        self._sessions: dict[str, CoworkSession] | None = None
        self._listeners: list[Callable[[CoworkSession, CoworkEvent], None]] = []

    @property
    def store_path(self) -> Path:
        return self.cowork_dir / "store.json"

    @staticmethod
    def normalize_workflow_mode(value: Any) -> str:
        mode = str(value or "hybrid").strip().lower().replace("-", "_")
        return mode if mode in _WORKFLOW_MODES else "hybrid"

    @staticmethod
    def workflow_profile(value: Any) -> str:
        mode = CoworkService.normalize_workflow_mode(value)
        if mode in {"supervisor", "orchestrator"}:
            return "orchestrator"
        return mode

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

    def _load(self) -> dict[str, CoworkSession]:
        if self._sessions is not None:
            return self._sessions
        if not self.store_path.exists():
            self._sessions = {}
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
                    workflow_mode=self.normalize_workflow_mode(raw.get("workflow_mode", "hybrid")),
                    current_focus_task=raw.get("current_focus_task", ""),
                    workspace_dir=raw.get("workspace_dir", ""),
                    artifacts=raw.get("artifacts", []) if isinstance(raw.get("artifacts", []), list) else [],
                    shared_memory=self._normalize_shared_memory(raw.get("shared_memory", {})),
                    shared_summary=raw.get("shared_summary", ""),
                    final_draft=raw.get("final_draft", ""),
                    completion_decision=raw.get("completion_decision", {}),
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
                sessions[session.id] = session
            self._sessions = sessions
        except Exception as exc:
            logger.warning("Failed to load cowork store: {}", exc)
            self._sessions = {}
        return self._sessions

    def _save(self) -> None:
        if self._sessions is None:
            return
        self._ensure_dir()
        data = {"version": 1, "sessions": [asdict(s) for s in self._sessions.values()]}
        fd, temp_path = tempfile.mkstemp(dir=self.cowork_dir, suffix=".json")
        try:
            with open(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, ensure_ascii=False)
            Path(temp_path).replace(self.store_path)
        except Exception:
            Path(temp_path).unlink(missing_ok=True)
            raise

    def list_sessions(self, include_completed: bool = False) -> list[CoworkSession]:
        sessions = list(self._load().values())
        if not include_completed:
            sessions = [s for s in sessions if s.status != "completed"]
        return sorted(sessions, key=lambda item: item.updated_at, reverse=True)

    def get_session(self, session_id: str) -> CoworkSession | None:
        return self._load().get(session_id)

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

    def create_session(
        self,
        goal: str,
        title: str,
        agents: list[dict[str, Any]],
        tasks: list[dict[str, Any]],
        *,
        workflow_mode: str = "hybrid",
    ) -> CoworkSession:
        sessions = self._load()
        session_id = self._new_id("cw")
        mode = self.normalize_workflow_mode(workflow_mode)
        session = CoworkSession(id=session_id, title=title.strip() or "Cowork Session", goal=goal, workflow_mode=mode)  # type: ignore[arg-type]
        session.shared_memory = self._normalize_shared_memory(session.shared_memory)
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
            )

        if not session.agents:
            for raw in self.default_team(goal):
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
            )

        if not session.tasks:
            first_agent = next(iter(session.agents))
            session.tasks["1"] = CoworkTask(
                id="1",
                title="Initial analysis",
                description=f"Analyze the goal and propose concrete next steps: {goal}",
                assigned_agent_id=first_agent,
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
            data={"goal": goal, "workflow_mode": session.workflow_mode, "focus_task": session.current_focus_task},
            save=False,
        )
        self.assess_session(session, save=False)
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
        )
        session.tasks[task_id] = task
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
        self.add_event(session, "task.created", message, data={"task_id": task.id, "assigned_agent_id": assigned_agent_id}, save=False)
        self._touch(session)
        if save:
            self._save()
        return task

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
        self._touch(session)
        if save:
            self._save()
        return f"Task '{task.title}' assigned to {agent.name}."

    def claim_task(self, session: CoworkSession, agent_id: str, task_id: str | None = None, *, save: bool = True) -> CoworkTask | str:
        agent_id = self._slug(agent_id)
        if agent_id not in session.agents:
            return f"Error: agent '{agent_id}' not found"
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
        if status == "completed":
            self._merge_task_artifacts(session, result_data)
            self.refresh_shared_memory(session, save=False)
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
        self.expire_mailbox_records(session, save=False)
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
            if agent.status in {"done", "failed"}:
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
            }
            for agent in session.agents.values()
            if agent.status not in {"done", "failed"}
        ]
        return sorted(scores, key=lambda item: item["score"], reverse=True)

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
            "ready_to_finish": next_action == "summarize",
            "no_progress_rounds": getattr(session, "no_progress_rounds", 0),
            "convergence_limit": _CONVERGENCE_IDLE_ROUNDS,
            "readiness": self.agent_readiness_scores(session)[:6],
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
        self._touch(session)
        self._save()

    def format_status(self, session: CoworkSession, *, verbose: bool = False) -> str:
        lines = [
            f"## {session.title} ({session.id})",
            f"Status: {session.status}",
            f"Mode: {session.workflow_mode}",
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
    def default_team(goal: str) -> list[dict[str, Any]]:
        return [
            {
                "id": "coordinator",
                "name": "Coordinator",
                "role": "Team coordinator",
                "goal": f"Keep the collaboration focused on: {goal}",
                "responsibilities": ["Break down work", "Route questions", "Synthesize final progress"],
                "tools": ["cowork_internal"],
                "subscriptions": ["coordination", "handoff", "unblock", "decision", "summary"],
            },
            {
                "id": "researcher",
                "name": "Researcher",
                "role": "Information gatherer",
                "goal": f"Gather useful facts and constraints for: {goal}",
                "responsibilities": ["Investigate relevant sources", "Summarize findings", "Flag uncertainty"],
                "tools": ["read_file", "list_dir", "cowork_internal"],
                "subscriptions": ["research", "produce", "finding", "source", "context"],
            },
            {
                "id": "analyst",
                "name": "Analyst",
                "role": "Reasoning and verification partner",
                "goal": f"Check assumptions and turn findings into decisions for: {goal}",
                "responsibilities": ["Compare options", "Verify claims", "Identify risks"],
                "tools": ["read_file", "list_dir", "cowork_internal"],
                "subscriptions": ["analysis", "review", "verify", "risk", "decision"],
            },
        ]

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
