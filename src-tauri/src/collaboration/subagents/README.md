# Subagents
<!-- tinybot-module-fingerprint: sha256:96d080932a8914ba2b765562c23d9cb1b0b0fced98d07045046520d931989f35 -->

`subagents` manages delegated agent threads. It tracks parent-child ownership,
lifecycle state, capacity limits, queued input, waiting, interruption, and
terminal results.

The manager is process-local; durable thread and event data are handled by the
thread and runtime layers.
