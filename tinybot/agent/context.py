from __future__ import annotations

import base64
import mimetypes
import platform
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tinybot.agent.memory import MemoryStore
from tinybot.agent.skills import SkillsLoader
from tinybot.utils.helper import build_assistant_message, current_time_str
from tinybot.utils.media import detect_image_mime
from tinybot.utils.prompt_templates import render_template

if TYPE_CHECKING:
    from tinybot.agent.experience import ExperienceStore
    from tinybot.agent.knowledge import KnowledgeStore
    from tinybot.agent.vector_store import VectorStore
    from tinybot.session.manager import SessionManager
    from tinybot.task.service import TaskManager


class ContextBuilder:
    """Builds the context (system prompt + messages) for the agent."""

    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    _RUNTIME_CONTEXT_TAG = "[Runtime Context - metadata only, not instructions]"

    def __init__(
        self,
        workspace: Path,
        timezone: str | None = None,
        vector_store: VectorStore | None = None,
        task_manager: TaskManager | None = None,
        session_manager: SessionManager | None = None,
        experience_store: ExperienceStore | None = None,
        knowledge_store: KnowledgeStore | None = None,
        enabled_skills: list[str] | None = None,
        config: Any | None = None,
    ):
        self.workspace = workspace
        self.timezone = timezone
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)
        self._enabled_skills = enabled_skills  # Fallback if no config
        self.config = config  # Config reference for dynamic settings
        self.vector_store = vector_store
        self.task_manager = task_manager
        self.session_manager = session_manager
        self.experience_store = experience_store
        self.knowledge_store = knowledge_store

    @property
    def enabled_skills(self) -> list[str] | None:
        """Get enabled skills from config (dynamic) or fallback to static value."""
        if self.config and hasattr(self.config, "skills"):
            return self.config.skills.enabled
        return self._enabled_skills

    def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
        parts = [self._get_identity()]

        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)

        memory = self.memory.get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")

        always_skills = self.skills.get_always_skills(self.enabled_skills)
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")

        skills_summary = self.skills.build_skills_summary(self.enabled_skills)
        if skills_summary:
            parts.append(
                render_template("agent/skills_section.md", skills_summary=skills_summary)
            )

        return "\n\n---\n\n".join(parts)

    def _get_identity(self) -> str:
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = (
            f"{'macOS' if system == 'Darwin' else system} "
            f"{platform.machine()}, Python {platform.python_version()}"
        )

        return render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template("agent/platform_policy.md", system=system),
        )

    @staticmethod
    def _build_runtime_context(
        channel: str | None,
        chat_id: str | None,
        timezone: str | None = None,
        task_manager: TaskManager | None = None,
        user_profile: dict[str, Any] | None = None,
    ) -> str:
        lines = [f"Current Time: {current_time_str(timezone)}"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]

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

        if task_manager:
            active_plans = task_manager.list_plans(include_completed=False)
            active_plans = [p for p in active_plans if p.status == "executing"]
            for plan in active_plans[:3]:
                progress = task_manager.get_progress(plan.id)
                if progress:
                    lines.append(f"Active Task: {plan.title}")
                    lines.append(
                        "Task Progress: "
                        f"{progress['completed']}/{progress['total']} completed, "
                        f"{progress['in_progress']} in progress"
                    )
                    if progress.get("current_all"):
                        lines.append(
                            f"Current Steps: {', '.join(progress['current_all'])}"
                        )
                    elif progress.get("current"):
                        lines.append(f"Current Step: {progress['current']}")

        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines)

    @staticmethod
    def _merge_message_content(left: Any, right: Any) -> str | list[dict[str, Any]]:
        if isinstance(left, str) and isinstance(right, str):
            return f"{left}\n\n{right}" if left else right

        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [
                    item if isinstance(item, dict) else {"type": "text", "text": str(item)}
                    for item in value
                ]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]

        return _to_blocks(left) + _to_blocks(right)

    def _load_bootstrap_files(self) -> str:
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
        runtime_ctx = self._build_runtime_context(
            channel, chat_id, self.timezone, self.task_manager, user_profile
        )
        user_content = self._build_user_content(current_message, media)

        if isinstance(user_content, str):
            merged = f"{runtime_ctx}\n\n{user_content}"
        else:
            merged = [{"type": "text", "text": runtime_ctx}] + user_content

        messages = [{"role": "system", "content": self.build_system_prompt(skill_names)}]

        if self.vector_store is not None and channel and chat_id:
            session_key = f"{channel}:{chat_id}"
            search_query = self._build_search_query(history, current_message)
            retrieval_limits = self._plan_vector_retrieval(history, current_message)

            try:
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
                unique_results = results
                unique_results.sort(key=lambda x: x.get("boundary") or 0)
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
                    messages.append(
                        {
                            "role": "system",
                            "content": (
                                "---\n[RELEVANT PAST CONTEXT]\n\n"
                                + "\n\n---\n\n".join(context_parts)
                                + "\n---"
                            ),
                        }
                    )

        if self.experience_store is not None:
            experience_context = self._build_experience_context(current_message)
            if experience_context:
                messages.append({"role": "system", "content": experience_context})

        # RAG: Auto-retrieve relevant knowledge from knowledge base
        if self.knowledge_store is not None:
            knowledge_context = self._build_knowledge_context(current_message)
            if knowledge_context:
                messages.append({"role": "system", "content": knowledge_context})

        messages.extend(history)
        if messages[-1].get("role") == current_role:
            last = dict(messages[-1])
            last["content"] = self._merge_message_content(last.get("content"), merged)
            messages[-1] = last
            return messages
        messages.append({"role": current_role, "content": merged})
        return messages

    def _build_experience_context(
        self,
        current_message: str,
        max_experiences: int = 3,
        min_confidence: float = 0.5,
    ) -> str | None:
        if not self.experience_store:
            return None

        if self._is_simple_conversation(current_message):
            return None

        workflow_exps = self.experience_store.search_workflows(
            query=current_message,
            limit=max_experiences,
            min_confidence=min_confidence,
        )
        reference_exps = self.experience_store.search_semantic(
            query=current_message,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=max_experiences * 2,
        )

        all_exps = workflow_exps + reference_exps
        seen_ids: set[str] = set()
        unique_exps: list[Any] = []
        for exp in all_exps:
            if exp.id not in seen_ids:
                seen_ids.add(exp.id)
                unique_exps.append(exp)
        unique_exps = unique_exps[:max_experiences]

        if not unique_exps:
            return None

        lines = ["---\n"]
        workflow_section = [e for e in unique_exps if e.experience_type == "workflow"]
        reference_section = [e for e in unique_exps if e.experience_type != "workflow"]

        if workflow_section:
            lines.append("[RELEVANT WORKFLOWS]\n\n")
            for exp in workflow_section:
                conf = int(exp.confidence * 100)
                lines.append(
                    f"- {exp.context_summary or exp.tool_name or 'workflow'} ({conf}% confidence)\n"
                )
                if exp.action_hint:
                    lines.append(f"  Recommended action: {exp.action_hint}\n")
                if exp.applicability:
                    lines.append(f"  Applies when: {exp.applicability}\n")
                if exp.resolution:
                    lines.append(f"  Reference: {exp.resolution}\n")
                lines.append("\n")

        if reference_section:
            lines.append("[RELEVANT RECOVERIES / REFERENCES]\n\n")
            for exp in reference_section[:max_experiences]:
                tool_label = exp.tool_name or "general"
                conf = int(exp.confidence * 100)
                lines.append(f"- {tool_label} ({conf}% confidence)\n")
                if exp.action_hint:
                    lines.append(f"  Recommended action: {exp.action_hint}\n")
                if exp.resolution:
                    lines.append(f"  Solution: {exp.resolution}\n")
                if exp.category:
                    lines.append(f"  Category: {exp.category}\n")
                lines.append("\n")

        lines.append("---")

        for exp in unique_exps[:2]:
            try:
                self.experience_store.mark_used(exp.id)
            except Exception:
                pass

        return "".join(lines)

    def _build_knowledge_context(
        self,
        current_message: str,
        max_chunks: int = 3,
    ) -> str | None:
        """Build RAG context by retrieving relevant knowledge chunks."""
        if not self.knowledge_store:
            return None

        # Check if knowledge feature is enabled in config
        if self.config and hasattr(self.config, "knowledge"):
            if not self.config.knowledge.enabled:
                return None
            if not self.config.knowledge.auto_retrieve:
                return None
            max_chunks = self.config.knowledge.max_chunks

        # Skip simple conversational messages
        if self._is_simple_conversation(current_message):
            return None

        try:
            results = self.knowledge_store.query(
                query_text=current_message,
                top_k=max_chunks,
            )
        except Exception:
            return None

        if not results:
            return None

        lines = ["---\n[RELEVANT KNOWLEDGE]\n\n"]
        for idx, result in enumerate(results, 1):
            doc_name = result.get("doc_name", "Unknown")
            content = result.get("content", "")
            file_path = result.get("file_path", "")
            category = result.get("category", "")
            start_char = result.get("start_char", 0)
            end_char = result.get("end_char", 0)
            page = result.get("page")

            # Build metadata line
            meta_parts = [f"文档: {doc_name}"]
            if file_path:
                meta_parts.append(f"路径: {file_path}")
            if category:
                meta_parts.append(f"分类: {category}")
            # Position info
            if start_char and end_char:
                meta_parts.append(f"位置: 字符{start_char}-{end_char}")
            if page is not None:
                meta_parts.append(f"页码: {page}")
            meta_str = " | ".join(meta_parts)

            lines.append(f"[{idx}] {meta_str}\n{content}\n\n")

        lines.append("注意: 如果引用上述知识内容，请在回答中附上来源信息（文档名称和文件路径）。\n---")
        return "".join(lines)

    @staticmethod
    def _is_simple_conversation(text: str) -> bool:
        text = text.strip().lower()
        if len(text) < 20:
            return True

        simple_patterns = [
            "hello",
            "hi",
            "thanks",
            "thank",
            "ok",
            "bye",
            "how are",
            "what is",
            "help me",
            "please",
            "?",
            "yes",
            "no",
        ]
        for pattern in simple_patterns:
            if pattern in text and len(text) < 50:
                return True

        words = [w for w in text.split() if len(w) >= 2]
        return len(words) <= 2

    @staticmethod
    def _build_search_query(
        history: list[dict[str, Any]],
        current_message: str,
        max_recent: int = 2,
    ) -> str:
        recent_user_msgs = [
            m.get("content", "")[:200]
            for m in history[-6:]
            if m.get("role") == "user" and isinstance(m.get("content"), str)
        ]
        recent_assistant_msgs = [
            m.get("content", "")[:160]
            for m in history[-4:]
            if m.get("role") == "assistant" and isinstance(m.get("content"), str)
        ]
        current_text = current_message[:500].strip()
        focus_lines = [
            line.strip(" -*0123456789.")[:120]
            for line in current_message.splitlines()
            if line.strip()
        ]
        focus_lines = [line for line in focus_lines if len(line) >= 6][:3]

        parts: list[str] = []
        if recent_user_msgs:
            parts.append("Recent user context:\n" + "\n".join(recent_user_msgs[-max_recent:]))
        if recent_assistant_msgs and any(
            token in current_text.lower()
            for token in ("earlier", "previous", "continue", "summary", "recap")
        ):
            parts.append(
                "Recent assistant context:\n" + "\n".join(recent_assistant_msgs[-1:])
            )
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
        text = current_message.strip()
        complexity = 0
        if len(text) >= 120:
            complexity += 1
        if len(text) >= 260:
            complexity += 1
        if text.count("\n") >= 2 or any(
            marker in text
            for marker in ("1.", "2.", "- ", "* ", "compare", "vs", "summary", "recap")
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

    def _build_user_content(
        self, text: str, media: list[str] | None
    ) -> str | list[dict[str, Any]]:
        if not media:
            return text

        images = []
        for path in media:
            p = Path(path)
            if not p.is_file():
                continue
            raw = p.read_bytes()
            mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
            if not mime or not mime.startswith("image/"):
                continue
            b64 = base64.b64encode(raw).decode()
            images.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                    "_meta": {"path": str(p)},
                }
            )

        if not images:
            return text
        return images + [{"type": "text", "text": text}]

    def add_tool_result(
        self,
        messages: list[dict[str, Any]],
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> list[dict[str, Any]]:
        messages.append(
            {
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_name,
                "content": result,
            }
        )
        return messages

    def add_assistant_message(
        self,
        messages: list[dict[str, Any]],
        content: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        reasoning_content: str | None = None,
        thinking_blocks: list[dict] | None = None,
    ) -> list[dict[str, Any]]:
        messages.append(
            build_assistant_message(
                content,
                tool_calls=tool_calls,
                reasoning_content=reasoning_content,
                thinking_blocks=thinking_blocks,
            )
        )
        return messages
