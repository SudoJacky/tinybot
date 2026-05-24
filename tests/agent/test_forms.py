from datetime import UTC, datetime, timedelta

import pytest

from tinybot.agent.forms import (
    AgentUiFormError,
    AgentUiFormRegistry,
    create_form_request,
    validate_form_schema,
    validate_form_values,
)


def _schema(**overrides):
    schema = {
        "form_id": "travel-form-1",
        "title": "Travel preferences",
        "correlation": {
            "session_key": "websocket:chat-1",
            "chat_id": "chat-1",
            "run_id": "run-1",
            "message_id": "msg-1",
            "tool_call_id": "call-1",
            "parent_id": "parent-1",
        },
        "fields": [
            {"name": "destination", "type": "text", "label": "Destination", "required": True},
            {"name": "nights", "type": "number", "label": "Nights", "min": 1, "max": 30},
            {
                "name": "priority",
                "type": "select",
                "label": "Priority",
                "options": [{"label": "Normal", "value": "normal"}],
                "default": "normal",
            },
        ],
    }
    schema.update(overrides)
    return schema


def test_form_schema_rejects_unsafe_keys_and_invalid_defaults():
    with pytest.raises(AgentUiFormError, match="unsafe form key"):
        validate_form_schema({**_schema(), "html": "<script>alert(1)</script>"})

    with pytest.raises(AgentUiFormError, match="fields\\[1\\].default"):
        validate_form_schema(
            {
                **_schema(),
                "fields": [
                    {"name": "destination", "type": "text", "label": "Destination"},
                    {"name": "nights", "type": "number", "label": "Nights", "min": 1, "default": 0},
                ],
            }
        )

    with pytest.raises(AgentUiFormError, match="options"):
        validate_form_schema(
            {
                **_schema(),
                "fields": [{"name": "priority", "type": "select", "label": "Priority"}],
            }
        )


def test_form_values_validate_required_type_and_options():
    schema = validate_form_schema(_schema())

    with pytest.raises(AgentUiFormError) as exc_info:
        validate_form_values(schema, {"destination": "", "nights": 31, "priority": "other"})

    assert set(exc_info.value.errors) == {"destination", "nights", "priority"}
    assert (
        validate_form_values(
            schema,
            {"destination": "Shanghai", "nights": 3, "priority": "normal"},
        )["destination"]
        == "Shanghai"
    )


def test_create_form_request_preserves_correlation_and_display_metadata():
    registry = AgentUiFormRegistry()
    interaction, event = create_form_request(
        registry,
        _schema(metadata={"continuation_mode": "resume"}),
        interaction_id="interaction-1",
        continuation={"mode": "resume"},
    )

    assert interaction.continuation_mode == "resume"
    assert interaction.correlation["tool_call_id"] == "call-1"
    assert event["agent_ui_event"]["event_type"] == "ui.form.requested"
    assert event["agent_ui_event"]["payload"]["title"] == "Travel preferences"

    metadata = interaction.display_metadata()
    assert metadata["_agent_ui_form_id"] == "travel-form-1"
    assert metadata["_agent_ui_form_display"]["schema"]["fields"][0]["name"] == "destination"
    assert metadata["_agent_ui_form_display"]["correlation"]["interaction_id"] == "interaction-1"


def test_registry_expiry_and_submitted_display_metadata():
    registry = AgentUiFormRegistry()
    expires_at = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    expired = registry.create(_schema(form_id="expired-form", expires_at=expires_at))
    assert registry.get(expired.form_id).status == "expired"

    submitted = registry.create(_schema(form_id="submitted-form"))
    registry.submit(submitted.form_id, {"destination": "Shanghai", "nights": 2, "priority": "normal"})

    metadata = submitted.display_metadata()
    assert metadata["_agent_ui_form_status"] == "submitted"
    assert metadata["_agent_ui_form_display"]["values"]["destination"] == "Shanghai"
