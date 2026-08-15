# Create Agent Plugin
<!-- tinybot-module-fingerprint: sha256:4ca912110ab5cfc18b91cacf936786566a9460ac035c8dbcdf13e480b009c6f5 -->

Tinybot's bundled helper for creating a portable [Agent Plugins v1](https://agent-plugins.org/specification) package from an existing standalone Skill, MCP configuration, or client-specific plugin.

The package includes the `migrate-agent-plugin` Agent Skill and its migration, client-extension, and validation references. Tinybot selects this skill automatically when a user starts **Migrate Skill or MCP** from the Tools & Plugins page.

The Agent Plugins specification remains the normative source. This package is based on the MIT-licensed `agentplugins/agent-plugins-example` reference package and is distributed with Tinybot so users do not need to download and import that package themselves.
