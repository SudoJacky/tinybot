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
| Browser HTTP control routes | `tinybot/api/webui.py` |
| Platform adapters | `tinybot/channels/weixin.py`, `tinybot/channels/feishu.py`, `tinybot/channels/dingtalk.py` |

## Design Intent

Channels should translate platform-specific events into `InboundMessage` and translate `OutboundMessage` back to the platform. They should not own agent reasoning, task planning, provider calls, or browser HTTP control behavior.

`WebSocketChannel` is the browser transport adapter. It owns WebSocket admission, client subscription state, outbound serialization, stream deltas, active-token refresh, static WebUI serving, and mounting the WebUI control plane. Browser operations such as sessions, status, tools, approvals, workspace files, skills, config updates, provider model discovery, and Cowork HTTP controls live in `tinybot/api/webui.py` or the shared domain API modules it delegates to.

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

For the browser channel, `WebSocketChannel` emits legacy transport frames and should keep those outward shapes stable during the Agent UI event migration:

- `delta` and `stream_end` carry streamed assistant or reasoning content plus stream correlation metadata.
- `message` carries completed assistant/progress/tool/task messages and any memory or recent-context references needed by restored rendering.
- `approval_pending`, `browser_frame`, `usage`, `file_updated`, and `error` carry operational UI updates without becoming HTTP route handlers.
- `cowork_updated` remains a compatibility refresh signal for the Cowork console and is not part of the home-page Agent UI event protocol.

The browser converts those frames into internal Agent UI events before reducing and rendering them. That conversion belongs in `webui/assets/src/agent-ui-events.js`, not in channel internals. Native Agent UI event frames can be added later only if tests prove they coexist with the legacy frames.

## Boundaries

- Channel adapters own platform authentication and API quirks.
- The bus owns queueing, not business logic.
- The manager owns channel lifecycle and retries.
- Agent execution owns reasoning and tool use.
- Config owns channel enablement and allow-list settings.
- WebUI control owns browser HTTP request parsing, authorization, runtime dependency checks, and JSON response construction for browser control operations.
- WebUI Agent UI normalization, reducer state, and renderer registration own browser-side interpretation of WebSocket frames.

## Extension Checklist

- Implement `BaseChannel`.
- Define default config for onboarding.
- Normalize inbound media and metadata.
- Support login if the platform requires interactive auth.
- Add allow-list behavior and tests.
- Add outbound send and optional streaming.
- Register or make the channel discoverable.

## Test Strategy

Use `tests/channels/` for adapter behavior and `tests/bus/` for queue behavior. WebSocket channel tests should focus on socket admission, message frames, stream deltas, subscriptions, broadcast behavior, frame compatibility, and control-route mount smoke checks. Browser HTTP control behavior belongs in `tests/api/`.

When frontend Agent UI behavior changes, pair channel compatibility tests with browser-side smoke tests such as `node webui/assets/src/agent-ui-events.test.mjs`. The channel tests should prove the transport contract did not drift; the JavaScript tests should prove normalization, reducer, and renderer allowlist behavior.

For new platform channels, test allow-list handling, inbound normalization, send failure propagation, and stream support if implemented.
