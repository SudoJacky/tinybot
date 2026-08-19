# Desktop Commands
<!-- tinybot-module-fingerprint: sha256:85c444f1ca9268bc53a4063564f9e4c46dec282e74a91d74d86cf6cc9200947f -->

`desktop_commands` contains the Tauri command boundary used by the desktop
frontend. Commands are grouped by agent, configuration, hooks, memory, runtime,
skills, plugins, project groups, threads, transport, WebUI, and workspace
operations.

These handlers should stay thin and delegate domain behavior to the owning
backend module.

Hook commands resolve an existing workspace directory, return the additive
global/workspace catalog, and mutate trust only after the backend confirms the
requested exact-definition hash is still configured. They never execute a
hook implicitly from the Tauri command boundary. Managed-hook commands delegate
save, isolated sample testing, and recoverable archive behavior to
`command_hooks`. Managed-script read and save commands also delegate path
derivation, containment, size, and revision checks there; the command layer
only resolves and validates the workspace.

Chat creation, cancellation, and form resolution use the typed Thread commands.
The transitional `worker_dispatch_tinyos_host_command` boundary accepts only
`operation.retry`; the retired desktop file, terminal, browser-control, and
pause/resume commands are not part of this boundary.
