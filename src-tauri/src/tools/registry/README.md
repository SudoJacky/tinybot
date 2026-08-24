# Tool Registry
<!-- tinybot-module-fingerprint: sha256:f061bc7cde918d3642b8abfd86c3410d0e34dea8a62888e7789f1a9b01cae51e -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

Contributors add built-in, web, workspace, MCP, runtime-control, and
project-group workspace-Thread tools to a single searchable registry. Dynamic
contributors must enforce their eligibility scope so coordinator-only tools do
not appear in ordinary Threads.

Provider-visible schemas include nested contracts used by native validation.
For `publish_data_view`, this includes supported view kinds and the table
`defaultSort` object with required `field` and `direction` properties.
