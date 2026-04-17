import json
from functools import lru_cache
from math import ceil
from typing import Any

import tiktoken

# Cache size constants - increased for better model coverage
ENCODING_NAME_CACHE_SIZE = 128
ENCODER_CACHE_SIZE = 32

_MODEL_ENCODING_HINTS: tuple[tuple[str, str], ...] = (
    ("gpt-4.1", "o200k_base"),
    ("gpt-4o", "o200k_base"),
    ("gpt-5", "o200k_base"),
    ("o1", "o200k_base"),
    ("o3", "o200k_base"),
    ("o4", "o200k_base"),
    ("claude", "cl100k_base"),
    ("deepseek", "cl100k_base"),
    ("gemini", "cl100k_base"),
    ("glm", "cl100k_base"),
    ("qwen", "cl100k_base"),
    ("moonshot", "cl100k_base"),
    ("mistral", "cl100k_base"),
    ("minimax", "cl100k_base"),
)
_REASONING_MODEL_HINTS = (
    "reasoner",
    "reasoning",
    "deepseek-r1",
    "thinking",
    "flash-thinking",
    "o1",
    "o3",
    "o4",
)
_REASONING_RISK_MULTIPLIER = 1.12


@lru_cache(maxsize=ENCODING_NAME_CACHE_SIZE)
def _resolve_encoding_name(model: str | None) -> str:
    normalized = _normalize_model_name(model)
    candidates = [c for c in {
        str(model or "").strip(),
        normalized,
        normalized.split("/", 1)[-1] if normalized else "",
    } if c]

    for candidate in candidates:
        try:
            return tiktoken.encoding_for_model(candidate).name
        except Exception:
            continue

    for hint, encoding_name in _MODEL_ENCODING_HINTS:
        if hint in normalized:
            return encoding_name
    return "cl100k_base"


@lru_cache(maxsize=ENCODER_CACHE_SIZE)
def _get_encoder(encoding_name: str):
    return tiktoken.get_encoding(encoding_name)


def get_cache_stats() -> dict[str, dict[str, int]]:
    """Return cache statistics for token estimation.

    Returns:
        Dict with keys 'encoding_name' and 'encoder', each containing
        'size', 'maxsize', 'hits', 'misses'.
    """
    encoding_cache = _resolve_encoding_name.cache_info()
    encoder_cache = _get_encoder.cache_info()
    return {
        "encoding_name": {
            "size": encoding_cache.currsize,
            "maxsize": ENCODING_NAME_CACHE_SIZE,
            "hits": encoding_cache.hits,
            "misses": encoding_cache.misses,
        },
        "encoder": {
            "size": encoder_cache.currsize,
            "maxsize": ENCODER_CACHE_SIZE,
            "hits": encoder_cache.hits,
            "misses": encoder_cache.misses,
        },
    }


def clear_cache() -> None:
    """Clear all token estimation caches."""
    _resolve_encoding_name.cache_clear()
    _get_encoder.cache_clear()


def _normalize_model_name(model: str | None) -> str:
    return str(model or "").strip().lower()


def is_reasoning_model(model: str | None) -> bool:
    normalized = _normalize_model_name(model)
    if not normalized:
        return False
    return any(hint in normalized for hint in _REASONING_MODEL_HINTS)


def apply_reasoning_risk_buffer(tokens: int, model: str | None) -> int:
    if tokens <= 0:
        return 0
    if not is_reasoning_model(model):
        return tokens
    return max(tokens, ceil(tokens * _REASONING_RISK_MULTIPLIER))


def _tokenize_payload_length(payload: str, model: str | None) -> int:
    if not payload:
        return 0
    encoding_name = _resolve_encoding_name(model)
    encoder = _get_encoder(encoding_name)
    return len(encoder.encode(payload))


def _iter_message_parts(message: dict[str, Any]):
    content = message.get("content")
    if isinstance(content, str):
        if content:
            yield content
    elif isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text", "")
                if text:
                    yield text
            else:
                yield json.dumps(part, ensure_ascii=False)
    elif content is not None:
        yield json.dumps(content, ensure_ascii=False)

    for key in ("name", "tool_call_id"):
        value = message.get(key)
        if isinstance(value, str) and value:
            yield value

    tool_calls = message.get("tool_calls")
    if tool_calls:
        yield json.dumps(tool_calls, ensure_ascii=False)

    reasoning_content = message.get("reasoning_content")
    if isinstance(reasoning_content, str) and reasoning_content:
        yield reasoning_content


def _apply_calibration(tokens: int, calibration_factor: float = 1.0) -> int:
    if tokens <= 0:
        return 0
    if calibration_factor <= 0:
        calibration_factor = 1.0
    return max(1, ceil(tokens * calibration_factor))


def estimate_message_tokens(
    message: dict[str, Any],
    model: str | None = None,
) -> int:
    """Estimate prompt tokens contributed by one persisted message."""
    payload = "\n".join(_iter_message_parts(message))
    if not payload:
        return 4
    try:
        return max(4, _tokenize_payload_length(payload, model) + 4)
    except Exception:
        return max(4, len(payload) // 4 + 4)



def estimate_prompt_tokens(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    *,
    model: str | None = None,
    calibration_factor: float = 1.0,
) -> int:
    """Estimate prompt tokens with model-aware tokenizer selection.

    Counts all fields that providers send to the LLM: content, tool_calls,
    reasoning_content, tool_call_id, name, plus per-message framing overhead.
    """
    try:
        parts: list[str] = []
        for msg in messages:
            parts.extend(_iter_message_parts(msg))
        if tools:
            parts.append(json.dumps(tools, ensure_ascii=False))

        per_message_overhead = len(messages) * 4
        estimated = _tokenize_payload_length("\n".join(parts), model) + per_message_overhead
        return _apply_calibration(estimated, calibration_factor)
    except Exception:
        return 0



def estimate_prompt_tokens_chain(
    provider: Any,
    model: str | None,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> tuple[int, str]:
    """Estimate prompt tokens via provider counter first, then tokenizer fallback.

    The returned number is slightly risk-adjusted for reasoning-heavy models so
    context management can compress a bit earlier instead of waiting for a hard
    limit breach.
    """
    provider_counter = getattr(provider, "estimate_prompt_tokens", None)
    if callable(provider_counter):
        try:
            tokens, source = provider_counter(messages, tools, model)
            if isinstance(tokens, (int, float)) and tokens > 0:
                adjusted = apply_reasoning_risk_buffer(int(tokens), model)
                suffix = "+reasoning_buffer" if adjusted != int(tokens) else ""
                return adjusted, f"{source or 'provider_counter'}{suffix}"
        except Exception:
            pass

    estimated = estimate_prompt_tokens(messages, tools, model=model)
    if estimated > 0:
        adjusted = apply_reasoning_risk_buffer(int(estimated), model)
        suffix = "+reasoning_buffer" if adjusted != int(estimated) else ""
        return adjusted, f"tiktoken{suffix}"
    return 0, "none"
