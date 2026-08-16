# Performance Trace Route
<!-- tinybot-module-fingerprint: sha256:4c859a5b4c7b41f620ddc6b912432331ecdcf85b7128bb96f8d5fe2e5592f94d -->

`performance` owns the System > Performance Trace surface. It loads one
versioned, process-local snapshot through `AppServices.performanceStore` and
renders duration aggregates, counters, gauges, and the bounded recent native
event ring.

Refresh is user-driven so the observer does not create a polling workload.
The JSON action downloads exactly the currently displayed snapshot. A separate
diagnostic-bundle action delegates to the native exporter through the
parameterless route-facing store method, while the default service supplies
the renderer ring and device locale metadata.

The route also owns the explicit diagnostic-mode toggle. Enabling it persists
renderer debug and info events in addition to the default warning and error
stream until the user disables it. The page states that the ZIP remains local,
is not uploaded automatically, and must be reviewed before manual Issue
attachment. Loading, configuration, and export failures remain visible.
