# Shared UI
<!-- tinybot-module-fingerprint: sha256:0d3e5f8204a5b68eba52062e00afa365c203062bdf21d2b7ae502fc5774ec2c7 -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for ordinary Chat and controlled attachment state for native
entry points such as desktop-pet quick chat; both paths share selection limits,
removal, file-only submission, and successful-send clearing.
Model options may declare image-input support. The composer rejects newly
selected images for text-only models while retaining ordinary files, and an
existing incompatible image blocks sending after a model switch until the user
removes it or selects an image-capable model.
Its slash listbox combines route-provided executable commands with searchable
Skill options, including shared arrow-key, Enter/Tab, and Escape behavior.
Any slash immediately behind the caret starts or resets the active query; typing
continues filtering until the query is dismissed or the caret leaves it.
Selected Skills render as atomic removable tokens inline with editable user
text without placing Skill documents in the submitted message.
The composer separates full control disabling from temporary send disabling,
so a route can preserve editable drafts while an asynchronous prerequisite is
still loading. A route-provided Tools list renders as checked controls and the
composer submits the complete explicit selection, including an intentional
empty selection. Tools discovered after mount are enabled by default without
overwriting prior user toggles. Its context-window indicator also presents the latest Provider
call's prompt-cache hit rate when cached and input Token counts are available,
and distinguishes a reported zero-percent hit from unavailable usage data.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`useModalDialog` is the shared seam for modal focus, keyboard navigation,
background dismissal, focus restoration, and body scroll locking. Route-owned
dialogs keep their visual structure and domain actions local.
