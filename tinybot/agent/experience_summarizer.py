"""Experience summarizer: generates experience records from complete conversations."""

from __future__ import annotations

import re
from typing import Any

from loguru import logger

from tinybot.agent.experience import ExperienceStore
from tinybot.providers.base import LLMProvider
from tinybot.utils.prompt_templates import render_template


class ExperienceSummarizer:
    """Summarize experiences from complete agent conversations.

    This runs after a conversation ends (no more tool calls) and uses LLM
    to extract valuable problem-solving experiences from the full dialogue.
    """

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
        """Analyze conversation and generate experience records.

        Args:
            messages: Complete conversation history (user/assistant/tool).
            tool_events: Tool execution status for locating failures.
            session_key: Session identifier.
            store: Experience store for saving records.

        Returns:
            Number of experiences added.
        """
        if not messages:
            return 0

        # Check if conversation has meaningful content
        has_failures = any(e.get("status") == "error" for e in tool_events)
        has_multiple_tools = len(tool_events) >= 3

        # Skip summarization for simple conversations
        if not has_failures and not has_multiple_tools:
            logger.debug("ExperienceSummarizer: skipping simple conversation")
            return 0

        # Format conversation for LLM
        conversation = self._format_messages(messages)
        events_text = self._format_events(tool_events)

        prompt = f"## 对话内容\n{conversation}\n\n## 工具执行状态\n{events_text}"

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

        # Parse LLM response
        context_summary, experiences = self._parse_summary(summary_text)

        if not experiences:
            logger.debug("ExperienceSummarizer: no experiences to record")
            return 0

        # Save experiences
        count = 0
        for exp in experiences:
            # Determine outcome based on error_type presence
            error_type = exp.get("error_type", "")
            if error_type and error_type != "success":
                outcome = "resolved"
            else:
                outcome = "success"

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
        """Format messages for LLM analysis."""
        lines: list[str] = []
        for msg in messages:
            role = msg.get("role", "")
            if role == "user":
                content = self._extract_text(msg.get("content", ""))
                if content:
                    lines.append(f"[用户] {content[:500]}")
            elif role == "assistant":
                content = self._extract_text(msg.get("content", ""))
                if content:
                    lines.append(f"[助手] {content[:300]}...")
                # Show tool calls
                tool_calls = msg.get("tool_calls", [])
                if tool_calls:
                    for tc in tool_calls:
                        name = tc.get("name", "unknown")
                        args = tc.get("arguments", {})
                        if isinstance(args, dict):
                            arg_hint = next(iter(args.values()), "") if args else ""
                            if isinstance(arg_hint, str) and len(arg_hint) > 40:
                                arg_hint = arg_hint[:40] + "..."
                            lines.append(f"[调用] {name}({arg_hint})")
                        else:
                            lines.append(f"[调用] {name}")
            elif role == "tool":
                name = msg.get("name", "unknown")
                content = self._extract_text(msg.get("content", ""))
                # Truncate tool results
                if len(content) > 200:
                    content = content[:200] + "..."
                lines.append(f"[结果:{name}] {content}")

        return "\n".join(lines)

    def _format_events(self, tool_events: list[dict[str, str]]) -> str:
        """Format tool events for LLM analysis."""
        if not tool_events:
            return "(无工具调用)"

        lines: list[str] = []
        for event in tool_events:
            name = event.get("name", "unknown")
            status = event.get("status", "unknown")
            detail = event.get("detail", "")[:100]
            lines.append(f"- {name}: {status} ({detail})")

        return "\n".join(lines)

    def _extract_text(self, content: Any) -> str:
        """Extract text from message content."""
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
        """Parse LLM summary response.

        Returns:
            (context_summary, list of experience dicts)
        """
        context_summary = ""
        experiences: list[dict[str, Any]] = []

        # Extract SUMMARY
        summary_match = re.search(r"SUMMARY:\s*(.+?)(?:\n---|\nEXPERIENCE:|\n$)", text, re.DOTALL)
        if summary_match:
            context_summary = summary_match.group(1).strip()

        # Check for SKIP
        if "SKIP:" in text:
            return context_summary, []

        # Extract EXPERIENCE blocks (updated pattern for category/tags)
        exp_pattern = r"EXPERIENCE:\s*\n(?:tool_name:\s*(.+?)\n)?(?:error_type:\s*(.+?)\n)?(?:category:\s*(.+?)\n)?(?:tags:\s*(.+?)\n)?(?:resolution:\s*(.+?)\n)?(?:confidence:\s*(.+?)\n)?"
        for match in re.finditer(exp_pattern, text, re.DOTALL):
            tool_name = match.group(1).strip() if match.group(1) else "general"
            error_type = match.group(2).strip() if match.group(2) else ""
            category = match.group(3).strip() if match.group(3) else "general"
            tags_str = match.group(4).strip() if match.group(4) else ""
            resolution = match.group(5).strip() if match.group(5) else ""
            confidence_str = match.group(6).strip() if match.group(6) else "0.7"

            # Parse tags
            tags = [t.strip() for t in tags_str.split(",") if t.strip()] if tags_str else []

            try:
                confidence = float(confidence_str)
            except ValueError:
                confidence = 0.7

            # Validate category
            valid_categories = ["path", "permission", "encoding", "network", "api", "config", "dependency", "general"]
            if category not in valid_categories:
                category = "general"

            # Only require resolution (tool_name can be "general")
            if resolution:
                experiences.append({
                    "tool_name": tool_name,
                    "error_type": error_type if error_type != "success" else "",
                    "category": category,
                    "tags": tags,
                    "resolution": resolution,
                    "confidence": min(1.0, max(0.3, confidence)),
                })

        return context_summary, experiences
