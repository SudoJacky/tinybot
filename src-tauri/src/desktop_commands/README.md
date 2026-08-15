# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:ed79dc38d83efa60f08a3e8f630243acca049a08ce3e06055ea681f9466f0550 -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, memory, runtime, skills,
plugins, project groups, threads, transport, WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.
