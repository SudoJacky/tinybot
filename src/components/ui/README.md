# Shared UI
<!-- tinybot-module-fingerprint: sha256:a4b6d546025d49675c7f46a1d7a9eef79a9a1b7345df0c4438a6248f06abed58 -->

`components/ui` contains reusable renderer UI whose interface is not owned by
a single route. It currently includes the shared chat composer and its file
metadata formatting support.

Route orchestration and domain-specific state stay in `react-workbench` and
`app-core`; shared UI receives data and actions through explicit props.
