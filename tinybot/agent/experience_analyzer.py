"""Experience-based error analyzer: auto-diagnose failures and suggest recoveries."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from tinybot.agent.experience import Experience, ExperienceStore


class ErrorAnalyzer:
    """Analyze tool errors and suggest relevant recovery experiences."""

    ERROR_TYPE_ALIASES = {
        "FileNotFoundError": ["file not found", "path", "absolute path"],
        "PermissionError": ["permission", "access denied", "denied"],
        "TimeoutError": ["timeout", "timed out", "retry"],
        "ConnectionError": ["connection", "network", "retry"],
        "JSONDecodeError": ["json", "parse", "format"],
        "UnicodeDecodeError": ["encoding", "unicode", "utf"],
        "ValueError": ["value", "argument", "invalid"],
        "KeyError": ["key", "missing field", "missing"],
        "TypeError": ["type", "unexpected"],
    }

    def __init__(self, store: ExperienceStore):
        self.store = store

    def suggest_recoveries(
        self,
        tool_name: str,
        error: Exception | str,
        max_suggestions: int = 3,
        min_confidence: float = 0.4,
    ) -> list["Experience"]:
        """Return recovery experiences for a tool failure."""
        error_type, error_message = self._parse_error(error)
        query = self._build_search_query(tool_name, error_type, error_message)
        return self.store.search_recoveries(
            query=query,
            tool_name=tool_name,
            error_type=error_type,
            limit=max_suggestions,
            min_confidence=min_confidence,
        )

    def build_recovery_strategy(
        self,
        tool_name: str,
        error: Exception | str,
        max_suggestions: int = 3,
        min_confidence: float = 0.4,
    ) -> dict[str, Any] | None:
        """Return a compact recovery strategy with a primary action and references."""
        error_type, _ = self._parse_error(error)
        experiences = self.suggest_recoveries(
            tool_name=tool_name,
            error=error,
            max_suggestions=max_suggestions,
            min_confidence=min_confidence,
        )
        if not experiences:
            return None

        primary = experiences[0]
        return {
            "error_type": error_type,
            "primary_action": primary.action_hint or primary.resolution or "",
            "primary_experience_id": primary.id,
            "experiences": experiences,
        }

    def analyze_error(
        self,
        tool_name: str,
        error: Exception | str,
        max_suggestions: int = 3,
        min_confidence: float = 0.4,
    ) -> str | None:
        """Analyze error and return formatted suggestions."""
        error_type, _ = self._parse_error(error)
        strategy = self.build_recovery_strategy(
            tool_name=tool_name,
            error=error,
            max_suggestions=max_suggestions,
            min_confidence=min_confidence,
        )
        if not strategy:
            return None
        return self._format_suggestions(strategy["experiences"], error_type)

    def _parse_error(self, error: Exception | str) -> tuple[str, str]:
        if isinstance(error, Exception):
            return type(error).__name__, str(error)[:200]

        error_str = str(error)[:300]
        if ":" in error_str:
            error_type, error_message = error_str.split(":", 1)
            error_type = error_type.strip()
            for prefix in ("Error:", "Exception:", "Failed:", "failed:"):
                cleaned = prefix.rstrip(":")
                if error_type.startswith(cleaned):
                    error_type = error_type[len(cleaned):].strip()
            return error_type or "UnknownError", error_message.strip()[:200]

        return "UnknownError", error_str[:200]

    def _build_search_query(
        self,
        tool_name: str,
        error_type: str,
        error_message: str,
    ) -> str:
        parts: list[str] = []
        if tool_name:
            parts.append(f"tool {tool_name}")
        parts.append(f"error {error_type}")
        aliases = self.ERROR_TYPE_ALIASES.get(error_type, [])
        parts.extend(aliases[:2])
        parts.extend(self._extract_keywords(error_message)[:3])
        return " ".join(parts)

    def _extract_keywords(self, text: str) -> list[str]:
        important_keywords = [
            "path",
            "file",
            "directory",
            "permission",
            "access",
            "timeout",
            "connection",
            "encoding",
            "utf",
            "unicode",
            "parse",
            "json",
            "format",
            "not found",
            "invalid",
            "missing",
        ]

        found = []
        text_lower = text.lower()
        for kw in important_keywords:
            if kw in text_lower and kw not in found:
                found.append(kw)
        return found

    def _format_suggestions(
        self,
        experiences: list["Experience"],
        error_type: str,
    ) -> str:
        lines = [
            "---",
            f"[RECOVERY SUGGESTIONS for {error_type}]",
            "",
        ]

        for exp in experiences:
            conf = int(exp.confidence * 100)
            lines.append(
                f"- [{exp.id}] {exp.tool_name or 'general'} ({conf}% confidence)"
            )
            if exp.action_hint:
                lines.append(f"  Recommended action: {exp.action_hint}")
            if exp.applicability:
                lines.append(f"  Applies when: {exp.applicability}")
            if exp.resolution:
                lines.append(f"  Reference: {exp.resolution}")
            if exp.category:
                lines.append(f"  Category: {exp.category}")
            lines.append("")

        lines.append("Prefer the top recovery before retrying the same tool call.")
        lines.append("---")

        try:
            self.store.mark_used(experiences[0].id)
        except Exception:
            logger.warning("ErrorAnalyzer: failed to mark suggestion as used")

        return "\n".join(lines)
