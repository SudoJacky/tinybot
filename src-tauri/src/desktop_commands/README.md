# Desktop Commands

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, memory, runtime, skills,
threads, transport, WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.
