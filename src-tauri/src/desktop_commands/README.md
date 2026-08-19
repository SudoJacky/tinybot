# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:a0ee0f1a5eb1af36eb9dabe634682ce8de30ed18e7308d57315ac9b413a1caf8 -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, hooks, memory, runtime,
skills, plugins, project groups, threads, transport, WebUI, and workspace
operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

Hook commands resolve an existing workspace directory, return the additive
global/workspace catalog, and mutate trust only after the backend confirms the
requested exact-definition hash is still configured. They never execute a
hook from the Tauri command boundary. The managed-hook save command delegates
ID, manifest, script-template, and validation behavior to `command_hooks` and
returns the refreshed catalog.

Chat creation, cancellation, and form resolution use the typed Thread commands.
The transitional `worker_dispatch_tinyos_host_command` boundary accepts only
`operation.retry`; the retired desktop file, terminal, browser-control, and
pause/resume commands are not part of this boundary.
