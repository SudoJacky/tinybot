# Shared UI
<!-- tinybot-module-fingerprint: sha256:291d1a6f9095b049aaf772ebb31282f479ac09243dc11dcbf63a5fed81f2acc9 -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior. Composer file references retain
the optional managed-image content hash while keeping preview and removal
interaction independent from native storage. The composer supports internal
attachment state for ordinary Chat and controlled attachment state for native
entry points such as desktop-pet quick chat; both paths share selection limits,
removal, file-only submission, and successful-send clearing.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`useModalDialog` is the shared seam for modal focus, keyboard navigation,
background dismissal, focus restoration, and body scroll locking. Route-owned
dialogs keep their visual structure and domain actions local.
