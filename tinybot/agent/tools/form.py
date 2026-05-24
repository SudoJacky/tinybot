"""Agent tool for requesting WebUI Agent UI forms."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from tinybot.agent.forms import AgentUiFormError, AgentUiFormRegistry, create_form_request
from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import ObjectSchema, StringSchema, tool_parameters_schema
from tinybot.bus.events import OutboundMessage


@tool_parameters(
    tool_parameters_schema(
        form=ObjectSchema(
            description=(
                "Agent UI form schema with form_id, title, fields, and optional "
                "description, labels, initial_values, metadata, and expires_at. "
                "Do not include HTML, scripts, CSS, component definitions, or renderer instructions."
            ),
            additional_properties=True,
        ),
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

        return (
            f"Agent UI form `{interaction.form_id}` requested asynchronously for WebUI chat `{chat_id}`. "
            "Wait for the form response continuation instead of expecting values from this tool call."
        )
