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
    CoworkMessage,
    CoworkSession,
    CoworkTask,
    CoworkThread,
    now_iso,
)


_MAX_PRIVATE_SUMMARY_CHARS = 6000
_MAX_EVENT_COUNT = 500


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
                    shared_summary=raw.get("shared_summary", ""),
                    created_at=raw.get("created_at", now_iso()),
                    updated_at=raw.get("updated_at", now_iso()),
                    rounds=raw.get("rounds", 0),
                )
                session.agents = {
                    item["id"]: CoworkAgent(
                        id=item["id"],
                        name=item["name"],
                        role=item["role"],
                        goal=item["goal"],
                        responsibilities=item.get("responsibilities", []),
                        tools=item.get("tools", []),
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
                        assigned_agent_id=item["assigned_agent_id"],
                        dependencies=item.get("dependencies", []),
                        status=item.get("status", "pending"),
                        result=item.get("result"),
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

    def create_session(self, goal: str, title: str, agents: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> CoworkSession:
        sessions = self._load()
        session_id = self._new_id("cw")
        session = CoworkSession(id=session_id, title=title.strip() or "Cowork Session", goal=goal)
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
                communication_policy=str(raw.get("communication_policy") or "").strip()
                or "Coordinate through cowork messages when another agent can unblock or verify work.",
                context_policy=str(raw.get("context_policy") or "").strip()
                or "Keep a concise private summary and refer to artifacts or thread summaries instead of full logs.",
            )

        if not session.agents:
            for raw in self.default_team(goal):
                session.agents[raw["id"]] = CoworkAgent(**raw)

        for raw in tasks:
            assigned = self._slug(str(raw.get("assigned_agent_id") or ""))
            if assigned not in session.agents:
                assigned = next(iter(session.agents))
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
                assigned_agent_id=assigned,
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

        kickoff = self.create_thread(session, "Kickoff", list(session.agents), save=False)
        self.send_message(
            session,
            sender_id="user",
            recipient_ids=list(session.agents),
            content=f"Goal: {goal}",
            thread_id=kickoff.id,
            save=False,
        )
        self.add_event(session, "session.created", f"Created cowork session '{session.title}'", data={"goal": goal}, save=False)
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
                if agent.status == "idle":
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
        assigned_agent_id: str,
        dependencies: list[str] | None = None,
        *,
        save: bool = True,
    ) -> CoworkTask:
        if assigned_agent_id not in session.agents:
            assigned_agent_id = next(iter(session.agents))
        task_id = self._new_id("task")
        task = CoworkTask(
            id=task_id,
            title=title.strip() or "Untitled task",
            description=description.strip() or title,
            assigned_agent_id=assigned_agent_id,
            dependencies=dependencies or [],
        )
        session.tasks[task_id] = task
        agent = session.agents[assigned_agent_id]
        if agent.status == "idle":
            agent.status = "waiting"
        self.add_event(session, "task.created", f"Task '{task.title}' assigned to {agent.name}", data={"task_id": task.id}, save=False)
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
        task.status = status  # type: ignore[assignment]
        task.result = result
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
        agent.inbox.clear()
        return messages

    def ready_tasks_for(self, session: CoworkSession, agent_id: str) -> list[CoworkTask]:
        ready = []
        for task in session.tasks.values():
            if task.assigned_agent_id != agent_id or task.status != "pending":
                continue
            deps_done = all(
                session.tasks.get(dep_id) is not None and session.tasks[dep_id].status == "completed"
                for dep_id in task.dependencies
            )
            if deps_done:
                ready.append(task)
        return ready

    def select_active_agents(self, session: CoworkSession, limit: int = 3) -> list[CoworkAgent]:
        candidates = []
        if session.status != "active":
            return candidates
        for agent in session.agents.values():
            if agent.status in {"done", "failed"}:
                continue
            if agent.inbox or self.ready_tasks_for(session, agent.id):
                candidates.append(agent)
        return candidates[: max(1, limit)]

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
            f"Goal: {session.goal}",
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
            lines.append(f"- {task.id}: {task.title} -> {task.assigned_agent_id} [{task.status}]")
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
            },
            {
                "id": "researcher",
                "name": "Researcher",
                "role": "Information gatherer",
                "goal": f"Gather useful facts and constraints for: {goal}",
                "responsibilities": ["Investigate relevant sources", "Summarize findings", "Flag uncertainty"],
                "tools": ["read_file", "list_dir", "cowork_internal"],
            },
            {
                "id": "analyst",
                "name": "Analyst",
                "role": "Reasoning and verification partner",
                "goal": f"Check assumptions and turn findings into decisions for: {goal}",
                "responsibilities": ["Compare options", "Verify claims", "Identify risks"],
                "tools": ["read_file", "list_dir", "cowork_internal"],
            },
        ]

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

    def _touch(self, session: CoworkSession) -> None:
        session.updated_at = now_iso()

    def _update_completion_state(self, session: CoworkSession) -> None:
        if session.tasks and all(task.status in {"completed", "skipped"} for task in session.tasks.values()):
            session.status = "completed"
            for agent in session.agents.values():
                if agent.status not in {"failed", "blocked"}:
                    agent.status = "done"
