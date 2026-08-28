# Agent Web Tools
<!-- tinybot-module-fingerprint: sha256:e4dc2e0e592784756e2a071e53efc2406c7e395de418bbde73db4e16715c36d8 -->

This module contains the network and browser tools exposed to the Agent.

## Public tools

- `web.open` opens a URL and creates or reuses the browser session.
- `web.read` reads the current page. When it includes the previous
  `snapshotId`, it may return the compact `unchanged` result.
- `web.act` performs an action on the current page and requires `snapshotId`.

The backend exposes these three tools by default to Agents with browser
capability. Browser work commonly spans multiple user turns, so keeping the
tools visible avoids losing their schemas or provider-name mappings between
turns.

The Agent does not manage browser sessions, tabs, control epochs, capture IDs,
or observation revisions. This adapter layer supplies those internal fields.

`browser.observe` and `browser.interact` remain internal capabilities and are
not exposed directly to the Agent.

## Browser lifecycle

Detaching a desktop browser surface does not implicitly destroy the Agent's
session. `browser_close_session`, or deleting the owning chat Thread, closes
every tab in that session. On Windows, Tinybot calls the WebView's `close()`
operation and releases its handles. A later Agent tool or desktop surface can
create a new session on demand.

## Layers

- `registry.rs` defines the Agent-visible tools and input schemas.
- `agent.rs` implements the `web.open`, `web.read`, and `web.act` workflows.
- `browser.rs` wraps internal observe/interact calls and ownership checks.
- `native_browser` continues to own browser sessions, tabs, events, and
  snapshot state.

## Snapshot state

Each tab retains only its current state:

```text
generation
revision
dirty
current observation
```

The Agent-visible ID is:

```text
<generation>.<revision>
```

For example, `b13ac72.4`. It is an opaque version identifier.

Tinybot does not retain historical snapshots or repeat `snapshotId` in every
`targetRef`. A `targetRef` is an opaque semantic-node reference whose current
internal shape is:

```text
target-<observation revision>-<index>
```

The observation revision identifies the semantic target set; it is not the
page-level `snapshotId`. The Agent must not parse or construct `targetRef`
values.

Agent-visible targets include only named or protected nodes in the current
viewport and are capped at 100. Each target normally contains only
`targetRef`, `role`, and `name`. Frame, disabled, focused, sensitive, and
`protectedReason` fields appear only when non-default. Coordinates, dimensions,
and fixed browser capabilities stay in the native snapshot. The backend keeps
the complete target mapping for the current observation.

`web.open` and the first `web.read` also return whitespace-normalized page
text. Extraction prefers `main`, `article`, or `[role="main"]`, then falls back
to `body`. Observation retains only the text revision; it does not transmit or
cache the whole page text. Each `web.read` fetches at most 8,000 characters and
marks them as `trust: "untrusted"`.

When more text exists, the result includes `nextTextOffset`. The Agent must
send that offset with the original `snapshotId` in its next `web.read` call;
continuations do not repeat targets. If the page changes between reads, Tinybot
returns `stale_snapshot`, `textOffsetReset: true`, and the first segment of the
new page so an old offset cannot skip new content. A page can expose at most
1,000,000 characters and reports `sourceTruncated: true` above that limit.
`web.act` does not repeat page text; use `web.read` when text is needed.

When building a later model request, Tinybot retains targets only in the most
recent Web tool result. Older target sets become `targetsSuperseded: true`,
while page text, tool-call/result pairing, and persisted history remain
unchanged. The same projection applies to Chat Completions and Responses
replay.

## Dirty state and refresh

When the page DOM changes, the WebView sends only a dirty signal:

1. The backend marks the current tab dirty.
2. It does not generate or broadcast a complete snapshot immediately.
3. The next read or action observes the page again.
4. A semantic change advances the revision.
5. An unchanged observation clears dirty state and preserves `snapshotId` and
   `targetRef` values.

Direct user input and navigation start advance the revision immediately so the
Agent cannot continue from stale page state.

## Action validation

`web.act` follows this sequence:

```text
refresh a dirty page
-> compare the requested snapshotId
-> validate again inside the browser command lock
-> perform the action
-> observe current page state
-> return the latest snapshotId
```

A stale ID prevents execution:

```json
{
  "status": "stale_snapshot",
  "actionExecuted": false,
  "requestedSnapshotId": "b13ac72.3",
  "snapshotId": "b13ac72.4",
  "snapshot": {}
}
```

The second validation closes the race in which a user changes the page after
the first comparison but before the action.

Target actions place their fields under `action`:

```json
{
  "snapshotId": "b13ac72.4",
  "action": {
    "type": "clickTarget",
    "targetRef": "target-2-7"
  }
}
```

URL navigation uses `web.open`, not a `web.act` action.

A semantic link target may include a safety-validated `href` and use
`opensNewWindow: true` when it would create another window. Calling
`clickTarget` for such a target does not click it. Tinybot returns
`navigation_required`, `actionExecuted: false`, and `suggestedUrl`; the Agent
should call `web.open` once for that URL instead of repeating the click.

`unchanged`, `stale_snapshot`, `navigation_required`, `user_required`, and
browser failures first become fact-only structured outcomes. The Agent Runtime
then derives recovery guidance, envelope and UI summaries, and optional UI
actions through its shared projection. The original Web result remains under
`result` and the runtime envelope's `raw` field. Ordinary `completed` results
retain their existing shape.

## User handoff

The Agent must not complete passwords, one-time codes, CAPTCHAs, payment
information, file pickers, or similar protected steps for the user. It calls:

```json
{
  "snapshotId": "b13ac72.4",
  "action": {
    "type": "userHandoff",
    "reason": "Please complete the login verification."
  }
}
```

The browser enters `user_required`. An attached desktop browser surface may
display the current page and reason, and trusted user input invalidates old
snapshots when appropriate. Returning control requires the surface to read the
latest control epoch and perform the internal `resume`; the Agent then uses
`web.read` to obtain a new `snapshotId`. The current Chat route does not mount
that surface, so protected handoff remains pending the replacement Sidecar UI.

While `user_required`, the Agent may observe but not act. `resume` is not an
Agent-visible action. Popup and external-protocol requests keep their separate
Allow/Deny confirmation and do not return control until the user does so
explicitly.

## Deliberate limits

The current design intentionally avoids:

- snapshot history and rollback;
- continuous background generation of complete snapshots;
- Agent management of internal browser identities;
- another cache, synchronization protocol, or global static state table.

Extensions should preserve the `web.*` interface and keep browser
implementation details in the backend.
