# Agent
<!-- tinybot-module-fingerprint: sha256:3df4309c99d5e233a05cf7c8109e12e78cb1a29aa7d7ec4de859aef3beb3dbac -->

`agent` contains the native agent stack. It connects provider configuration,
the turn runtime, durable runtime events, and the desktop integration bridge.

Provider-specific transport details stay in `provider/`, while turn execution
and event projection live in `runtime/` and `runtime_protocol/`.
