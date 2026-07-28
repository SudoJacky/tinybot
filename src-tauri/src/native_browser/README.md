# Native Browser Runtime

`native_browser` owns the managed WebView2 session used by TinyOS and native
Agent browser tools. Direct user input and Agent actions operate the same child
WebView and profile, so tabs, navigation, cookies, and authenticated state stay
synchronized.

The runtime is included in the default Windows desktop build. Builds without
the feature report `feature_disabled`; other platforms report
`platform_unsupported`. Remote page content does not receive Tauri IPC, global
Tauri access, or a privileged host object.

## Ownership and Agent tools

`browser.observe` and `browser.interact` are deferred Agent tools. They dispatch
directly to the `SharedBrowserRuntime` installed in Tauri state.
`browser.observe` creates or reuses the session owned by the current chat.
`browser.interact` rejects sessions and tabs owned by another chat.

State-sensitive actions must match the current control epoch and observation
revision. Coordinate clicks additionally require the current capture and must
fall inside its CSS viewport. Trusted direct user input increments the control
epoch and invalidates pending Agent work with `user_interrupted`.

Agent cancellation is forwarded to the matching in-flight browser command.
Capture bytes remain available for native Agent observation but are not
returned in model tool results or rendered as a TinyOS fallback.

## Session snapshot

`browser_session_v1` contains stable session, profile, tab, navigation,
capture, and surface identities; monotonically increasing snapshot and
observation revisions; ordered tabs and history; lifecycle state; control
epoch; profile persistence; bounded semantic targets; and at most one pending
popup or external-protocol policy request.

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
