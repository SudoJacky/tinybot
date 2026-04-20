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
        keywords=StringSchema(
            "Keywords describing the problem (comma-separated, e.g., 'path,absolute,not found') - primary search criteria",
        ),
        tool_name=StringSchema(
            "Optional: filter by specific tool (e.g., 'exec', 'read_file')",
        ),
        error_type=StringSchema(
            "Optional: filter by error type (e.g., 'FileNotFoundError')",
        ),
        outcome=StringSchema(
            "Optional: filter by outcome: 'success', 'failure', 'resolved'",
            enum=["success", "failure", "resolved"],
        ),
        required=["keywords"],
    )
)
class QueryExperienceTool(Tool):
    """Tool to query relevant problem-solving experiences.

    Call this when:
    - Encountering an error and need suggestions from past solutions
    - Before attempting a complex operation to recall successful approaches
    - To check if similar issues have been resolved before

    Search is based on problem keywords, not tied to specific tools.
    """

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "query_experience"

    @property
    def description(self) -> str:
        return (
            "Query problem-solving experiences by keywords. "
            "Search for solutions to similar problems across all tools. "
            "Use keywords that describe your problem (e.g., 'path not found', 'permission denied'). "
            "Call this when encountering an error or before complex operations."
        )

    async def execute(
        self,
        keywords: str,
        tool_name: str = "",
        error_type: str = "",
        outcome: str = "",
    ) -> str:
        """Query experiences and return relevant ones."""
        # Parse keywords (required)
        keyword_list = [kw.strip() for kw in keywords.split(",") if kw.strip()]
        if not keyword_list:
            return "Error: keywords are required for searching experiences"

        # Use semantic search with the full query text
        query_text = " ".join(keyword_list)
        experiences = self._store.search_semantic(
            query=query_text,
            tool_name=tool_name if tool_name else None,
            outcome=outcome if outcome else None,
            min_confidence=0.3,
            limit=10,
        )

        if not experiences:
            return f"No experiences found for keywords: '{keywords}'"

        # Mark top experiences as used
        for exp in experiences[:3]:
            self._store.mark_used(exp.id)

        # Format results - include exp_id for feedback
        lines = [f"Found {len(experiences)} experiences matching '{keywords}':\n"]

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
            tool_label = exp.tool_name or "general"
            conf = int(exp.confidence * 100)
            exp_id = exp.id
            category = exp.category or "general"

            # Show context summary + resolution with exp_id
            context = exp.context_summary or ""
            lines.append(f"  [{exp_id}] {status}/{tool_label}/{category} ({conf}%)\n")
            if context:
                lines.append(f"    问题: {context}\n")
            if exp.tags:
                lines.append(f"    标签: {', '.join(exp.tags)}\n")
            if exp.resolution:
                lines.append(f"    方案: {exp.resolution}\n")

        # Add helpful hint about feedback
        resolved_count = sum(1 for e in sorted_exps if e.outcome == "resolved" and e.resolution)
        if resolved_count > 0:
            lines.append(f"\n  {resolved_count} resolved experiences available.")
            lines.append("\n  If a solution helped, use `feedback_experience` with the exp_id.")
            lines.append("\n  If outdated/wrong, use `delete_experience` to remove it.")

        return "".join(lines)


# ---------------------------------------------------------------------------
# feedback_experience - 反馈经验是否有效
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        exp_id=StringSchema("The experience ID from query results (e.g., 'exp_abc123')"),
        helpful=StringSchema(
            "Whether this experience was helpful: 'yes' or 'no'",
            enum=["yes", "no"],
        ),
        required=["exp_id", "helpful"],
    )
)
class FeedbackExperienceTool(Tool):
    """Tool to provide feedback on an experience.

    Use this after trying a solution from query_experience:
    - 'yes': Solution worked - boosts confidence
    - 'no': Solution didn't help - reduces confidence
    """

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "feedback_experience"

    @property
    def description(self) -> str:
        return (
            "Provide feedback on whether an experience was helpful. "
            "Call this after trying a solution from query_experience. "
            "'yes' boosts confidence, 'no' reduces it. "
            "Helps the system learn which experiences are most valuable."
        )

    async def execute(self, exp_id: str, helpful: str) -> str:
        """Record feedback for an experience."""
        delta = 0.1 if helpful == "yes" else -0.15

        if self._store.update_confidence(exp_id, delta, is_feedback=True):
            action = "boosted" if helpful == "yes" else "reduced"
            return f"Feedback recorded: {exp_id} confidence {action}"
        return f"Error: experience '{exp_id}' not found"


# ---------------------------------------------------------------------------
# delete_experience - 删除过时或错误的经验
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        exp_id=StringSchema("The experience ID to delete (e.g., 'exp_abc123')"),
        reason=StringSchema(
            "Reason for deletion (e.g., 'outdated', 'incorrect', 'no longer relevant')",
        ),
        required=["exp_id"],
    )
)
class DeleteExperienceTool(Tool):
    """Tool to delete an outdated or incorrect experience.

    Use this when:
    - An experience is no longer relevant (outdated approach)
    - An experience contains incorrect information
    - An experience has very low confidence and should be removed
    """

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "delete_experience"

    @property
    def description(self) -> str:
        return (
            "Delete an outdated or incorrect experience. "
            "Use when a stored solution is no longer valid or contains errors. "
            "Provide the exp_id from query_experience results."
        )

    async def execute(self, exp_id: str, reason: str = "") -> str:
        """Delete an experience."""
        if self._store.delete_experience(exp_id):
            msg = f"Experience {exp_id} deleted"
            if reason:
                msg += f" (reason: {reason})"
            return msg
        return f"Error: experience '{exp_id}' not found"
