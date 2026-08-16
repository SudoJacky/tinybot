# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:d0d617d6d091e9a6edf3b0b10ab5106df1f14f438f69af10be2eaa609e8fa05a -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, memory, runtime, skills,
plugins, project groups, threads, transport, WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.
