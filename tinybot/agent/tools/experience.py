"""Experience tools: save and query workflow / recovery experiences."""

from __future__ import annotations

from typing import TYPE_CHECKING

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import StringSchema, tool_parameters_schema

if TYPE_CHECKING:
    from tinybot.agent.experience import ExperienceStore


@tool_parameters(
    tool_parameters_schema(
        tool_name=StringSchema("Tool involved in the scenario, or 'general' for request-level workflows."),
        experience_type=StringSchema(
            "Type of experience to save.",
            enum=["workflow", "recovery", "reference"],
        ),
        trigger_stage=StringSchema(
            "When this experience should be applied.",
            enum=["before_plan", "before_tool", "on_error", "after_success", "general"],
        ),
        action_hint=StringSchema("Primary recommended action. Keep it short and imperative."),
        applicability=StringSchema("Conditions where this experience should be applied."),
        resolution=StringSchema("Reusable explanation or procedure."),
        error_type=StringSchema("Optional error type, for recovery experiences."),
        error_message=StringSchema("Optional error message, for recovery experiences."),
        outcome=StringSchema(
            "Outcome for the stored experience.",
            enum=["success", "failure", "resolved"],
        ),
        category=StringSchema("Optional category such as path, permission, config, dependency."),
        tags=StringSchema("Optional comma-separated tags."),
        context_summary=StringSchema("Optional request or scenario summary."),
        required=["tool_name", "experience_type", "trigger_stage", "action_hint"],
    )
)
class SaveExperienceTool(Tool):
    """Save a reusable workflow or recovery experience."""

    def __init__(self, experience_store: ExperienceStore, session_key: str = ""):
        self._store = experience_store
        self._session_key = session_key

    @property
    def name(self) -> str:
        return "save_experience"

    @property
    def description(self) -> str:
        return (
            "Save a reusable workflow or recovery experience. "
            "Use workflow for request-level handling patterns and recovery for tool-error fixes."
        )

    async def execute(
        self,
        tool_name: str,
        experience_type: str,
        trigger_stage: str,
        action_hint: str,
        applicability: str = "",
        resolution: str = "",
        error_type: str = "",
        error_message: str = "",
        outcome: str = "resolved",
        category: str = "",
        tags: str = "",
        context_summary: str = "",
    ) -> str:
        if not action_hint.strip():
            return "Error: action_hint is required and cannot be empty"

        try:
            exp_id = self._store.append_experience(
                tool_name=tool_name,
                error_type=error_type or "",
                error_message=error_message or "",
                outcome=outcome,
                resolution=resolution,
                context_summary=context_summary,
                confidence=0.7 if experience_type in {"workflow", "recovery"} else 0.6,
                session_key=self._session_key,
                category=category,
                tags=[tag.strip() for tag in tags.split(",") if tag.strip()],
                experience_type=experience_type,
                trigger_stage=trigger_stage,
                action_hint=action_hint,
                applicability=applicability,
            )
            return (
                f"Experience saved: {exp_id} "
                f"({experience_type}/{trigger_stage}/{tool_name}/{error_type or 'general'})"
            )
        except Exception as e:
            return f"Error saving experience: {e}"


@tool_parameters(
    tool_parameters_schema(
        keywords=StringSchema("Problem keywords or request description."),
        tool_name=StringSchema("Optional tool filter."),
        error_type=StringSchema("Optional error type filter."),
        outcome=StringSchema(
            "Optional outcome filter.",
            enum=["success", "failure", "resolved"],
        ),
        experience_type=StringSchema(
            "Optional experience type filter.",
            enum=["workflow", "recovery", "reference"],
        ),
        trigger_stage=StringSchema(
            "Optional trigger stage filter.",
            enum=["before_plan", "before_tool", "on_error", "after_success", "general"],
        ),
        required=["keywords"],
    )
)
class QueryExperienceTool(Tool):
    """Query reusable workflows or recovery experiences."""

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "query_experience"

    @property
    def description(self) -> str:
        return (
            "Query workflow and recovery experiences by request description or error keywords. "
            "Use workflow for reusable handling flows and recovery for tool-error fixes."
        )

    async def execute(
        self,
        keywords: str,
        tool_name: str = "",
        error_type: str = "",
        outcome: str = "",
        experience_type: str = "",
        trigger_stage: str = "",
    ) -> str:
        keyword_list = [kw.strip() for kw in keywords.split(",") if kw.strip()]
        if not keyword_list:
            return "Error: keywords are required for searching experiences"

        query_text = " ".join(keyword_list)
        experiences = self._store.search_semantic(
            query=query_text,
            tool_name=tool_name or None,
            outcome=outcome or None,
            experience_type=experience_type or None,
            trigger_stage=trigger_stage or None,
            min_confidence=0.3,
            limit=10,
        )

        if error_type:
            experiences = [exp for exp in experiences if exp.error_type == error_type]

        if not experiences:
            return f"No experiences found for keywords: '{keywords}'"

        for exp in experiences[:3]:
            self._store.mark_used(exp.id)

        def sort_key(exp):
            stage_rank = {
                "before_plan": 0,
                "on_error": 1,
                "before_tool": 2,
                "after_success": 3,
                "general": 4,
            }.get(exp.trigger_stage, 5)
            type_rank = {
                "workflow": 0,
                "recovery": 1,
                "reference": 2,
            }.get(exp.experience_type, 3)
            outcome_rank = {
                "resolved": 0,
                "success": 1,
                "failure": 2,
            }.get(exp.outcome, 3)
            return (type_rank, stage_rank, outcome_rank, -exp.confidence)

        sorted_exps = sorted(experiences, key=sort_key)
        lines = [f"Found {len(sorted_exps)} experiences matching '{keywords}':\n"]

        for exp in sorted_exps:
            conf = int(exp.confidence * 100)
            lines.append(
                f"  [{exp.id}] {exp.experience_type}/{exp.trigger_stage}/{exp.outcome}"
                f" ({conf}%)\n"
            )
            if exp.tool_name:
                lines.append(f"    Tool: {exp.tool_name}\n")
            if exp.context_summary:
                lines.append(f"    Context: {exp.context_summary}\n")
            if exp.action_hint:
                lines.append(f"    Recommended action: {exp.action_hint}\n")
            if exp.applicability:
                lines.append(f"    Applies when: {exp.applicability}\n")
            if exp.resolution:
                lines.append(f"    Reference: {exp.resolution}\n")
            if exp.tags:
                lines.append(f"    Tags: {', '.join(exp.tags)}\n")

        lines.append(
            "\nUse `feedback_experience` after trying a retrieved experience."
        )
        return "".join(lines)


@tool_parameters(
    tool_parameters_schema(
        exp_id=StringSchema("The experience ID from query results."),
        helpful=StringSchema(
            "Whether the experience was helpful.",
            enum=["yes", "no"],
        ),
        applied=StringSchema(
            "Whether the experience was explicitly applied in execution.",
            enum=["yes", "no"],
        ),
        required=["exp_id", "helpful"],
    )
)
class FeedbackExperienceTool(Tool):
    """Provide feedback on an experience."""

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "feedback_experience"

    @property
    def description(self) -> str:
        return (
            "Record whether a retrieved experience was helpful, and optionally whether it was applied."
        )

    async def execute(self, exp_id: str, helpful: str, applied: str = "no") -> str:
        delta = 0.1 if helpful == "yes" else -0.15
        updated = self._store.update_confidence(exp_id, delta, is_feedback=True)
        if not updated:
            return f"Error: experience '{exp_id}' not found"

        if applied == "yes":
            self._store.record_application(exp_id, succeeded=helpful == "yes")

        action = "boosted" if helpful == "yes" else "reduced"
        return f"Feedback recorded: {exp_id} confidence {action}"


@tool_parameters(
    tool_parameters_schema(
        exp_id=StringSchema("The experience ID to delete."),
        reason=StringSchema("Optional reason for deletion."),
        required=["exp_id"],
    )
)
class DeleteExperienceTool(Tool):
    """Delete an outdated or incorrect experience."""

    def __init__(self, experience_store: ExperienceStore):
        self._store = experience_store

    @property
    def name(self) -> str:
        return "delete_experience"

    @property
    def description(self) -> str:
        return "Delete an outdated or incorrect experience by ID."

    async def execute(self, exp_id: str, reason: str = "") -> str:
        if self._store.delete_experience(exp_id):
            msg = f"Experience {exp_id} deleted"
            if reason:
                msg += f" (reason: {reason})"
            return msg
        return f"Error: experience '{exp_id}' not found"
