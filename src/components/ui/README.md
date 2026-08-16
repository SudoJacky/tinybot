# Shared UI
<!-- tinybot-module-fingerprint: sha256:b4129a417127816be83f6313ffd653fc936328758ae0653689ffa886d564a3cf -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It includes the shared chat composer, file metadata formatting,
and desktop-level modal interaction behavior.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.

`useModalDialog` is the shared seam for modal focus, keyboard navigation,
background dismissal, focus restoration, and body scroll locking. Route-owned
dialogs keep their visual structure and domain actions local.
