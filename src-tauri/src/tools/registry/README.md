# Tool Registry
<!-- tinybot-module-fingerprint: sha256:568ac3badee5aa64a7a1b9abc0234be0d1e3c9e31cd619c9687d71c478725ba0 -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

Contributors add built-in, web, workspace, MCP, runtime-control, Agent Graph,
and project-group workspace-Thread tools to a single searchable registry.
Agent Graph entries are deferred tools bound to a canonical definition
workspace, Graph ID, and revision; their provider schema exposes only the
transient Run input. Dynamic contributors must enforce their eligibility scope
so coordinator-only or cross-workspace tools do not appear in ordinary
Threads.

Provider-visible schemas include nested contracts used by native validation.
For `publish_data_view`, this includes supported view kinds and the table
`defaultSort` object with required `field` and `direction` properties.
