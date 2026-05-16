# Providers

Providers isolate model-specific request and response handling behind one internal contract. The rest of Tinybot should work with normalized `LLMResponse` and `ToolCallRequest` objects instead of provider SDK payloads.

## Ownership

| Concern | Module |
| --- | --- |
| Provider interface and normalized response types | `tinybot/providers/base.py` |
| OpenAI-compatible provider implementation | `tinybot/providers/openai_provider.py` |
| Provider discovery and creation | `tinybot/providers/registry.py` |
| Transcription provider | `tinybot/providers/transcription.py` |
| Provider config schema | `tinybot/config/schema.py` |

## Design Intent

The provider layer absorbs API differences: message shape, tool call format, streaming chunks, usage fields, retries, rate-limit hints, reasoning content, image handling, and provider-specific quirks.

Agent code should not need to know whether a provider used a native OpenAI SDK, an OpenAI-compatible endpoint, or special fields for reasoning. Provider implementations normalize those differences before returning control to the runtime.

## Logical Flow

1. Config selects a provider profile and model.
2. The registry creates the provider with API key, base URL, and provider metadata.
3. The agent runtime sends normalized messages and tool schemas.
4. The provider adapts messages to the remote API.
5. The provider parses content, reasoning, tool calls, usage, retry hints, and finish reason into internal response types.
6. The agent runtime consumes the normalized response.

## Normalization Rules

- Provider-specific message keys should be removed or translated before remote calls.
- Empty assistant content with tool calls should be represented in a provider-safe way.
- Tool call IDs should be normalized so follow-up tool results can be matched.
- Streaming chunks should accumulate into the same final shape as non-streaming responses.
- Usage data should be best-effort and never required for correctness.
- Reasoning/thinking fields should be preserved separately from user-visible content.

## Boundaries

- Provider code should not execute tools.
- Provider code should not decide session policy.
- Provider code may retry transient remote errors, but user-facing stop decisions belong to the caller.
- Config resolution belongs to config/registry code, not individual call sites.

## Extension Checklist

- Add provider metadata to the registry.
- Implement chat and streaming behavior against the base contract.
- Normalize tool calls and usage.
- Add config schema fields only when necessary.
- Add provider tests for creation, parsing, error handling, and streaming if supported.

## Test Strategy

Use `tests/providers/` for registry and provider behavior. Add parser tests for real-world response shapes because provider regressions often appear as subtle tool-call or streaming mismatches.
