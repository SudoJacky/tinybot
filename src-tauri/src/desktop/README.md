# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:b6ee3454838932700050779606bb220f8f8a37a5b78032348228b4009e7f3dec -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

Frontend-facing command handlers live separately in `desktop_commands/`.

`logging` owns the `tinybot.native_log.v1` record, severity levels, context
redaction and bounds, the platform log path, and 5 MiB single-backup rotation.
Runtime, renderer, updater, browser, and trace streams share this collector and
the persistent `native-backend.log`; the runtime keeps the latest 200 records
in memory as well. A collector failure is reported directly to stderr so a
logging failure cannot recurse or disappear silently.
