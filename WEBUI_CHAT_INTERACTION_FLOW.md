# WebUI Chat Interaction Flow Investigation

This document records the WebUI chat-page interaction flow as implemented in
`webui/index.html`, `webui/assets/src/legacy/app.js`,
`webui/assets/src/agent-ui-events.js`, and
`webui/assets/src/cowork-chat.js`.

The focus is the user-visible chat experience: how chat content is displayed,
how users interact with it, and what happens for tools, memory references,
recent context references, Cowork runs, files, and Agent UI form requests.

## Scope

- Chat shell and DOM entry points: `webui/index.html`
- Main WebUI controller and renderer: `webui/assets/src/legacy/app.js`
- Agent UI frame normalization and reducer state:
  `webui/assets/src/agent-ui-events.js`
- Homepage chat Cowork helper logic:
  `webui/assets/src/cowork-chat.js`

The embedded Cowork surface described here is the homepage chat surface inside
the normal message list. It is separate from the full `/cowork` console/modal
also present in the WebUI.

## High-Level Architecture

The chat page is driven by a local front-end state object plus a WebSocket
event stream.

1. The initial HTML provides stable containers:
   - session/sidebar controls
   - current session title
   - `#message-list`
   - composer form
   - file strip
   - status and error surfaces
   - right-side inspector panel
   - modal/console surfaces for tools, skills, Cowork, settings, etc.
2. `legacy/app.js` loads sessions, messages, temporary files, approvals, and
   related runtime surfaces.
3. The WebSocket receives legacy frames such as `chat_created`, `attached`,
   `delta`, `message`, `stream_end`, `approval_pending`, `usage`,
   `browser_frame`, `cowork_state`, `cowork_stream`,
   `cowork_mailbox_stream`, and `agent_ui_event`.
4. Each incoming frame is normalized through `normalizeAgentUiEvents` where
   applicable. The normalized state is accumulated in `state.agentUi`.
5. The visible chat list is re-rendered through `renderMessages`, which turns
   raw messages into display items:
   - regular message nodes
   - run-chain nodes for tool/reasoning activity
   - collapsed hidden-message groups
   - embedded chat Cowork surfaces
6. Some interactions open the right-side inspector:
   - tool/run-chain item inspection
   - memory source inspection
   - Cowork agent inspection

## Static Chat Layout

The main chat panel is defined in `webui/index.html`.

Important visible areas:

- Skip link to `#message-list` for accessibility.
- Session sidebar with:
  - sessions toggle
  - session count
  - new chat button
  - refresh button
  - session list
- Chat header:
  - current session title
  - action buttons such as clear messages
- Message list:
  - `#message-list`
  - aria live region for dynamic chat updates
- Composer:
  - temporary file upload button
  - textarea input
  - send button
  - hidden file input
  - `#session-files-strip`
  - status panel
  - persistent RAG checkbox labeled with the meaning "use uploaded/imported
    materials to answer"

The message DOM template is `#message-template`. It provides:

- article root
- message meta
- role label
- timestamp
- message content container

## Session List Interaction

The left session list is rendered by `renderSessions`.

Display behavior:

- If there are no sessions, the list shows an empty state.
- Each session item is a wrapper containing a main button and a delete button.
- The active session gets an active class.
- Sessions with an in-flight response get a responding class and spinner.
- Session title is derived from existing messages when possible.

Interactions:

- Clicking a session attaches the WebSocket to that chat id.
- If the Cowork page/modal is active, selecting a session first closes that
  Cowork page/modal context.
- Clicking delete is a two-step confirmation:
  - first click changes the delete button into a confirming state
  - second click calls `deleteSession`
- Deleting the active session clears active chat state or switches to the next
  available session.
- Refresh reloads sessions, editable files, and system status.
- Clear session posts to the clear endpoint and empties local messages,
  temporary files, responding state, approvals, and inspector state.

## New Chat Flow

When the user clicks new chat:

1. If the Cowork page/modal is active, it is closed.
2. Otherwise the session dropdown is opened.
3. A WebSocket message `{ type: "new_chat" }` is sent.
4. When the backend emits `chat_created`, the frontend activates the created
   chat and reloads sessions.
5. If a user message had been typed before the chat existed, the saved
   `pendingMessage` is immediately sent to the newly created chat.

This means a user can type into an empty state and send without manually
creating a session first. The UI creates the session, then sends the message.

## Composer Interaction

The composer input has these behaviors:

- Input resizes automatically.
- Height is capped relative to the viewport and fixed pixel bounds.
- Enter sends.
- Shift+Enter inserts a newline.
- Empty or whitespace-only input does nothing.
- Submit through the form and submit through keydown share the same
  `submitMessage` path.

When sending in an existing chat:

1. The user message is immediately appended to the local message bucket.
2. The composer is cleared.
3. The active session is marked responding.
4. The WebSocket sends:
   - `type: "message"`
   - `chat_id`
   - `content`
   - `use_persistent_rag`
5. The `use_persistent_rag` value is true unless the persistent RAG checkbox is
   explicitly unchecked.

If no active chat exists:

1. The input is stored as `state.pendingMessage`.
2. The composer is cleared.
3. Status changes to "creating session".
4. A new chat is requested.
5. The saved message is sent after `chat_created`.

## Streaming Response Flow

The assistant response can arrive through `delta` frames and/or final
`message` frames.

For `delta`:

- `upsertStreamMessage` creates or updates a streaming assistant message.
- Content deltas and reasoning deltas can update the same stream buffer.
- If the message is already visible, the DOM content is updated directly.
- The chat scrolls to bottom if the user was already near the bottom.

For `stream_end`:

- The stream entry is located by `message_id`.
- Memory references and recent context references collected in
  `state.agentUi` are attached to the stream message.
- The stream is marked finalized.
- Responding state is cleared unless the message is flagged as resuming.
- Messages are re-rendered so the final memory/recent context surfaces appear.

For final `message`:

- Normal assistant messages are pushed into the message list.
- `_memory_references` and `_recent_context_references` are preserved on the
  message object.
- Progress/tool messages are handled separately as tool/progress surfaces.

## Main Message Rendering Pipeline

`renderMessages` is the central render function.

The pipeline:

1. Resolve active session key.
2. If there is no active session, render a no-session empty state.
3. If the active session has no messages, render an empty-chat state.
4. Run `prepareMessageRelationships(messages)`.
5. Run `createMessageDisplayItems(messages)`.
6. Insert a chat Cowork surface item if visible Cowork sessions exist.
7. Render each display item:
   - run-chain item -> `createRunChainNode`
   - collapsed item -> `createCollapsedMessagesNode`
   - chat-cowork-surface item -> `createChatCoworkSurfaceNode`
   - message item -> Agent UI message renderer, backed by `createMessageNode`
8. Preserve scroll position unless the user is near the bottom or a forced
   scroll is requested.

This pipeline is important because the raw message order from the backend is
not always the same as the final visible chat order. Tool process messages can
be grouped, collapsed, or associated with an assistant answer.

## Regular Message Nodes

Regular messages are rendered through `createMessageNode`.

Display behavior:

- A cloned `#message-template` is used.
- The root gets a role-specific class such as user, assistant, tool, or
  progress.
- User messages usually hide the meta row.
- Assistant messages remove the visible role label but keep timestamp/meta
  where appropriate.
- Tool/progress messages show `tool` or `tool: <name>`.
- User and assistant messages get a copy button when meta is visible.
- Copy uses `navigator.clipboard.writeText(message.content)`.
- Copy button tooltip/text changes temporarily on success or failure.

Content rendering:

- Assistant content is rendered as Markdown.
- Code blocks get syntax highlighting and copy controls.
- User content is rendered as plain text.
- Tool/progress content is rendered through tool activity components, not as
  generic assistant Markdown.
- Browser snapshots, task progress, Agent UI forms, tool calls, memory
  references, and recent context references have special rendering branches.

## Collapsed Message Groups

Some intermediate messages can be placed in a collapsed group.

Display:

- Root class: `message-collapse-group`
- Summary button with:
  - chevron-like icon
  - count of hidden messages
  - hint text
- Body starts hidden.

Interaction:

- Clicking the summary toggles expanded/collapsed.
- `aria-expanded`, hidden state, icon, and hint text are updated.

## Tool Relationship Preparation

Tool and progress messages are not rendered in isolation when they can be tied
to an assistant tool call.

`prepareMessageRelationships`:

- Clears stale relationship fields.
- Detects assistant messages with `tool_calls`.
- Looks ahead for following tool/progress messages.
- Associates related tool messages with the assistant tool call message.
- Pairs progress tool detail messages with tool result messages.
- Uses tool call id when available.
- Falls back to tool name / cursor matching where necessary.

Internal fields used during rendering include:

- `_relatedToolMessages`
- `_pairedToolResponse`
- `_pairedToolResponseConsumed`

This is the closest WebUI equivalent to a "related" model for tool display.
There is no single generic `related` field; relationship handling is mostly
tool-specific plus memory/recent-context-specific.

## Run-Chain Display

When a turn has intermediate reasoning/tool activity and a final assistant
answer, WebUI groups the intermediate activity into a run-chain.

Run-chain display:

- Rendered as a `<details>` element.
- Class includes status: running, completed, failed, etc.
- Summary row contains:
  - chevron icon
  - title
  - compact summary label
  - show/hide detail hint
- Expanded body contains one row per run-chain item.

Run-chain item types:

- planning / reasoning
- tool
- browser
- command
- file/read-related kinds
- agent/task-like items

Each row contains:

- status dot
- title
- preview text
- action label, usually "Inspect"

Interaction:

- Clicking the run-chain summary toggles expanded/collapsed.
- Expanded state is remembered in `state.expandedRunChains`.
- Clicking an inspectable run-chain item opens the right-side inspector.
- Opening a run-chain inspector clears selected memory and Cowork agent state.
- Clicking outside the inspector, run-chain item, or memory reference closes
  inspection mode.

Inspector content for run-chain items:

- Title and subtitle identify the selected item.
- Sections can include arguments, response, reasoning, preview, or other
  structured tool details.
- Sections can be collapsible depending on the renderer.

## Tool Activity Cards

Tool activity can appear either inside a run-chain or directly as a tool
message card.

Direct tool activity cards show:

- tool name
- status badge
- approval badge when approval metadata exists
- argument section when arguments are available
- response/result section when related output is available
- fallback empty state if there are no args or response details

Special cases:

- Task tool calls are displayed as `task:<action>`.
- Progress messages with `_task_event` are rendered as task progress cards.
- Browser snapshot frames are routed to browser snapshot rendering instead of
  normal tool cards.

## Agent UI Event Normalization

`agent-ui-events.js` normalizes backend frames into a stable event model.

Important event types:

- `message.completed`
- `message.stream.completed`
- `tool.call.started`
- `tool.call.updated`
- `tool.call.completed`
- `approval.requested`
- `approval.resolved`
- `browser.frame.updated`
- `memory.references.updated`
- `recent_context.references.updated`
- `usage.updated`
- `session.file.updated`
- `error.raised`
- `ui.form.requested`
- `ui.form.updated`
- `ui.form.submitted`
- `ui.form.cancelled`
- `ui.form.expired`
- `ui.form.validation_failed`

The reducer stores:

- streams
- messages
- tool runs
- approvals
- browser frame
- usage
- forms
- memory references
- recent context references
- session files
- errors

This normalized state is used by the renderer registry in `legacy/app.js`.

## Memory Reference Handling

Backend memory references are handled explicitly.

Input fields recognized:

- `_memory_references` on legacy message/stream frames

Normalization:

- `referenceEvents` converts `_memory_references` into
  `memory.references.updated`.
- The reducer stores references in `state.agentUi.memoryReferences`, keyed by
  `message_id` or event id.
- On `stream_end`, stored references are attached back to the final stream
  message.

Rendering:

- Assistant messages with `_memory_references` append a memory references
  block after the assistant content.
- The block is a `<details class="memory-references">`.
- The summary shows a references count and a hint to open the source.
- Each reference is rendered as an article-like button row.

Each memory reference item can show:

- file path, preferring `view_file`, then `file`, then fallback
  `memory/MEMORY.md`
- line, preferring `view_line`, then `line`, then `cursor`
- content excerpt
- scope
- type
- note id
- evidence id or other available identity fields

Interaction:

- Click opens the memory reference inspector.
- Keyboard Enter opens the inspector.
- Keyboard Space opens the inspector.
- The selected item gets a selected class.
- The `<details>` block is automatically open when it contains the selected
  memory reference.

Inspector behavior:

- Opening memory inspector clears selected run-chain item and Cowork agent.
- The right-side inspector title/subtitle reflect the selected memory source.
- WebUI attempts to fetch the referenced workspace file.
- It renders a line-numbered source preview.
- It highlights the target line.
- It scrolls the target line into view.
- If the file cannot be read or the target cannot be resolved, it shows an
  unavailable/error state instead of crashing.

Highlight resolution:

- Prefer note id or content matching when possible.
- Fall back to explicit line/cursor.
- Use file and line metadata to build a stable key.

## Recent Context Reference Handling

Recent context references are also handled explicitly, but with lighter
interaction than memory references.

Input fields recognized:

- `_recent_context_references` on legacy message/stream frames

Normalization:

- `referenceEvents` converts `_recent_context_references` into
  `recent_context.references.updated`.
- The reducer stores references in `state.agentUi.recentContextReferences`,
  keyed by `message_id` or event id.
- On `stream_end`, stored references are attached back to the final stream
  message.

Rendering:

- Assistant messages with `_recent_context_references` append a recent context
  block after the assistant content.
- The block uses the same base class as memory references plus a
  `recent-context-references` class.
- It is rendered as `<details>`.
- The summary shows the count and a source-view hint.

Each recent context item can show:

- excerpt or content
- timestamp
- session key
- role
- turn id
- evidence id
- file and line if present

Current limitation:

- Recent context items do not currently open the memory/source inspector.
- They are displayed as expandable source context cards only.
- This differs from memory references, which are clickable and inspectable.

## Agent UI Form Requests

Backend `ui.form.*` events can insert form cards into the message stream.

When an Agent UI form event arrives:

1. The normalized event is reduced into `state.agentUi.forms`.
2. `upsertAgentUiFormMessage` creates or updates a synthetic assistant message.
3. The message has `_agent_ui_form_id`.
4. `updateMessageContent` sees `_agent_ui_form_id` and renders a form card
   instead of normal message text.

Form card display:

- Card root class includes form status.
- Header shows title and status.
- Optional description is rendered below the header.
- Form-level error banner is shown if `_form` error exists.
- Each field is rendered from schema.
- Supported fields include text, textarea, number, select, multiselect,
  checkbox, radio, date/time-like fields, and file path-like fields.
- Required fields show a required indicator.
- Help text and field-level errors are displayed near each field.
- Pending forms show Submit and Cancel buttons.
- Submitted/cancelled/expired forms become readonly.

Submit interaction:

1. Collect values from the rendered controls.
2. Run local validation.
3. If validation fails:
   - status becomes validation failed
   - errors are rendered
   - focus moves to the first invalid field
4. If validation passes:
   - controls are disabled while submitting
   - POST `/api/agent-ui/forms/{form_id}/submit`
   - on success, status becomes submitted and card rerenders readonly
   - on failure, errors are shown and first invalid field is focused

Cancel interaction:

1. Build cancel request.
2. Disable controls while sending.
3. POST `/api/agent-ui/forms/{form_id}/cancel`
4. On success, status becomes cancelled.
5. On failure, form-level error is shown.

When a new form request arrives, session responding state is cleared so the UI
does not keep showing the assistant as still responding while waiting for user
input.

## Temporary Files and Persistent RAG

The composer includes a temporary file upload control.

Upload interaction:

- If no active session exists, clicking upload reports a no-session error.
- If a session exists, the hidden file input opens.
- On file selection:
  - the file is POSTed to
    `/sessions/{sessionKey}/temporary-files`
  - the upload button is disabled while uploading
  - status changes to uploading
  - on success, the result is appended to session files state
  - the file strip rerenders
  - status briefly shows uploaded, then connected
  - on failure, the error surface is updated

File strip display:

- Hidden when no temporary files exist.
- Visible label indicates these files are context.
- Each file appears as a chip with:
  - file type icon such as MD/PDF/TXT
  - file name
  - chunk count

Persistent RAG checkbox:

- The checkbox controls whether existing uploaded/imported knowledge should be
  used.
- Its value is sent with every message as `use_persistent_rag`.
- The code treats the value as true unless the checkbox is explicitly false.

## Browser Snapshot / Browser Frame Surfaces

Backend browser frame and browser snapshot events are normalized as
`browser.frame.updated`.

Visible behavior:

- Existing browser snapshot panel is updated with the latest frame.
- Messages containing `_browser_snapshot` render a browser snapshot surface
  instead of normal text.
- The snapshot path is independent from memory/source inspector behavior.

## Approval Surfaces

Approval events are normalized, and legacy `approval_pending` frames trigger
approval reloads.

Visible behavior:

- Tool cards can include approval metadata and approval badges.
- `approval_pending` clears responding state and reloads approval controls.
- Approval rendering is delegated through the Agent UI renderer registry to
  `loadApprovals`.

## Usage and Status

Usage frames update token/usage status through the Agent UI renderer surface.

Status messages are used for:

- connected/disconnected
- creating session
- upload progress
- upload success
- file errors
- server errors
- session clear/delete failures

WebSocket close/error clears responding state and moves the status to a
disconnected/failed state.

## Cowork Embedded Chat Surface

The chat page can show a Cowork run inline in the message list.

Important distinction:

- This is not the full `/cowork` console.
- It is an embedded summary surface placed inside the chat transcript for the
  current origin chat.

Cowork state is managed by `createChatCoworkState`, which stores:

- sessions by chat id
- refresh timers
- loading keys
- last Cowork state events
- live stream fragments
- mailbox draft stream fragments
- render timers

Loading:

- After loading messages for a chat, WebUI calls `loadChatCoworkSessions`.
- It fetches:
  `/cowork/sessions?include_completed=true&origin_chat_id={chatId}`
- The results are remembered under that chat id.

Visibility selection:

- `getChatCoworkSessions` filters to sessions that have agents.
- Sessions are sorted so active sessions win over inactive sessions.
- `selectVisibleChatCoworkSessions` returns:
  - all sessions if there is zero or one
  - otherwise the first active session
  - otherwise the first sorted session
- If more sessions exist than are visible, the surface shows a note that older
  sessions are hidden and only the latest active session is shown.

Insertion:

- `chatCoworkSurfaceInsertionIndex` uses session timestamps to choose where the
  Cowork surface should appear relative to messages.
- If no timestamp anchor exists, the surface is inserted after the first
  assistant/final content opportunity.

## Cowork Run Card Display

Each embedded Cowork session is rendered by `createChatCoworkSessionNode`.

Run header:

- Eyebrow:
  - "Cowork run"
  - or "Cowork run X/Y" when multiple sessions exist
- Title from the run summary
- Identity line containing session id and workflow/architecture label
- Metrics:
  - status badge
  - Agents count
  - Active count
  - Tasks completed/total

Run summary:

- Progress bar based on task completion.
- Attention badge, such as no attention needed, blocked, failed, reply needed,
  or similar attention states derived from tasks/agents/mailbox/completion
  decision.

Agent list:

- One button row per agent.
- Avatar is the first letter of the agent label.
- Main text shows:
  - agent display label
  - current task, role, or waiting state
- If live output exists:
  - row gets a `has-live-output` class
  - inline live output snippet is shown
  - snippet is marked running or completed
- Right side shows:
  - status badge
  - latest activity
  - attention label if needed

Final output:

- If a run has final output or status is completed, a final output block is
  shown.
- The final output helper prefers:
  - `final_draft`
  - `session_final_result.summary`
  - `completion_decision.final_output`
  - other fallback final text fields
- The displayed final output is compacted for inline display.

## Cowork Agent Inspector

Clicking an agent row opens the right-side inspector.

Open behavior:

- Inspection mode is enabled.
- Selected run-chain item is cleared.
- Selected memory reference is cleared.
- Selected Cowork agent is set.
- Inspector panel becomes visible.
- Messages rerender so the selected agent row gets selected styling.
- WebUI fetches:
  `/cowork/sessions/{sessionId}/agents/{agentId}/activity`

Inspector title/subtitle:

- Title uses agent name, agent id, or selected agent id.
- Subtitle includes role, session id, and refreshing state.

Inspector loading states:

- If loading and no prior activity exists, shows loading text.
- If loading fails and no prior activity exists, shows the error.
- If activity is unavailable, shows unavailable text.

Inspector sections:

- Tasks
- Agent Thread

Tasks section:

- Shows active/known tasks.
- Each task card shows title/id and status badge.
- If no task is available, shows "No active task."

Agent Thread section:

- Derived from activity plus live streams and mailbox drafts.
- Empty state says no agent thread messages.
- Each timeline message shows:
  - route, sender, recipient
  - kind
  - status
  - reply required if applicable
  - live/complete state
  - formatted timestamp
  - body rendered as markdown unless flagged plain text

Scroll behavior:

- Before rerendering, inspector captures thread scroll.
- After rerendering, it restores scroll position.
- This avoids jumps while live streams update an open Cowork inspector.

## Cowork WebSocket Updates

Cowork-related WebSocket frames:

- `cowork_state`
- `cowork_stream`
- `cowork_mailbox_stream`

`cowork_state`:

- Normalized through `normalizeCoworkStateEvent`.
- Stored in `lastEvents`.
- Schedules a refresh for the affected chat/session.
- Also schedules full Cowork page refresh if that page is active.

`cowork_stream`:

- Normalized through `normalizeCoworkStreamEvent`.
- Stored in live stream state.
- Schedules a lightweight chat Cowork rerender.
- If the selected inspector belongs to the affected chat, the inspector is
  refreshed.

`cowork_mailbox_stream`:

- Normalized through `normalizeCoworkMailboxStreamEvent`.
- Stored in mailbox draft state.
- Schedules mailbox/inspector refresh if relevant.

Timers:

- Stream and mailbox renders are throttled through render timers /
  `requestAnimationFrame` to avoid rerendering on every tiny stream fragment.
- Session refresh is debounced by a short timeout.

## Interaction Mode Conflicts

The right inspector can show only one primary inspection mode at a time.

Opening run-chain inspector:

- selects a chain item
- clears selected memory reference
- clears selected Cowork agent

Opening memory inspector:

- selects a memory reference
- clears selected chain item
- clears selected Cowork agent

Opening Cowork agent inspector:

- selects a Cowork agent
- clears selected chain item
- clears selected memory reference

Closing inspection mode:

- clears all selections
- hides inspector panel
- removes selected classes from run-chain, memory reference, and Cowork agent
  rows

Clicking outside the inspector closes it unless the click target is:

- inside the inspector
- a run-chain item
- inside a memory references block

## Handling Backend Memory / Related Information

The WebUI does handle backend memory-like and related-like information.

Memory:

- `_memory_references` is normalized, reduced, attached to messages, rendered
  in expandable cards, and inspectable through source preview.

Recent context:

- `_recent_context_references` is normalized, reduced, attached to messages,
  and rendered in expandable cards.
- It is not currently inspectable through the right-side source inspector.

Tool related output:

- Tool calls are related to follow-up tool/progress messages through tool call
  id and fallback matching.
- Related messages are grouped into tool activity cards or run-chain items.
- Arguments and responses are shown together when the relationship is found.

Cowork related state:

- Cowork sessions linked by `origin_chat_id` are loaded and inserted into the
  originating chat transcript.
- Live Cowork stream and mailbox updates are related back to chat/session/agent
  ids and update the inline surface or inspector.

There is no single generic UI treatment for a backend field literally named
`related`. The implemented related concepts are domain-specific:

- tool call relationships
- memory references
- recent context references
- Cowork origin chat/session/agent relationships

## Observed Gaps and Notes

1. Recent context references are visible but not inspectable.
   - They show source-like metadata and excerpts.
   - They do not have the click/keyboard handler that memory references have.

2. Memory references have a much richer source-preview path.
   - They can fetch the referenced file.
   - They can highlight lines.
   - They keep selected state and reopen their `<details>` block.

3. Tool relationship rendering is robust but specific to tool/progress
   conventions.
   - It relies on tool call id when possible.
   - It falls back to tool names and nearby message order.

4. Cowork inline chat display is intentionally compact.
   - It shows one active/latest session when multiple sessions exist.
   - Deeper details are moved into the inspector after selecting an agent.

5. The chat page is not only message text.
   - It can embed forms, task progress, browser snapshots, tool chains, memory
     sources, recent context cards, Cowork swarms, session file chips, approval
     state, and usage/status surfaces.

## Source Map

- `webui/index.html`
  - chat shell, message list, composer, persistent RAG toggle, session file
    strip, Cowork modal/console markup
- `webui/assets/src/legacy/app.js`
  - state wiring, WebSocket handling, session handling, composer handling,
    message rendering, tool/run-chain rendering, memory rendering, recent
    context rendering, Agent UI form rendering, Cowork surface rendering
- `webui/assets/src/agent-ui-events.js`
  - normalized Agent UI event schema, memory/recent context extraction,
    reducer state, form validation helpers
- `webui/assets/src/cowork-chat.js`
  - chat Cowork session state, visible session selection, insertion index,
    Cowork summaries, live stream/mailbox reconciliation, agent thread
    derivation
