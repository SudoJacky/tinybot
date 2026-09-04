# RPC Tests
<!-- tinybot-module-fingerprint: sha256:3b69a249ba8db1f18b082630924dd9d2d3531d22321c8886fb0b21b844a44bb1 -->

This directory groups end-to-end router tests by service family. The suites
cover request validation and dispatch for automation, collaboration, threads,
tools, workspaces, shell operations, retained-process continuation through the
generic tool executor, and schema v2 Config-store writes.

Shared router fixtures live in `mod.rs`.
