"""Agent tool for requesting WebUI Agent UI forms."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from tinybot.agent.forms import (
    FIELD_NAME_RE,
    RESERVED_FIELD_NAMES,
    AgentUiFormError,
    AgentUiFormRegistry,
    create_form_request,
)
from tinybot.agent.tools.base import AwaitingUserInputResult, Tool, tool_parameters
from tinybot.agent.tools.schema import StringSchema, tool_parameters_schema
from tinybot.bus.events import OutboundMessage


FORM_FIELD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["type", "label"],
    "properties": {
        "name": {
            "type": "string",
            "description": (
                "Use ASCII-style identifiers for submitted values, e.g. destination or travel_days. "
                "Do not put user-visible labels such as 目的地 here."
            ),
        },
        "id": {
            "type": "string",
            "description": (
                "Alias for name, accepted for UI-schema compatibility. Prefer name when possible; "
                "if both are present and name is not a safe ASCII identifier, id will be used as the field name."
            ),
        },
        "type": {
            "type": "string",
            "enum": [
                "text",
                "textarea",
                "number",
                "select",
                "multiselect",
                "checkbox",
                "radio",
                "date",
                "time",
                "datetime",
                "file_path",
            ],
            "description": "Field input type.",
        },
        "label": {
            "type": "string",
            "description": "User-visible field label. Localized text such as 目的地 belongs here.",
        },
        "required": {"type": "boolean", "description": "Whether the user must submit a value."},
        "placeholder": {"type": "string", "description": "Optional placeholder text."},
        "help": {"type": "string", "description": "Optional helper text shown near the field."},
        "min": {"type": "number", "description": "Minimum numeric value for number fields."},
        "max": {"type": "number", "description": "Maximum numeric value for number fields."},
        "min_length": {"type": "number", "description": "Minimum text length."},
        "max_length": {"type": "number", "description": "Maximum text length."},
        "pattern": {"type": "string", "description": "Optional regular expression pattern for text validation."},
        "options": {
            "type": "array",
            "description": "Required for select, multiselect, and radio fields.",
            "items": {
                "type": "object",
                "required": ["label", "value"],
                "properties": {
                    "label": {"type": "string", "description": "User-visible option label."},
                    "value": {"description": "Submitted option value."},
                },
                "additionalProperties": True,
            },
        },
        "default": {"description": "Optional default value matching the field type."},
    },
    "additionalProperties": True,
}

FORM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["form_id", "title", "fields"],
    "description": (
        "Agent UI form schema. Use this to collect structured information such as travel preferences, "
        "contact details, configuration choices, search filters, or other form-like data. "
        "Do not include HTML, scripts, CSS, component definitions, or renderer instructions."
    ),
    "properties": {
        "form_id": {
            "type": "string",
            "description": "Safe ASCII form identifier, e.g. travel_plan or project_settings.",
        },
        "title": {"type": "string", "description": "User-visible form title."},
        "description": {"type": "string", "description": "Optional user-visible form description."},
        "fields": {
            "type": "array",
            "description": "Bounded non-empty array of fields to collect from the user.",
            "items": FORM_FIELD_SCHEMA,
        },
        "initial_values": {"type": "object", "description": "Optional initial field values."},
        "metadata": {"type": "object", "description": "Optional JSON-safe metadata."},
        "expires_at": {"type": "string", "description": "Optional ISO timestamp after which the form expires."},
        "submit_label": {"type": "string", "description": "Optional submit button label."},
        "cancel_label": {"type": "string", "description": "Optional cancel button label."},
    },
    "additionalProperties": True,
}


def _is_safe_field_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        and FIELD_NAME_RE.fullmatch(value.strip()) is not None
        and value.strip() not in RESERVED_FIELD_NAMES
    )


def _normalize_field_aliases(fields: Any) -> Any:
    if not isinstance(fields, list):
        return fields

    normalized_fields: list[Any] = []
    for field in fields:
        if not isinstance(field, Mapping):
            normalized_fields.append(field)
            continue

        normalized = dict(field)
        raw_name = normalized.get("name")
        raw_id = normalized.get("id")
        if _is_safe_field_name(raw_id) and not _is_safe_field_name(raw_name):
            if isinstance(raw_name, str) and raw_name.strip() and not normalized.get("label"):
                normalized["label"] = raw_name.strip()
            normalized["name"] = raw_id.strip()
        normalized_fields.append(normalized)
    return normalized_fields


@tool_parameters(
    tool_parameters_schema(
        form=FORM_SCHEMA,
        continuation_mode=StringSchema(
            "How the form response should continue the conversation.",
            enum=["structured_message", "resume"],
        ),
        required=["form"],
    )
)
class FormRequestTool(Tool):
    """Request structured user input through the WebUI Agent UI form renderer."""

    def __init__(
        self,
        *,
        form_interactions: AgentUiFormRegistry,
        send_callback: Callable[[OutboundMessage], Awaitable[None]] | None = None,
        default_channel: str = "",
        default_chat_id: str = "",
        default_message_id: str | None = None,
    ) -> None:
        self._form_interactions = form_interactions
        self._send_callback = send_callback
        self._default_channel = default_channel
        self._default_chat_id = default_chat_id
        self._default_message_id = default_message_id

    @property
    def name(self) -> str:
        return "request_form"

    @property
    def description(self) -> str:
        return (
            "Request a fixed WebUI Agent UI form for structured, multi-field, or validation-sensitive user input. "
            "Use this tool actively when you need to collect information from the user, especially form-like inputs "
            "such as preferences, dates, numbers, choices, contact details, configuration values, or several related fields. "
            "Example uses: collect travel preferences, gather meeting details, ask for project settings, choose options, "
            "or validate required fields before continuing. "
            "Use normal assistant text for simple single-question clarification. "
            "The form response arrives asynchronously in a later continuation; this tool does not return submitted values. "
            "Forms collect data only and never approve tool operations."
        )

    @property
    def current_context(self) -> tuple[str, str, str | None]:
        return self._default_channel, self._default_chat_id, self._default_message_id

    def set_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        self._default_channel = channel
        self._default_chat_id = chat_id
        self._default_message_id = message_id

    def set_send_callback(self, callback: Callable[[OutboundMessage], Awaitable[None]]) -> None:
        self._send_callback = callback

    async def execute(
        self,
        form: Mapping[str, Any],
        continuation_mode: str = "structured_message",
        **kwargs: Any,
    ) -> str:
        channel = self._default_channel
        chat_id = self._default_chat_id
        message_id = self._default_message_id or ""
        if channel != "websocket" or not chat_id:
            return "Error: Agent UI forms require an active WebUI chat."
        if self._send_callback is None:
            return "Error: Agent UI form delivery is not configured."
        if not isinstance(form, Mapping):
            return "Error: form must be an object."

        schema = dict(form)
        schema["fields"] = _normalize_field_aliases(schema.get("fields"))
        correlation = schema.get("correlation") if isinstance(schema.get("correlation"), dict) else {}
        schema["correlation"] = {
            **dict(correlation),
            "session_key": f"{channel}:{chat_id}",
            "chat_id": chat_id,
            "message_id": message_id,
        }
        metadata = schema.get("metadata") if isinstance(schema.get("metadata"), dict) else {}
        schema["metadata"] = {
            **dict(metadata),
            "continuation_mode": continuation_mode,
        }
        form_id = schema.get("form_id")
        if isinstance(form_id, str):
            existing = self._form_interactions.get(form_id)
            if existing is not None and existing.status in {"pending", "validation_failed"}:
                return f"Error: Agent UI form `{form_id}` is already pending."

        try:
            interaction, event = create_form_request(
                self._form_interactions,
                schema,
                continuation={"mode": continuation_mode},
            )
        except AgentUiFormError as exc:
            detail = f": {exc.errors}" if exc.errors else ""
            return f"Error: Invalid Agent UI form schema: {exc}{detail}"

        message = OutboundMessage(
            channel=channel,
            chat_id=chat_id,
            content="",
            metadata={
                "_agent_ui_event": event["agent_ui_event"],
                "_agent_ui_form_id": interaction.form_id,
                "message_id": message_id,
            },
        )
        try:
            maybe_awaitable = self._send_callback(message)
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable
        except Exception as exc:
            return f"Error: Failed to emit Agent UI form event: {exc}"

        return AwaitingUserInputResult(
            f"Agent UI form `{interaction.form_id}` requested asynchronously for WebUI chat `{chat_id}`. "
            "Wait for the form response continuation instead of expecting values from this tool call.",
            stop_reason="awaiting_form",
        )
