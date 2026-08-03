# Agent

`agent` contains the native agent stack. It connects provider configuration,
the turn runtime, durable runtime events, and the desktop integration bridge.

Provider-specific transport details stay in `provider/`, while turn execution
and event projection live in `runtime/` and `runtime_protocol/`.
