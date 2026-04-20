"""Experience-based error analyzer: auto-diagnose failures and suggest solutions."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from tinybot.agent.experience import ExperienceStore


class ErrorAnalyzer:
    """Analyze tool errors and automatically suggest relevant experiences.

    When a tool fails, this analyzer:
    1. Parses the error type and message
    2. Searches for similar resolved experiences
    3. Formats suggestions for injection into agent context

    This reduces the need for agents to manually call query_experience.
    """

    # Common error type mappings for better matching
    ERROR_TYPE_ALIASES = {
        "FileNotFoundError": ["file not found", "path", "不存在", "找不到"],
        "PermissionError": ["permission", "权限", "access denied", "denied"],
        "TimeoutError": ["timeout", "超时", "timed out"],
        "ConnectionError": ["connection", "连接", "network", "网络"],
        "JSONDecodeError": ["json", "parse", "解析", "format", "格式"],
        "UnicodeDecodeError": ["encoding", "编码", "unicode", "utf"],
        "ValueError": ["value", "参数", "argument", "invalid"],
        "KeyError": ["key", "字段", "missing", "缺失"],
        "TypeError": ["type", "类型", "unexpected"],
    }

    def __init__(self, store: ExperienceStore):
        self.store = store

    def analyze_error(
        self,
        tool_name: str,
        error: Exception | str,
        max_suggestions: int = 3,
        min_confidence: float = 0.4,
    ) -> str | None:
        """Analyze error and return formatted suggestions.

        Args:
            tool_name: The tool that failed.
            error: The exception or error message.
            max_suggestions: Maximum suggestions to return.
            min_confidence: Minimum confidence for suggestions.

        Returns:
            Formatted suggestion text or None if no relevant experiences.
        """
        # Parse error details
        error_type, error_message = self._parse_error(error)

        # Build search query
        query = self._build_search_query(tool_name, error_type, error_message)

        # Search for resolved experiences
        experiences = self.store.search_semantic(
            query=query,
            tool_name=tool_name,
            outcome="resolved",
            min_confidence=min_confidence,
            limit=max_suggestions,
        )

        if not experiences:
            # Fall back to general search without tool filter
            experiences = self.store.search_semantic(
                query=query,
                outcome="resolved",
                min_confidence=min_confidence,
                limit=max_suggestions,
            )

        if not experiences:
            return None

        # Format suggestions
        return self._format_suggestions(experiences, error_type)

    def _parse_error(self, error: Exception | str) -> tuple[str, str]:
        """Extract error type and message."""
        if isinstance(error, Exception):
            error_type = type(error).__name__
            error_message = str(error)[:200]
        else:
            error_str = str(error)[:300]
            # Try to extract error type from message
            if ":" in error_str:
                parts = error_str.split(":", 1)
                error_type = parts[0].strip()
                # Clean up error type (remove common prefixes)
                for prefix in ("Error:", "Exception:", "Failed:", "failed:"):
                    if error_type.endswith(prefix.rstrip(":")):
                        error_type = error_type.replace(prefix.rstrip(":"), "").strip()
                error_message = parts[1].strip()[:200]
            else:
                error_type = "UnknownError"
                error_message = error_str[:200]

        return error_type, error_message

    def _build_search_query(
        self,
        tool_name: str,
        error_type: str,
        error_message: str,
    ) -> str:
        """Build semantic search query from error details."""
        parts = []

        # Add tool name
        if tool_name:
            parts.append(f"工具: {tool_name}")

        # Add error type with aliases
        parts.append(f"错误: {error_type}")
        aliases = self.ERROR_TYPE_ALIASES.get(error_type, [])
        if aliases:
            parts.extend(aliases[:2])  # Add up to 2 aliases

        # Add key words from error message
        keywords = self._extract_keywords(error_message)
        if keywords:
            parts.extend(keywords[:3])

        return " ".join(parts)

    def _extract_keywords(self, text: str) -> list[str]:
        """Extract meaningful keywords from error message."""
        # Common error keywords to look for
        important_keywords = [
            "path", "路径", "file", "文件", "directory", "目录",
            "permission", "权限", "access", "访问",
            "timeout", "超时", "connection", "连接",
            "encoding", "编码", "utf", "unicode",
            "parse", "解析", "json", "format", "格式",
            "not found", "找不到", "不存在",
            "invalid", "无效", "missing", "缺失",
        ]

        found = []
        text_lower = text.lower()
        for kw in important_keywords:
            if kw in text_lower and kw not in found:
                found.append(kw)

        return found

    def _format_suggestions(
        self,
        experiences: list[Any],
        error_type: str,
    ) -> str:
        """Format experiences as suggestion block."""
        lines = [
            "---",
            f"[SIMILAR RESOLVED ERRORS — suggestions for {error_type}]\n",
        ]

        for exp in experiences:
            tool_label = exp.tool_name or "general"
            conf = int(exp.confidence * 100)

            lines.append(f"**{tool_label}** ({conf}% confidence)")
            if exp.resolution:
                lines.append(f"  Solution: {exp.resolution}")
            if exp.category:
                lines.append(f"  Category: {exp.category}")
            lines.append("")

        lines.append("Consider applying these solutions before retrying.")
        lines.append("---")

        # Mark top suggestion as used
        if experiences:
            try:
                self.store.mark_used(experiences[0].id)
            except Exception:
                pass

        return "\n".join(lines)
