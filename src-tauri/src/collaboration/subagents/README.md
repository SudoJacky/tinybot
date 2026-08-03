# Subagents

`subagents` manages delegated agent threads. It tracks parent-child ownership,
lifecycle state, capacity limits, queued input, waiting, interruption, and
terminal results.

The manager is process-local; durable thread and event data are handled by the
thread and runtime layers.
