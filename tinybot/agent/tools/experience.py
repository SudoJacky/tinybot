"""Experience tools: save and query problem-solving experiences."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import StringSchema, tool_parameters_schema

if TYPE_CHECKING:
    from tinybot.agent.experience import ExperienceStore


# ---------------------------------------------------------------------------
# save_experience - Agent主动保存经验
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        tool_name=StringSchema("The tool that had the issue (e.g., 'exec', 'edit_file')"),
        error_type=StringSchema(
            "The error type encountered (e.g., 'FileNotFoundError', 'PermissionError') - optional",
        ),
        error_message=StringSchema(
            "The error message encountered - optional",
        ),
        resolution=StringSchema(
            "How the problem was resolved - be specific and actionable",
        ),
        outcome=StringSchema(
            "The outcome: 'success', 'failure', or 'resolved'",
            enum=["success", "failure", "resolved"],
        ),
        required=["tool_name", "resolution"],
    )
)
class SaveExperienceTool(Tool):
    """Tool to save problem-solving experiences for self-evolution.

    Use this when you successfully resolve a tool error or find a reliable
    approach that might be useful in future similar situations.
    """

    def __init__(self, experience_store: ExperienceStore, session_key: str = ""):
        self._store = experience_store
        self._session_key = session_key

    @property
    def name(self) -> str:
        return "save_experience"

    @property
    def description(self) -> str:
        return (
            "Save a problem-solving experience for future reference. "
            "Use this when you successfully resolve a tool error or find a reliable approach. "
            "The saved experience will be available for query later."
        )

    async def execute(
        self,
        tool_name: str,
        error_type: str = "",
        error_message: str = "",
        resolution: str = "",
        outcome: str = "resolved",
    ) -> str:
        """Save the experience to the store."""
        if not resolution.strip():
            return "Error: resolution is required and cannot be empty"

        try:
            exp_id = self._store.append_experience(
                tool_name=tool_name,
                error_type=error_type or "",
                error_message=error_message or "",
                outcome=outcome,
                resolution=resolution,
                confidence=0.6 if outcome == "resolved" else 0.4,
                session_key=self._session_key,
            )
            return f"Experience saved: {exp_id} ({tool_name}/{error_type or 'general'})"
        except Exception as e:
            return f"Error saving experience: {e}"


# ---------------------------------------------------------------------------
# query_experience - Agent主动查询经验
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        tool_name=StringSchema("The tool to query experiences for (e.g., 'exec', 'edit_file')"),
        error_type=StringSchema(
            "The error type to search (optional, e.g., 'FileNotFoundError')",
        ),
        keywords=StringSchema(
            "Keywords to search in resolutions, comma-separated (optional, e.g., 'path,absolute')",
        ),
        outcome=StringSchema(
            "Filter by outcome: 'success', 'failure', 'resolved' (optional)",
            enum=["success", "failure", "resolved"],
        ),
        required=["tool_name"],
    )
)
class QueryExperienceTool(Tool):
    """Tool to query relevant problem-solving experiences.

    Call this when:
    - Encountering an error and need suggestions from past solutions
    - Before attempting a complex operation to recall successful approaches
    - To check if similar issues have been resolved before
    """

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "query_experience"

    @property
    def description(self) -> str:
        return (
            "Query relevant problem-solving experiences from past interactions. "
            "Returns successful patterns and resolved solutions. "
            "Call this when encountering an error or before complex operations."
        )

    async def execute(
        self,
        tool_name: str,
        error_type: str = "",
        keywords: str = "",
        outcome: str = "",
    ) -> str:
        """Query experiences and return relevant ones."""
        # Parse keywords
        keyword_list = [kw.strip() for kw in keywords.split(",") if kw.strip()] if keywords else None

        # Search experiences - outcome filter only if specified
        outcome_filter = outcome if outcome else None

        experiences = self._store.search_by_context(
            tool_name=tool_name,
            error_type=error_type if error_type else None,
            outcome=outcome_filter,
            keywords=keyword_list,
            min_confidence=0.3,  # Include lower confidence for context
            limit=10,
        )

        if not experiences:
            return f"No experiences found for tool '{tool_name}'"

        # Format results
        lines = [f"Found {len(experiences)} experiences for '{tool_name}':\n"]

        # Prioritize resolved > success > failure
        def sort_key(exp):
            if exp.outcome == "resolved":
                return (0, -exp.confidence)
            elif exp.outcome == "success":
                return (1, -exp.confidence)
            else:
                return (2, -exp.confidence)

        sorted_exps = sorted(experiences, key=sort_key)

        for exp in sorted_exps:
            status = exp.outcome
            error_label = exp.error_type or "general"
            conf = int(exp.confidence * 100)

            if exp.resolution:
                lines.append(f"  [{status}/{error_label}] {exp.resolution} ({conf}%)\n")
            else:
                lines.append(f"  [{status}/{error_label}] (no resolution yet) ({conf}%)\n")

        # Add helpful hint
        resolved_count = sum(1 for e in sorted_exps if e.outcome == "resolved" and e.resolution)
        if resolved_count > 0:
            lines.append(f"\n  {resolved_count} resolved experiences available. Consider applying similar approaches.")

        return "".join(lines)
