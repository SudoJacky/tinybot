from __future__ import annotations

import base64
import mimetypes
import platform
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tinybot.utils.helper import current_time_str

from tinybot.agent.memory import MemoryStore
from tinybot.utils.prompt_templates import render_template
from tinybot.agent.skills import SkillsLoader
from tinybot.utils.helper import build_assistant_message
from tinybot.utils.media import detect_image_mime

if TYPE_CHECKING:
    from tinybot.agent.vector_store import VectorStore
    from tinybot.session.manager import SessionManager
    from tinybot.task.service import TaskManager


class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    _RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]"

    def __init__(
        self,
        workspace: Path,
        timezone: str | None = None,
        vector_store: VectorStore | None = None,
        task_manager: TaskManager | None = None,
        session_manager: SessionManager | None = None,
    ):
        self.workspace = workspace
        self.timezone = timezone
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)
        self.vector_store = vector_store
        self.task_manager = task_manager
        self.session_manager = session_manager

    def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
        """Build the system prompt from identity, bootstrap files, memory, and skills."""
        parts = [self._get_identity()]

        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)

        memory = self.memory.get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")

        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary()
        if skills_summary:
            parts.append(render_template("agent/skills_section.md", skills_summary=skills_summary))

        return "\n\n---\n\n".join(parts)

    def _get_identity(self) -> str:
        """Get the core identity section."""
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"

        return render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template("agent/platform_policy.md", system=system),
        )

    @staticmethod
    def _build_runtime_context(
        channel: str | None, chat_id: str | None, timezone: str | None = None,
        task_manager: TaskManager | None = None,
        user_profile: dict[str, Any] | None = None,
    ) -> str:
        """Build untrusted runtime metadata block for injection before the user message."""
        lines = [f"Current Time: {current_time_str(timezone)}"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]

        # Inject dynamic user profile (entity memory)
        if user_profile:
            profile_parts = []
            if name := user_profile.get("name"):
                profile_parts.append(f"Name: {name}")
            if prefs := user_profile.get("preferences"):
                profile_parts.append(f"Preferences: {', '.join(prefs)}")
            if entities := user_profile.get("mentioned_entities"):
                profile_parts.append(f"Known Entities: {', '.join(entities)}")
            if style := user_profile.get("communication_style"):
                profile_parts.append(f"Communication Style: {style}")
            if facts := user_profile.get("key_facts"):
                profile_parts.append(f"Key Facts: {', '.join(facts)}")
            if profile_parts:
                lines.append("User Context: " + "; ".join(profile_parts))

        # Add active task progress if any (support multiple plans)
        if task_manager:
            active_plans = task_manager.list_plans(include_completed=False)
            active_plans = [p for p in active_plans if p.status == "executing"]

            for plan in active_plans[:3]:  # Limit to 3 active plans
                progress = task_manager.get_progress(plan.id)
                if progress:
                    lines.append(f"Active Task: {plan.title}")
                    lines.append(f"Task Progress: {progress['completed']}/{progress['total']} completed, {progress['in_progress']} in progress")
                    if progress.get('current_all'):
                        lines.append(f"Current Steps: {', '.join(progress['current_all'])}")
                    elif progress.get('current'):
                        lines.append(f"Current Step: {progress['current']}")

        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines)

    @staticmethod
    def _merge_message_content(left: Any, right: Any) -> str | list[dict[str, Any]]:
        if isinstance(left, str) and isinstance(right, str):
            return f"{left}\n\n{right}" if left else right

        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [item if isinstance(item, dict) else {"type": "text", "text": str(item)} for item in value]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]

        return _to_blocks(left) + _to_blocks(right)

    def _load_bootstrap_files(self) -> str:
        """Load all bootstrap files from workspace."""
        parts = []

        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if file_path.exists():
                content = file_path.read_text(encoding="utf-8")
                parts.append(f"## {filename}\n\n{content}")

        return "\n\n".join(parts) if parts else ""

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        current_role: str = "user",
        user_profile: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Build the complete message list for an LLM call."""
        runtime_ctx = self._build_runtime_context(
            channel, chat_id, self.timezone, self.task_manager, user_profile,
        )
        user_content = self._build_user_content(current_message, media)

        # Merge runtime context and user content into a single user message
        # to avoid consecutive same-role messages that some providers reject.
        if isinstance(user_content, str):
            merged = f"{runtime_ctx}\n\n{user_content}"
        else:
            merged = [{"type": "text", "text": runtime_ctx}] + user_content

        messages = [
            {"role": "system", "content": self.build_system_prompt(skill_names)},
        ]

        # Inject memory context from ChromaDB: hierarchical retrieval
        if self.vector_store is not None and channel and chat_id:
            session_key = f"{channel}:{chat_id}"

            # Build richer search query from recent history + current message
            search_query = self._build_search_query(history, current_message)
            retrieval_limits = self._plan_vector_retrieval(history, current_message)

            try:
                # Hierarchical retrieval: summaries → their child chunks
                results = self.vector_store.search_with_hierarchy(
                    session_key,
                    search_query,
                    max_summaries=retrieval_limits["max_summaries"],
                    max_chunks_per_summary=retrieval_limits["max_chunks_per_summary"],
                    session_manager=self.session_manager,
                )
            except Exception:
                results = []


            if results:
                # search_with_hierarchy already deduplicates by ID;
                # the check below is defensive only.
                unique_results = results

                # Sort by boundary (chronological order) for coherence
                unique_results.sort(key=lambda x: x.get("boundary") or 0)

                # Build context parts with type and time-range labels
                context_parts: list[str] = []
                for item in unique_results:
                    if item["type"] == "summary":
                        boundary = item.get("boundary", 0)
                        context_parts.append(
                            f"[Summary (covers messages up to #{boundary})]\n{item['content']}"
                        )
                    else:
                        context_parts.append(
                            f"[Original conversation fragment]\n{item['content']}"
                        )

                if context_parts:
                    messages.append({
                        "role": "system",
                        "content": (
                            "---\n[RELEVANT PAST CONTEXT]\n\n"
                            + "\n\n---\n\n".join(context_parts)
                            + "\n---"
                        ),
                    })

        messages.extend(history)
        if messages[-1].get("role") == current_role:
            last = dict(messages[-1])
            last["content"] = self._merge_message_content(last.get("content"), merged)
            messages[-1] = last
            return messages
        messages.append({"role": current_role, "content": merged})
        return messages

    @staticmethod
    def _build_search_query(
        history: list[dict[str, Any]],  # from session.get_history(); contains role/content
        current_message: str,
        max_recent: int = 2,
    ) -> str:
        """Build a richer search query from recent user messages + current message.

        Truncates each message to avoid overly long embeddings that dilute
        semantic quality.
        """
        recent_user_msgs = [
            m.get("content", "")[:200] for m in history[-6:]
            if m.get("role") == "user" and isinstance(m.get("content"), str)
        ]
        recent_assistant_msgs = [
            m.get("content", "")[:160] for m in history[-4:]
            if m.get("role") == "assistant" and isinstance(m.get("content"), str)
        ]
        current_text = current_message[:500].strip()
        focus_lines = [
            line.strip(" -*0123456789.、")[:120]
            for line in current_message.splitlines()
            if line.strip()
        ]
        focus_lines = [line for line in focus_lines if len(line) >= 6][:3]

        parts: list[str] = []
        if recent_user_msgs:
            parts.append("Recent user context:\n" + "\n".join(recent_user_msgs[-max_recent:]))
        if recent_assistant_msgs and any(
            token in current_text.lower()
            for token in ("之前", "上次", "刚才", "继续", "回顾", "总结", "earlier", "previous", "continue")
        ):
            parts.append("Recent assistant context:\n" + "\n".join(recent_assistant_msgs[-1:]))
        if focus_lines:
            parts.append("Current focus:\n" + "\n".join(focus_lines))
        if current_text:
            parts.append("Current message:\n" + current_text)
        return "\n\n".join(p for p in parts if p.strip())

    @staticmethod
    def _plan_vector_retrieval(
        history: list[dict[str, Any]],
        current_message: str,
    ) -> dict[str, int]:
        """Choose retrieval depth dynamically from the current query complexity."""
        text = current_message.strip()
        complexity = 0
        if len(text) >= 120:
            complexity += 1
        if len(text) >= 260:
            complexity += 1
        if text.count("\n") >= 2 or any(
            marker in text
            for marker in ("1.", "2.", "- ", "* ", "、", "以及", "同时", "对比", "compare", "vs", "总结", "回顾")
        ):
            complexity += 1
        if sum(1 for item in history[-8:] if item.get("role") == "user") >= 4:
            complexity += 1

        max_summaries = min(4, 2 + complexity)
        max_chunks = 2 if complexity <= 1 else 3
        return {
            "max_summaries": max_summaries,
            "max_chunks_per_summary": max_chunks,
        }


    def _build_user_content(self, text: str, media: list[str] | None) -> str | list[dict[str, Any]]:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text

        images = []
        for path in media:
            p = Path(path)
            if not p.is_file():
                continue
            raw = p.read_bytes()
            # Detect real MIME type from magic bytes; fallback to filename guess
            mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
            if not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(raw).decode()
            images.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
                "_meta": {"path": str(p)},
            })

        if not images:
            return text
        return images + [{"type": "text", "text": text}]

    def add_tool_result(
        self, messages: list[dict[str, Any]],
        tool_call_id: str, tool_name: str, result: Any,
    ) -> list[dict[str, Any]]:
        """Add a tool result to the message list."""
        messages.append({"role": "tool", "tool_call_id": tool_call_id, "name": tool_name, "content": result})
        return messages

    def add_assistant_message(
        self, messages: list[dict[str, Any]],
        content: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        reasoning_content: str | None = None,
        thinking_blocks: list[dict] | None = None,
    ) -> list[dict[str, Any]]:
        """Add an assistant message to the message list."""
        messages.append(build_assistant_message(
            content,
            tool_calls=tool_calls,
            reasoning_content=reasoning_content,
            thinking_blocks=thinking_blocks,
        ))
        return messages
