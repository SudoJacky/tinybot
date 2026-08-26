# Shared UI
<!-- tinybot-module-fingerprint: sha256:e238089d030f31c1c472f0a677476547ca9de70330b799b91f6d94a4ceda4e9a -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for ordinary Chat and controlled attachment state for native
entry points such as desktop-pet quick chat; both paths share selection limits,
removal, file-only submission, and successful-send clearing.
Its slash listbox combines route-provided executable commands with searchable
Skill options, including shared arrow-key, Enter/Tab, and Escape behavior.
Any slash immediately behind the caret starts or resets the active query; typing
continues filtering until the query is dismissed or the caret leaves it.
Selected Skills render as atomic removable tokens inline with editable user
text without placing Skill documents in the submitted message.
The composer separates full control disabling from temporary send disabling,
so a route can preserve editable drafts while an asynchronous prerequisite is
still loading. Its context-window indicator also presents the latest Provider
call's prompt-cache hit rate when cached and input Token counts are available,
and distinguishes a reported zero-percent hit from unavailable usage data.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`useModalDialog` is the shared seam for modal focus, keyboard navigation,
background dismissal, focus restoration, and body scroll locking. Route-owned
dialogs keep their visual structure and domain actions local.
