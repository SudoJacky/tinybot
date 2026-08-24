# Shared UI
<!-- tinybot-module-fingerprint: sha256:11401a40199b3a73af3aebb25adff844a59aad2973543c3cd6ede198610507dd -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for ordinary Chat and controlled attachment state for native
entry points such as desktop-pet quick chat; both paths share selection limits,
removal, file-only submission, and successful-send clearing.
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
