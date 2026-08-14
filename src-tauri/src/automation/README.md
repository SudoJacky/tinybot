# Automation
<!-- tinybot-module-fingerprint: sha256:a118b4a908a5deccf51c3e8dd3e99f7d723e85dc17c422ca7af4ed9ce65a69d9 -->

`automation` manages work that runs outside an active foreground turn.

- `background.rs` tracks background jobs and their events.
- `cron.rs` handles recurring schedules.
- `tasks.rs` stores and manages automation tasks.
