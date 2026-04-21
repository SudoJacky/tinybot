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
        retry_policy = self.build_retry_policy(tool_name, error, experiences)
        return {
            "error_type": error_type,
            "primary_action": primary.action_hint or primary.resolution or "",
            "primary_experience_id": primary.id,
            "retry_policy": retry_policy,
            "experiences": experiences,
        }

    def build_retry_policy(
        self,
        tool_name: str,
        error: Exception | str,
        experiences: list["Experience"] | None = None,
    ) -> dict[str, Any] | None:
        """Build a structured retry policy from the top recovery experience."""
        error_type, error_message = self._parse_error(error)
        recoveries = experiences or self.suggest_recoveries(tool_name, error)
        if not recoveries:
            return None

        primary = recoveries[0]
        action_text = " ".join(
            part for part in (primary.action_hint, primary.applicability, primary.resolution) if part
        ).lower()
        fallback_tool = self._extract_tool_name(action_text, exclude=tool_name)

        action = "retry_with_adjustment"
        should_retry = True
        if any(token in action_text for token in ("switch tool", "fallback tool", "use list_dir", "use exec", "use read_file")):
            action = "switch_tool"
        elif any(token in action_text for token in ("do not retry", "stop", "manual intervention", "permission denied", "unsupported")):
            action = "stop_retry"
            should_retry = False

        if error_type == "PermissionError":
            action = "stop_retry"
            should_retry = False
        elif error_type in {"FileNotFoundError", "ValueError", "TypeError"} and action != "switch_tool":
            action = "retry_with_adjustment"
            should_retry = True

        return {
            "action": action,
            "should_retry": should_retry,
            "tool_name": tool_name,
            "fallback_tool": fallback_tool,
            "parameter_adjustment": primary.action_hint or primary.resolution,
            "reason": primary.applicability or error_message or primary.resolution,
            "experience_id": primary.id,
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

    def format_retry_policy(self, policy: dict[str, Any]) -> str:
        """Format a structured retry policy for agent consumption."""
        action = policy.get("action", "retry_with_adjustment")
        should_retry = "yes" if policy.get("should_retry", False) else "no"
        lines = [
            "[RETRY POLICY]",
            f"action={action}",
            f"should_retry={should_retry}",
        ]
        if policy.get("tool_name"):
            lines.append(f"tool={policy['tool_name']}")
        if policy.get("fallback_tool"):
            lines.append(f"fallback_tool={policy['fallback_tool']}")
        if policy.get("experience_id"):
            lines.append(f"experience_id={policy['experience_id']}")
        if policy.get("parameter_adjustment"):
            lines.append(f"parameter_adjustment={policy['parameter_adjustment']}")
        if policy.get("reason"):
            lines.append(f"reason={policy['reason']}")
        return "\n".join(lines)

    @staticmethod
    def _extract_tool_name(text: str, exclude: str = "") -> str:
        candidates = ["list_dir", "read_file", "write_file", "edit_file", "exec", "task", "query_experience"]
        for candidate in candidates:
            if candidate != exclude and candidate in text:
                return candidate
        return ""
