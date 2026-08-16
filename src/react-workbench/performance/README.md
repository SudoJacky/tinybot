# Performance Trace Route
<!-- tinybot-module-fingerprint: sha256:532d381d33c44b187bb23593739d6bb4bad7ae026b1d660fbc660f19362b11cc -->

`performance` owns the System > Performance Trace surface. It loads one
versioned, process-local snapshot through `AppServices.performanceStore` and
renders duration aggregates, counters, gauges, and the bounded recent native
event ring.

Refresh is user-driven so the observer does not create a polling workload.
Export downloads exactly the currently displayed JSON snapshot. Loading and
export failures remain visible, and sensitive event context is expected to be
redacted by the native collector before it crosses the renderer boundary.
