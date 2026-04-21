"""Experience summarizer: generates workflow and recovery experiences from conversations."""

from __future__ import annotations

import re
from typing import Any

from loguru import logger

from tinybot.agent.experience import ExperienceStore
from tinybot.providers.base import LLMProvider
from tinybot.utils.prompt_templates import render_template


class ExperienceSummarizer:
    """Summarize experiences from complete agent conversations."""

    def __init__(self, provider: LLMProvider, model: str):
        self.provider = provider
        self.model = model

    async def summarize_from_messages(
        self,
        messages: list[dict[str, Any]],
        tool_events: list[dict[str, str]],
        session_key: str,
        store: ExperienceStore,
    ) -> int:
        if not messages:
            return 0

        has_failures = any(e.get("status") == "error" for e in tool_events)
        has_multiple_tools = len(tool_events) >= 3
        if not has_failures and not has_multiple_tools:
            logger.debug("ExperienceSummarizer: skipping simple conversation")
            return 0

        conversation = self._format_messages(messages)
        events_text = self._format_events(tool_events)
        prompt = (
            f"## Conversation\n{conversation}\n\n"
            f"## Tool events\n{events_text}"
        )

        try:
            response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": render_template("agent/experience_summarize.md", strip=True),
                    },
                    {"role": "user", "content": prompt},
                ],
                tools=None,
                tool_choice=None,
            )
            summary_text = response.content or ""
        except Exception:
            logger.exception("ExperienceSummarizer: LLM call failed")
            return 0

        context_summary, experiences = self._parse_summary(summary_text)
        if not experiences:
            logger.debug("ExperienceSummarizer: no experiences to record")
            return 0

        count = 0
        for exp in experiences:
            error_type = exp.get("error_type", "")
            outcome = "resolved" if error_type and error_type != "success" else "success"
            store.append_experience(
                tool_name=exp.get("tool_name", "general"),
                error_type=error_type if error_type != "success" else "",
                outcome=outcome,
                resolution=exp.get("resolution", ""),
                context_summary=context_summary,
                confidence=exp.get("confidence", 0.7),
                session_key=session_key,
                category=exp.get("category", "general"),
                tags=exp.get("tags", []),
                experience_type=exp.get("experience_type", "reference"),
                trigger_stage=exp.get("trigger_stage", "general"),
                action_hint=exp.get("action_hint", ""),
                applicability=exp.get("applicability", ""),
                source="llm_summary",
            )
            count += 1

        if count > 0:
            logger.info(
                "ExperienceSummarizer: recorded {} experiences from conversation",
                count,
            )
            store.compact()

        return count

    def _format_messages(self, messages: list[dict[str, Any]]) -> str:
        lines: list[str] = []
        for msg in messages:
            role = msg.get("role", "")
            if role == "user":
                content = self._extract_text(msg.get("content", ""))
                if content:
                    lines.append(f"[user] {content[:500]}")
            elif role == "assistant":
                content = self._extract_text(msg.get("content", ""))
                if content:
                    lines.append(f"[assistant] {content[:300]}...")
                tool_calls = msg.get("tool_calls", [])
                for tc in tool_calls:
                    name = tc.get("name", "unknown")
                    args = tc.get("arguments", {})
                    if isinstance(args, dict):
                        arg_hint = next(iter(args.values()), "") if args else ""
                        if isinstance(arg_hint, str) and len(arg_hint) > 40:
                            arg_hint = arg_hint[:40] + "..."
                        lines.append(f"[tool_call] {name}({arg_hint})")
                    else:
                        lines.append(f"[tool_call] {name}")
            elif role == "tool":
                name = msg.get("name", "unknown")
                content = self._extract_text(msg.get("content", ""))
                if len(content) > 200:
                    content = content[:200] + "..."
                lines.append(f"[tool_result:{name}] {content}")
        return "\n".join(lines)

    def _format_events(self, tool_events: list[dict[str, str]]) -> str:
        if not tool_events:
            return "(no tool events)"

        lines: list[str] = []
        for event in tool_events:
            name = event.get("name", "unknown")
            status = event.get("status", "unknown")
            detail = event.get("detail", "")[:100]
            lines.append(f"- {name}: {status} ({detail})")
        return "\n".join(lines)

    def _extract_text(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    texts.append(part.get("text", ""))
            return " ".join(texts)
        return ""

    def _parse_summary(self, text: str) -> tuple[str, list[dict[str, Any]]]:
        context_summary = ""
        experiences: list[dict[str, Any]] = []

        summary_match = re.search(
            r"SUMMARY:\s*(.+?)(?:\n---|\nEXPERIENCE:|\nSKIP:|\n$)",
            text,
            re.DOTALL,
        )
        if summary_match:
            context_summary = summary_match.group(1).strip()

        if "SKIP:" in text:
            return context_summary, []

        exp_pattern = (
            r"EXPERIENCE:\s*\n"
            r"(?:experience_type:\s*(.+?)\n)?"
            r"(?:trigger_stage:\s*(.+?)\n)?"
            r"(?:tool_name:\s*(.+?)\n)?"
            r"(?:error_type:\s*(.+?)\n)?"
            r"(?:category:\s*(.+?)\n)?"
            r"(?:tags:\s*(.+?)\n)?"
            r"(?:action_hint:\s*(.+?)\n)?"
            r"(?:applicability:\s*(.+?)\n)?"
            r"(?:resolution:\s*(.+?)\n)?"
            r"(?:confidence:\s*(.+?)\n)?"
        )

        valid_types = {"workflow", "recovery", "reference"}
        valid_triggers = {
            "before_plan",
            "before_tool",
            "on_error",
            "after_success",
            "general",
        }
        valid_categories = {
            "path",
            "permission",
            "encoding",
            "network",
            "api",
            "config",
            "dependency",
            "general",
        }

        for match in re.finditer(exp_pattern, text, re.DOTALL):
            experience_type = match.group(1).strip() if match.group(1) else "reference"
            trigger_stage = match.group(2).strip() if match.group(2) else "general"
            tool_name = match.group(3).strip() if match.group(3) else "general"
            error_type = match.group(4).strip() if match.group(4) else ""
            category = match.group(5).strip() if match.group(5) else "general"
            tags_str = match.group(6).strip() if match.group(6) else ""
            action_hint = match.group(7).strip() if match.group(7) else ""
            applicability = match.group(8).strip() if match.group(8) else ""
            resolution = match.group(9).strip() if match.group(9) else ""
            confidence_str = match.group(10).strip() if match.group(10) else "0.7"

            tags = [t.strip() for t in tags_str.split(",") if t.strip()] if tags_str else []

            try:
                confidence = float(confidence_str)
            except ValueError:
                confidence = 0.7

            if experience_type not in valid_types:
                experience_type = "reference"
            if trigger_stage not in valid_triggers:
                trigger_stage = "general"
            if category not in valid_categories:
                category = "general"

            if resolution or action_hint:
                experiences.append(
                    {
                        "experience_type": experience_type,
                        "trigger_stage": trigger_stage,
                        "tool_name": tool_name,
                        "error_type": error_type if error_type != "success" else "",
                        "category": category,
                        "tags": tags,
                        "action_hint": action_hint,
                        "applicability": applicability,
                        "resolution": resolution,
                        "confidence": min(1.0, max(0.3, confidence)),
                    }
                )

        return context_summary, experiences
