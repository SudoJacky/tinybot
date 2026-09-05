# Performance Trace Route
<!-- tinybot-module-fingerprint: sha256:84e2bf0714b22f6b55fd6c689228a3aaaaecaa800368e759e0041069eb23fc24 -->

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
memory sampling opt-in while entry-level browser timing observers remain bounded.
The JSON action refreshes the native/renderer snapshot at export time through the
native desktop file dialog and reports the selected path after the write
completes. A separate diagnostic-bundle action delegates to the native exporter
through the route-facing store method, while the default service supplies the
optional memory samples, renderer ring, and device locale metadata.

The detailed-records disclosure exposes native timing samples and eviction
counts, build/process metadata, page identity/time origin, renderer collection
support and window visibility/focus. Resource and slow-event observers retain
bounded samples for the exporting page. Shared WebView2 environment labels are
explicitly distinguished from exclusive process ownership. Memory recording
starts with a fresh sample instead of seeding a potentially stale page snapshot.

The route also owns the explicit diagnostic-mode toggle. Enabling it persists
renderer debug and info events in addition to the default warning and error
stream until the user disables it. The page states that the ZIP remains local,
is not uploaded automatically, and must be reviewed before manual Issue
attachment. Loading, configuration, and export failures remain visible.
