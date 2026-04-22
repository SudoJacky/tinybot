"""Tests for OpenAI-compatible provider request kwargs."""

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
