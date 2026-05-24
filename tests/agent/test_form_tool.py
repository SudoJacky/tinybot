import pytest

from tinybot.agent.forms import AgentUiFormRegistry
from tinybot.agent.tools.form import FormRequestTool


def _form_payload(**overrides):
    payload = {
        "form_id": "travel-form-1",
        "title": "Travel preferences",
        "fields": [
            {"name": "destination", "type": "text", "label": "Destination", "required": True},
            {"name": "nights", "type": "number", "label": "Nights", "min": 1, "max": 30},
        ],
    }
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_request_form_tool_emits_webui_form_event_and_returns_async_status():
    registry = AgentUiFormRegistry()
    sent = []

    async def send(message):
        sent.append(message)

    tool = FormRequestTool(form_interactions=registry, send_callback=send)
    tool.set_context("websocket", "chat-1", "msg-1")

    result = await tool.execute(form=_form_payload(), continuation_mode="resume")

    interaction = registry.get("travel-form-1")
    assert interaction is not None
    assert interaction.continuation_mode == "resume"
    assert interaction.chat_id == "chat-1"
    assert interaction.message_id == "msg-1"
    assert sent[0].channel == "websocket"
    assert sent[0].chat_id == "chat-1"
    assert sent[0].metadata["_agent_ui_event"]["event_type"] == "ui.form.requested"
    assert sent[0].metadata["_agent_ui_event"]["payload"]["form_id"] == "travel-form-1"
    assert "requested asynchronously" in result


@pytest.mark.asyncio
async def test_request_form_tool_rejects_invalid_schema_without_emitting_event():
    registry = AgentUiFormRegistry()
    sent = []

    async def send(message):
        sent.append(message)

    tool = FormRequestTool(form_interactions=registry, send_callback=send)
    tool.set_context("websocket", "chat-1", "msg-1")

    result = await tool.execute(form=_form_payload(fields=[{"name": "bad", "type": "slider", "label": "Bad"}]))

    assert result.startswith("Error:")
    assert "unsupported" in result
    assert registry.get("travel-form-1") is None
    assert sent == []


@pytest.mark.asyncio
async def test_request_form_tool_rejects_duplicate_pending_form_id_without_overwriting():
    registry = AgentUiFormRegistry()
    sent = []

    async def send(message):
        sent.append(message)

    tool = FormRequestTool(form_interactions=registry, send_callback=send)
    tool.set_context("websocket", "chat-1", "msg-1")
    first_result = await tool.execute(form=_form_payload(title="First request"))
    first_interaction = registry.get("travel-form-1")

    second_result = await tool.execute(form=_form_payload(title="Second request"))

    assert "requested asynchronously" in first_result
    assert second_result == "Error: Agent UI form `travel-form-1` is already pending."
    assert registry.get("travel-form-1") is first_interaction
    assert registry.get("travel-form-1").schema["title"] == "First request"
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_request_form_tool_rejects_non_webui_context():
    tool = FormRequestTool(form_interactions=AgentUiFormRegistry(), send_callback=lambda message: None)
    tool.set_context("cli", "chat-1", "msg-1")

    result = await tool.execute(form=_form_payload())

    assert result == "Error: Agent UI forms require an active WebUI chat."
