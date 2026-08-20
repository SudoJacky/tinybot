# Tool Registry
<!-- tinybot-module-fingerprint: sha256:e463b5b2d33abc61f0850f952fb6497e14777d4f1ec686e64f75d362653230a5 -->

`registry` is the catalog of tools available to the runtime. Each entry records
its schema, exposure, execution target, required capabilities, cancellation
behavior, and mutation policy.

Contributors add built-in, web, workspace, MCP, runtime-control, and
project-group workspace-Thread tools to a single searchable registry. Dynamic
contributors must enforce their eligibility scope so coordinator-only tools do
not appear in ordinary Threads.
