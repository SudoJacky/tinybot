# Channels and Message Bus

Channels connect external chat surfaces to the internal agent runtime. The message bus decouples platform polling/sending from agent execution so the gateway can host multiple channels without each adapter knowing the full runtime.

## Ownership

| Concern | Module |
| --- | --- |
| Inbound/outbound message records | `tinybot/bus/events.py` |
| Async queues and batching | `tinybot/bus/queue.py` |
| Channel interface | `tinybot/channels/base.py` |
| Channel discovery | `tinybot/channels/registry.py` |
| Channel lifecycle and outbound dispatch | `tinybot/channels/manager.py` |
| Built-in command routing | `tinybot/command/` |
| Web gateway channel | `tinybot/channels/websocket.py` |
| Platform adapters | `tinybot/channels/weixin.py`, `tinybot/channels/feishu.py`, `tinybot/channels/dingtalk.py` |

## Design Intent

Channels should translate platform-specific events into `InboundMessage` and translate `OutboundMessage` back to the platform. They should not own agent reasoning, task planning, or provider calls.

The bus provides backpressure and batching. The channel manager owns startup, shutdown, retries, stream delta coalescing, and status reporting.

## Logical Flow

1. A channel receives a platform message.
2. The channel checks allow-list policy and normalizes sender, chat, content, media, metadata, and optional session key.
3. The channel publishes an inbound message to the bus.
4. The gateway or agent consumer processes inbound messages into a session turn.
5. Agent output is published as outbound messages.
6. The manager dispatches outbound messages to the correct channel with retry/coalescing behavior.

## Command Routing

The command router handles built-in commands before normal agent execution when appropriate. Priority commands such as stop/approval flows can interrupt normal processing. Exact and prefix commands provide user-visible operational controls.

Keep command handlers small. They should inspect context, call the appropriate service, and return an outbound message.

## Streaming Contract

Channels that support streaming implement delta delivery. Stateful channels should key stream buffers by stream metadata rather than only chat id, because multiple responses may target the same chat over time.

Non-streaming channels receive completed messages. The channel manager can coalesce deltas when necessary.

## Boundaries

- Channel adapters own platform authentication and API quirks.
- The bus owns queueing, not business logic.
- The manager owns channel lifecycle and retries.
- Agent execution owns reasoning and tool use.
- Config owns channel enablement and allow-list settings.

## Extension Checklist

- Implement `BaseChannel`.
- Define default config for onboarding.
- Normalize inbound media and metadata.
- Support login if the platform requires interactive auth.
- Add allow-list behavior and tests.
- Add outbound send and optional streaming.
- Register or make the channel discoverable.

## Test Strategy

Use `tests/channels/` for adapter behavior and `tests/bus/` for queue behavior. For new platform channels, test allow-list handling, inbound normalization, send failure propagation, and stream support if implemented.
