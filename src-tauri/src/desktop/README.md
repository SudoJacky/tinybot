# Desktop Runtime
<!-- tinybot-module-fingerprint: sha256:fc807e72f9d30cd2d162228c97ee570f049757d75af640b870dfc780d4486184 -->

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

Frontend-facing command handlers live separately in `desktop_commands/`.
