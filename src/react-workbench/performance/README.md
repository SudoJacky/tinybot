# Performance Trace Route
<!-- tinybot-module-fingerprint: sha256:3eae7f56bb6686257323a1164e84fb487b0e2a0c799b5b8fcdc0c25b0e5c1733 -->

`performance` owns the System > Performance Trace surface. It loads one
versioned, process-local snapshot through `AppServices.performanceStore` and
renders duration aggregates, counters, gauges, process memory, and the bounded
recent event ring. Memory is split between the Rust/Tauri host and the WebView2
child processes reported by each Tinybot webview, with partial collection
failures kept visible alongside the available values. The default store merges
Rust startup phases with the renderer's bounded startup trace, so process
setup, React commit, first frame, native event
registration, and session restoration can be compared on the same page.

Refresh remains user-driven. Memory recording is a separate explicit control;
while enabled it calls the memory-only command every two seconds, retains at
most 300 samples, and stops visibly on the first collection failure. This keeps
the default page observer-free while still allowing a bounded trend capture.
The JSON action saves exactly the currently displayed snapshot through the
native desktop file dialog and reports the selected path after the write
completes. A separate diagnostic-bundle action delegates to the native exporter
through the route-facing store method, while the default service supplies the
optional memory samples, renderer ring, and device locale metadata.

The route also owns the explicit diagnostic-mode toggle. Enabling it persists
renderer debug and info events in addition to the default warning and error
stream until the user disables it. The page states that the ZIP remains local,
is not uploaded automatically, and must be reviewed before manual Issue
attachment. Loading, configuration, and export failures remain visible.
