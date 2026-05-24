"""Agent UI dynamic form schema and pending interaction helpers."""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any


AGENT_UI_FORM_EVENT_TYPES = {
    "requested": "ui.form.requested",
    "updated": "ui.form.updated",
    "submitted": "ui.form.submitted",
    "cancelled": "ui.form.cancelled",
    "expired": "ui.form.expired",
    "validation_failed": "ui.form.validation_failed",
}
AGENT_UI_FORM_FIELD_TYPES = {
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
}
AGENT_UI_FORM_STATUSES = {
    "pending",
    "submitted",
    "cancelled",
    "expired",
    "validation_failed",
}
AGENT_UI_FORM_CONTINUATION_MODES = {
    "structured_message",
    "resume",
}

CHOICE_FIELD_TYPES = {"select", "multiselect", "radio"}
STRING_FIELD_TYPES = {"text", "textarea", "date", "time", "datetime", "file_path"}
FORM_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
FIELD_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
RESERVED_FIELD_NAMES = {"__proto__", "constructor", "prototype"}
UNSAFE_FORM_KEYS = {
    "html",
    "innerHTML",
    "outerHTML",
    "script",
    "scripts",
    "style",
    "styles",
    "css",
    "dom",
    "rawDom",
    "component",
    "componentDefinition",
    "renderer",
    "renderers",
    "rendererRegistry",
    "registerRenderer",
    "runtimeRenderer",
    "template",
    "templates",
    "action",
    "actions",
    "handler",
    "handlers",
    "onChange",
    "onClick",
    "onSubmit",
    "onCancel",
    "onRender",
}
MAX_FORM_FIELDS = 50
MAX_FORM_OPTIONS = 100
MAX_FORM_TEXT_LENGTH = 2000


class AgentUiFormError(ValueError):
    """Raised when a form schema or submission is invalid."""

    def __init__(self, message: str, *, errors: Mapping[str, str] | None = None) -> None:
        super().__init__(message)
        self.errors = dict(errors or {})


def _is_plain_mapping(value: Any) -> bool:
    return isinstance(value, Mapping)


def _assert_json_safe(value: Any, path: str = "payload") -> None:
    if value is None or isinstance(value, str | int | float | bool):
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_json_safe(item, f"{path}[{index}]")
        return
    if _is_plain_mapping(value):
        for key, item in value.items():
            if not isinstance(key, str):
                raise AgentUiFormError(f"{path} contains a non-string key")
            if key in UNSAFE_FORM_KEYS:
                raise AgentUiFormError(f"unsafe form key: {path}.{key}")
            _assert_json_safe(item, f"{path}.{key}")
        return
    raise AgentUiFormError(f"{path} must be JSON-safe")


def _normalize_optional_string(value: Any, path: str, *, max_length: int = 512) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise AgentUiFormError(f"{path} must be a string")
    normalized = value.strip()
    if len(normalized) > max_length:
        raise AgentUiFormError(f"{path} is too long")
    return normalized


def _normalize_required_string(value: Any, path: str, *, max_length: int = 512) -> str:
    normalized = _normalize_optional_string(value, path, max_length=max_length)
    if not normalized:
        raise AgentUiFormError(f"{path} is required")
    return normalized


def _normalize_option(option: Any, path: str) -> dict[str, Any]:
    if not _is_plain_mapping(option):
        raise AgentUiFormError(f"{path} must be an object")
    label = _normalize_required_string(option.get("label"), f"{path}.label", max_length=256)
    value = option.get("value")
    if not isinstance(value, str | int | float | bool):
        raise AgentUiFormError(f"{path}.value must be a string, number, or boolean")
    return {"label": label, "value": value}


def _choice_value_matches(actual: Any, expected: Any) -> bool:
    if isinstance(actual, bool) or isinstance(expected, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual == expected
    if isinstance(actual, int | float) and isinstance(expected, int | float):
        return actual == expected
    return type(actual) is type(expected) and actual == expected


def _value_in_options(field: Mapping[str, Any], value: Any) -> bool:
    return any(_choice_value_matches(value, option["value"]) for option in field.get("options", []))


def _validate_value_against_field(field: Mapping[str, Any], value: Any, path: str) -> None:
    if value in (None, "") or (field.get("required") and field.get("type") == "multiselect" and value == []):
        if field.get("required"):
            raise AgentUiFormError(f"{path} is required")
        return

    field_type = field["type"]
    if field_type == "number":
        if not isinstance(value, int | float) or isinstance(value, bool):
            raise AgentUiFormError(f"{path} must be a finite number")
        if "min" in field and value < field["min"]:
            raise AgentUiFormError(f"{path} is below the minimum")
        if "max" in field and value > field["max"]:
            raise AgentUiFormError(f"{path} is above the maximum")
        return

    if field_type == "checkbox":
        if not isinstance(value, bool):
            raise AgentUiFormError(f"{path} must be a boolean")
        return

    if field_type == "multiselect":
        if not isinstance(value, list):
            raise AgentUiFormError(f"{path} must be an array")
        if any(not _value_in_options(field, item) for item in value):
            raise AgentUiFormError(f"{path} contains an unsupported option")
        return

    if field_type in CHOICE_FIELD_TYPES:
        if not _value_in_options(field, value):
            raise AgentUiFormError(f"{path} contains an unsupported option")
        return

    if field_type in STRING_FIELD_TYPES:
        if not isinstance(value, str):
            raise AgentUiFormError(f"{path} must be a string")
        if len(value) > MAX_FORM_TEXT_LENGTH:
            raise AgentUiFormError(f"{path} is too long")
        if "min_length" in field and len(value) < field["min_length"]:
            raise AgentUiFormError(f"{path} is shorter than the minimum length")
        if "max_length" in field and len(value) > field["max_length"]:
            raise AgentUiFormError(f"{path} is longer than the maximum length")
        if field.get("pattern") and re.fullmatch(str(field["pattern"]), value) is None:
            raise AgentUiFormError(f"{path} does not match the required pattern")


def _normalize_field(field: Any, index: int) -> dict[str, Any]:
    path = f"fields[{index}]"
    if not _is_plain_mapping(field):
        raise AgentUiFormError(f"{path} must be an object")
    name = _normalize_required_string(field.get("name"), f"{path}.name", max_length=64)
    if not FIELD_NAME_RE.fullmatch(name) or name in RESERVED_FIELD_NAMES:
        raise AgentUiFormError(f"{path}.name is unsafe")
    field_type = _normalize_required_string(field.get("type"), f"{path}.type", max_length=64)
    if field_type not in AGENT_UI_FORM_FIELD_TYPES:
        raise AgentUiFormError(f"{path}.type is unsupported")
    normalized: dict[str, Any] = {
        "name": name,
        "type": field_type,
        "label": _normalize_required_string(field.get("label"), f"{path}.label", max_length=256),
        "required": field.get("required") is True,
    }
    for key in ("placeholder", "help"):
        value = _normalize_optional_string(field.get(key), f"{path}.{key}", max_length=512)
        if value:
            normalized[key] = value
    for key in ("min", "max", "min_length", "max_length"):
        if key in field:
            value = field[key]
            if not isinstance(value, int | float) or isinstance(value, bool):
                raise AgentUiFormError(f"{path}.{key} must be a finite number")
            normalized[key] = value
    if "pattern" in field:
        pattern = _normalize_required_string(field.get("pattern"), f"{path}.pattern", max_length=256)
        re.compile(pattern)
        normalized["pattern"] = pattern
    if field_type in CHOICE_FIELD_TYPES:
        options = field.get("options")
        if not isinstance(options, list) or not options or len(options) > MAX_FORM_OPTIONS:
            raise AgentUiFormError(f"{path}.options must be a bounded non-empty array")
        normalized["options"] = [_normalize_option(option, f"{path}.options[{option_index}]") for option_index, option in enumerate(options)]
    elif "options" in field:
        raise AgentUiFormError(f"{path}.options is only allowed for choice fields")
    if "default" in field:
        _validate_value_against_field(normalized, field["default"], f"{path}.default")
        normalized["default"] = field["default"]
    return normalized


def validate_form_schema(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return a normalized safe form schema or raise ``AgentUiFormError``."""

    _assert_json_safe(payload)
    if not _is_plain_mapping(payload):
        raise AgentUiFormError("form payload must be an object")
    form_id = _normalize_required_string(payload.get("form_id"), "form_id", max_length=128)
    if not FORM_ID_RE.fullmatch(form_id):
        raise AgentUiFormError("form_id is unsafe")
    fields = payload.get("fields")
    if not isinstance(fields, list) or not fields or len(fields) > MAX_FORM_FIELDS:
        raise AgentUiFormError("fields must be a bounded non-empty array")
    normalized_fields = [_normalize_field(raw_field, index) for index, raw_field in enumerate(fields)]
    names: set[str] = set()
    for normalized_field in normalized_fields:
        if normalized_field["name"] in names:
            raise AgentUiFormError(f"field name is duplicated: {normalized_field['name']}")
        names.add(normalized_field["name"])
    correlation = payload.get("correlation")
    if not _is_plain_mapping(correlation):
        raise AgentUiFormError("correlation is required")
    _assert_json_safe(correlation, "correlation")
    normalized: dict[str, Any] = {
        "form_id": form_id,
        "title": _normalize_required_string(payload.get("title"), "title", max_length=256),
        "fields": normalized_fields,
        "correlation": {**dict(correlation), "form_id": correlation.get("form_id") or form_id},
    }
    for key in ("description", "submit_label", "cancel_label"):
        value = _normalize_optional_string(payload.get(key), key, max_length=1024)
        if value:
            normalized[key] = value
    if payload.get("expires_at") is not None:
        expires_at = _normalize_required_string(payload.get("expires_at"), "expires_at", max_length=128)
        try:
            datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AgentUiFormError("expires_at must be an ISO timestamp") from exc
        normalized["expires_at"] = expires_at
    if "initial_values" in payload:
        values = validate_form_values(normalized, payload["initial_values"])
        normalized["initial_values"] = values
    if "metadata" in payload:
        metadata = payload["metadata"]
        if not _is_plain_mapping(metadata):
            raise AgentUiFormError("metadata must be an object")
        normalized["metadata"] = dict(metadata)
    return normalized


def validate_form_values(schema: Mapping[str, Any], values: Mapping[str, Any]) -> dict[str, Any]:
    """Validate submitted values against a normalized form schema."""

    if not _is_plain_mapping(values):
        raise AgentUiFormError("form values must be an object", errors={"_form": "Form values must be an object."})
    errors: dict[str, str] = {}
    normalized_values = dict(values)
    for form_field in schema.get("fields", []):
        name = form_field["name"]
        try:
            _validate_value_against_field(form_field, normalized_values.get(name), f"values.{name}")
        except AgentUiFormError as exc:
            errors[name] = str(exc)
    if errors:
        raise AgentUiFormError("invalid form values", errors=errors)
    return normalized_values


def form_event(event_type: str, interaction: PendingFormInteraction, **payload: Any) -> dict[str, Any]:
    """Build a native Agent UI lifecycle event payload for WebUI responses."""

    return {
        "event": "agent_ui_event",
        "agent_ui_event": {
            "event_type": event_type,
            "chat_id": interaction.chat_id,
            "message_id": interaction.message_id,
            "run_id": interaction.run_id,
            "payload": {
                "form_id": interaction.form_id,
                "correlation": interaction.correlation,
                **payload,
            },
        },
    }


@dataclass(slots=True)
class PendingFormInteraction:
    interaction_id: str
    form_id: str
    schema: dict[str, Any]
    session_key: str = ""
    chat_id: str = ""
    run_id: str = ""
    message_id: str = ""
    status: str = "pending"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime | None = None
    continuation: dict[str, Any] = field(default_factory=dict)
    submitted_values: dict[str, Any] = field(default_factory=dict)
    validation_errors: dict[str, str] = field(default_factory=dict)
    correlation_data: dict[str, Any] = field(default_factory=dict)

    @property
    def correlation(self) -> dict[str, Any]:
        return {
            **self.correlation_data,
            "form_id": self.form_id,
            "interaction_id": self.interaction_id,
            "session_key": self.session_key,
            "chat_id": self.chat_id,
            "run_id": self.run_id,
            "message_id": self.message_id,
        }

    @property
    def continuation_mode(self) -> str:
        raw_mode = self.continuation.get("mode") or self.continuation.get("continuation_mode")
        if raw_mode is None:
            raw_mode = self.schema.get("metadata", {}).get("continuation_mode", "structured_message")
        mode = str(raw_mode)
        return mode if mode in AGENT_UI_FORM_CONTINUATION_MODES else "structured_message"

    def display_metadata(self) -> dict[str, Any]:
        values = self.submitted_values if self.status == "submitted" else {}
        if self.status == "validation_failed":
            values = self.submitted_values
        return {
            "_agent_ui_form_id": self.form_id,
            "_agent_ui_form_status": self.status,
            "_agent_ui_form_display": {
                "form_id": self.form_id,
                "schema": self.schema,
                "status": self.status,
                "correlation": self.correlation,
                "values": dict(values),
                "errors": dict(self.validation_errors),
                "created_at": self.created_at.isoformat(),
                "updated_at": self.updated_at.isoformat(),
                "expires_at": self.expires_at.isoformat() if self.expires_at else self.schema.get("expires_at", ""),
            },
        }


class AgentUiFormRegistry:
    """In-memory pending Agent UI form interactions for active WebUI sessions."""

    def __init__(self) -> None:
        self._forms: dict[str, PendingFormInteraction] = {}

    def create(
        self,
        schema: Mapping[str, Any],
        *,
        interaction_id: str | None = None,
        continuation: Mapping[str, Any] | None = None,
    ) -> PendingFormInteraction:
        normalized = validate_form_schema(schema)
        correlation = normalized.get("correlation", {})
        expires_at = None
        if normalized.get("expires_at"):
            expires_at = datetime.fromisoformat(normalized["expires_at"].replace("Z", "+00:00"))
        interaction = PendingFormInteraction(
            interaction_id=interaction_id or f"form-{uuid.uuid4().hex}",
            form_id=normalized["form_id"],
            schema=normalized,
            session_key=str(correlation.get("session_key") or ""),
            chat_id=str(correlation.get("chat_id") or ""),
            run_id=str(correlation.get("run_id") or ""),
            message_id=str(correlation.get("message_id") or ""),
            expires_at=expires_at,
            continuation=dict(continuation or {}),
            correlation_data=dict(correlation),
        )
        self._forms[interaction.form_id] = interaction
        return interaction

    def get(self, form_id: str) -> PendingFormInteraction | None:
        interaction = self._forms.get(form_id)
        if interaction is not None:
            self.expire_if_due(interaction)
        return interaction

    def expire_if_due(self, interaction: PendingFormInteraction) -> bool:
        if interaction.status in {"pending", "validation_failed"} and interaction.expires_at and datetime.now(UTC) >= interaction.expires_at:
            interaction.status = "expired"
            interaction.updated_at = datetime.now(UTC)
            return True
        return interaction.status == "expired"

    def submit(self, form_id: str, values: Mapping[str, Any]) -> PendingFormInteraction:
        interaction = self.get(form_id)
        if interaction is None:
            raise KeyError(form_id)
        if interaction.status not in {"pending", "validation_failed"}:
            raise AgentUiFormError(f"form is {interaction.status}", errors={"_form": f"Form is {interaction.status}."})
        try:
            normalized_values = validate_form_values(interaction.schema, values)
        except AgentUiFormError as exc:
            interaction.status = "validation_failed"
            interaction.validation_errors = exc.errors
            interaction.submitted_values = dict(values)
            interaction.updated_at = datetime.now(UTC)
            raise
        interaction.status = "submitted"
        interaction.submitted_values = normalized_values
        interaction.validation_errors = {}
        interaction.updated_at = datetime.now(UTC)
        return interaction

    def cancel(self, form_id: str) -> PendingFormInteraction:
        interaction = self.get(form_id)
        if interaction is None:
            raise KeyError(form_id)
        if interaction.status not in {"pending", "validation_failed"}:
            raise AgentUiFormError(f"form is {interaction.status}", errors={"_form": f"Form is {interaction.status}."})
        interaction.status = "cancelled"
        interaction.updated_at = datetime.now(UTC)
        return interaction


def create_form_request(
    registry: AgentUiFormRegistry,
    schema: Mapping[str, Any],
    *,
    interaction_id: str | None = None,
    continuation: Mapping[str, Any] | None = None,
) -> tuple[PendingFormInteraction, dict[str, Any]]:
    """Create a pending interaction and its native Agent UI form request event."""

    interaction = registry.create(schema, interaction_id=interaction_id, continuation=continuation)
    return interaction, form_event(
        AGENT_UI_FORM_EVENT_TYPES["requested"],
        interaction,
        **interaction.schema,
    )
