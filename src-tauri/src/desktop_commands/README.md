# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:1f9ef58bf7c00df6d40d9744c80679507a8734ec9ed876644784fe5b54cd9c29 -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, memory, runtime, skills,
plugins, project groups, threads, transport, WebUI, and workspace operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

Chat creation, cancellation, and form resolution use the typed Thread commands.
The transitional `worker_dispatch_tinyos_host_command` boundary accepts only
`operation.retry`; the retired desktop file, terminal, browser-control, and
pause/resume commands are not part of this boundary.
