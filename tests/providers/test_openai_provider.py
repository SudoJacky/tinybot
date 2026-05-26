"""Tests for OpenAI-compatible provider request kwargs."""

from types import SimpleNamespace
import shutil
import uuid
from pathlib import Path

import pytest

from tinybot.config.schema import (
    AgentDefaults,
    AgentsConfig,
    ApiConfig,
    ChannelsConfig,
    Config,
    GatewayConfig,
    ProviderConfig,
    ProvidersConfig,
    ToolsConfig,
)
from tinybot.providers.openai_provider import OpenAIProvider
from tinybot.providers.registry import create_provider, find_by_name


@pytest.fixture
def local_provider_workspace():
    path = Path("tests") / f"_tmp_provider_{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True, exist_ok=True)
    yield path
    shutil.rmtree(path, ignore_errors=True)


def test_build_kwargs_includes_enable_search_extra_body():
    provider = OpenAIProvider(
        api_key="test-key",
        api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model="qwen-plus",
        enable_search=True,
        spec=find_by_name("dashscope"),
    )

    kwargs = provider._build_kwargs(
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        model="qwen-plus",
        max_tokens=256,
        temperature=0.1,
        reasoning_effort=None,
        tool_choice=None,
    )

    assert kwargs["extra_body"]["enable_search"] is True


def test_create_provider_passes_enable_search_from_config(local_provider_workspace):
    config = Config(
        agents=AgentsConfig(
            defaults=AgentDefaults(
                workspace=str(local_provider_workspace),
                model="qwen-plus",
                provider="dashscope",
            )
        ),
        providers=ProvidersConfig(
            dashscope=ProviderConfig(
                api_key="test-key",
                enable_search=True,
            )
        ),
        channels=ChannelsConfig(),
        api=ApiConfig(),
        gateway=GatewayConfig(),
        tools=ToolsConfig(),
    )

    provider = create_provider(config)

    assert isinstance(provider, OpenAIProvider)
    assert provider.enable_search is True


class _AsyncStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._index >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._index]
        self._index += 1
        if isinstance(chunk, BaseException):
            raise chunk
        return chunk


class _FakeOpenAIClient:
    def __init__(self, chunks):
        self.kwargs = None
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self._chunks = chunks

    async def create(self, **kwargs):
        self.kwargs = kwargs
        return _AsyncStream(self._chunks)


def _chunk(*, tool_calls=None, content=None, reasoning_content=None, finish_reason=None, chunk_id="chatcmpl-1"):
    delta = SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls or [],
    )
    return SimpleNamespace(
        id=chunk_id,
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)],
        usage=None,
    )


def _tool_call_delta(*, index=0, call_id=None, name=None, arguments=""):
    return SimpleNamespace(
        index=index,
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


@pytest.mark.asyncio
async def test_chat_stream_emits_ordered_tool_call_argument_deltas():
    provider = OpenAIProvider(api_key="test-key")
    provider._client = _FakeOpenAIClient(
        [
            _chunk(tool_calls=[_tool_call_delta(call_id="call_1", name="send_message", arguments='{"content":"Hel')]),
            _chunk(tool_calls=[_tool_call_delta(arguments='lo"}')]),
            _chunk(finish_reason="tool_calls"),
        ]
    )
    deltas = []

    response = await provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        on_tool_call_delta=deltas.append,
    )

    assert [delta.sequence for delta in deltas] == [1, 2, 3]
    assert deltas[0].provider_call_id == "chatcmpl-1"
    assert deltas[0].tool_call_id == "call_1"
    assert deltas[0].tool_call_index == 0
    assert deltas[0].tool_name == "send_message"
    assert deltas[0].delta_text == '{"content":"Hel'
    assert deltas[1].delta_text == 'lo"}'
    assert deltas[-1].completed is True
    assert deltas[-1].status == "completed"
    assert response.tool_calls[0].name == "send_message"
    assert response.tool_calls[0].arguments == {"content": "Hello"}


@pytest.mark.asyncio
async def test_chat_stream_emits_tool_call_deltas_without_initial_tool_name():
    provider = OpenAIProvider(api_key="test-key")
    provider._client = _FakeOpenAIClient(
        [
            _chunk(tool_calls=[_tool_call_delta(call_id="call_1", arguments='{"content":"Hi"}')]),
            _chunk(tool_calls=[_tool_call_delta(name="send_message")]),
            _chunk(finish_reason="tool_calls"),
        ]
    )
    deltas = []

    await provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        on_tool_call_delta=deltas.append,
    )

    assert deltas[0].tool_name is None
    assert deltas[1].tool_name == "send_message"
    assert deltas[-1].completed is True


@pytest.mark.asyncio
async def test_chat_stream_splits_large_tool_call_argument_deltas():
    provider = OpenAIProvider(api_key="test-key")
    provider._client = _FakeOpenAIClient(
        [
            _chunk(tool_calls=[_tool_call_delta(call_id="call_1", name="send_message", arguments="x" * 9000)]),
            _chunk(finish_reason="tool_calls"),
        ]
    )
    deltas = []

    await provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        on_tool_call_delta=deltas.append,
    )

    argument_deltas = [delta for delta in deltas if delta.delta_text]
    assert len(argument_deltas) == 2
    assert "".join(delta.delta_text for delta in argument_deltas) == "x" * 9000
    assert all(len(delta.delta_text) <= 8192 for delta in argument_deltas)


@pytest.mark.asyncio
async def test_chat_stream_keeps_final_tool_calls_when_no_delta_callback_is_registered():
    provider = OpenAIProvider(api_key="test-key")
    provider._client = _FakeOpenAIClient(
        [
            _chunk(tool_calls=[_tool_call_delta(call_id="call_1", name="send_message", arguments='{"content":"Hi"}')]),
            _chunk(finish_reason="tool_calls"),
        ]
    )

    response = await provider.chat_stream(messages=[{"role": "user", "content": "hi"}])

    assert response.tool_calls[0].name == "send_message"
    assert response.tool_calls[0].arguments == {"content": "Hi"}


@pytest.mark.asyncio
async def test_chat_stream_returns_error_after_stream_interruption_with_prior_deltas_emitted():
    provider = OpenAIProvider(api_key="test-key")
    provider._client = _FakeOpenAIClient(
        [
            _chunk(tool_calls=[_tool_call_delta(call_id="call_1", name="send_message", arguments='{"content":"Hi')]),
            RuntimeError("connection dropped"),
        ]
    )
    deltas = []

    response = await provider.chat_stream(
        messages=[{"role": "user", "content": "hi"}],
        on_tool_call_delta=deltas.append,
    )

    assert [delta.delta_text for delta in deltas] == ['{"content":"Hi']
    assert response.finish_reason == "error"
