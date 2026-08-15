# Tool Registry
<!-- tinybot-module-fingerprint: sha256:221237d5092b84f83c7ece9bff11e021aa7f670fdd9cfba6634cd22456fb477c -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

Contributors add built-in, web, workspace, MCP, runtime-control, and
project-group workspace-Thread tools to a single searchable registry. Dynamic
contributors must enforce their eligibility scope so coordinator-only tools do
not appear in ordinary Threads.
