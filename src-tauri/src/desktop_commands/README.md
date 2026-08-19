# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:550ae6e94767f3e5edacce6b18a0ed6088621e9409e42ed6d75ca3ed010ae490 -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, hooks, memory, runtime,
skills, plugins, project groups, threads, transport, WebUI, and workspace
operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

Hook commands resolve an existing workspace directory, return the additive
global/workspace catalog, and mutate trust only after the backend confirms the
requested exact-definition hash is still configured. They never execute a
hook from the Tauri command boundary.

Chat creation, cancellation, and form resolution use the typed Thread commands.
The transitional `worker_dispatch_tinyos_host_command` boundary accepts only
`operation.retry`; the retired desktop file, terminal, browser-control, and
pause/resume commands are not part of this boundary.
