# Native Browser Runtime
<!-- tinybot-module-fingerprint: sha256:b7017d535ce78e2ac4a2a04b822a46c24e949a3447b8c8e2710092f61aba7bf4 -->

`native_browser` owns the managed WebView2 session used by TinyOS and native
Agent browser tools. Direct user input and Agent actions operate the same child
WebView and profile, so tabs, navigation, cookies, and authenticated state stay
synchronized.

The runtime is included in the default Windows desktop build. Builds without
the feature report `feature_disabled`; other platforms report
`platform_unsupported`. Remote page content does not receive Tauri IPC, global
Tauri access, or a privileged host object.

## Ownership and Agent tools

The model-facing tools are `web.open`, `web.read`, and `web.act`. They are
registered directly for each Turn and use the `SharedBrowserRuntime` installed
in Tauri state. `web.open` creates or reuses the session owned by the current
chat; reads and actions reject sessions or tabs owned by another chat.

`browser.observe` and `browser.interact` are internal adapter operations, not
registered model tools. The `tools::web` layer supplies their session, tab,
control-epoch, capture, and observation identifiers so those details do not
leak into the model-facing interface.

State-sensitive actions must match the current control epoch and observation
revision. Coordinate clicks additionally require the current capture and must
fall inside its CSS viewport. Trusted direct user input increments the control
epoch and invalidates pending Agent work with `user_interrupted`.

Agent cancellation is forwarded to the matching in-flight browser command.
Capture bytes remain available for native Agent observation but are not
returned in model tool results or rendered as a TinyOS fallback.

Agent observation does not require the TinyOS surface to be open. On Windows,
detached tabs are rendered offscreen only for the duration of a serialized
observation and return to the hidden state before the tool call continues.
Surface updates and background observations share the same presentation lock,
so opening or closing TinyOS cannot race screenshot capture.

See [`tools::web`](../tools/web/README.md) for the model-facing snapshot and
action contract.

## Session snapshot

`browser_session_v1` contains stable session, profile, tab, navigation,
capture, and surface identities; monotonically increasing snapshot and
observation revisions; ordered tabs and history; lifecycle state; control
epoch; profile persistence; bounded semantic targets; and at most one pending
popup or external-protocol policy request.

Opening or switching to a Chat does not preheat a native browser session. The
session is created lazily when the Agent first invokes a `web.*` tool or the
user opens TinyOS, so chats that never browse do not retain WebView2 processes.

Calling `browser_create_session` again with the same owner identity rehydrates
the existing session. Agent actions include navigation, coordinate or semantic
click, focused type, semantic fill, key, scroll, bounded wait, user handoff, and
resume. Accepted dispatch is not completion: the host records the eventual
completed, failed, cancelled, timed-out, or user-required result.

## Navigation and protected handoff

Navigation permits HTTPS, marks HTTP as insecure, and permits only
`about:blank` from the `about` family. HTTP(S) popups and supported external
protocols require an explicit user decision. Downloads and denied schemes are
blocked.

Uploads, native pickers, CAPTCHA, protected authentication, payment
verification, and similar protected UI enter visible `user_required` handoff.

Persistent profiles live under the application browser-profile root. Incognito
profiles use physically separate ephemeral directories and are deleted on
close. On Windows, deletion waits for the WebView2 browser process or recorded
PID to exit. Cleanup failures are returned and counted.

## Privacy and bounds

Each tab retains at most 12 captures. Semantic observations retain at most 500
visible interactive nodes, cap selector depth and accessible text, and identify
top- or child-frame provenance. They never expose password, payment-card
autocomplete, or one-time-code values.

Diagnostics redact URL credentials, queries, and fragments. They do not log
headers, cookies, form values, response bodies, screenshots, or semantic
payloads.

Platform events that reference an unknown tab emit an orphaned-event diagnostic
with the tab identity and event kind. Navigation-triggered background recapture
failures retain their session, tab, trigger, and error context instead of being
silently discarded.

## Verification

React Browser chrome has DOM coverage. WebView2 process lifecycle, DPI, focus,
native-surface stacking, remote-page IPC isolation, and real capture require
Windows integration coverage.

The deterministic fixture uses an owned loopback server. On an interactive
Windows desktop with WebView2 installed, run:

```text
cargo run -j 4 --features native-browser-integration --bin native-browser-integration
```

The harness exercises the public Rust commands, real capture, semantic privacy,
navigation history, action validation, stale-observation rejection, protected
file-picker handoff, and cleanup.
