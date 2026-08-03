# Desktop Runtime

`desktop` wires the Rust backend into the Tauri application. It owns startup,
shared desktop state, logging, file helpers, menus, and application updates.

Frontend-facing command handlers live separately in `desktop_commands/`.
