# Performance Trace Route
<!-- tinybot-module-fingerprint: sha256:72aea557cf92952d8aa84d5035748557d9d2715b84b5a993927fa624c36f9186 -->

`performance` owns the System > Performance Trace surface. It loads one
versioned, process-local snapshot through `AppServices.performanceStore` and
renders duration aggregates, counters, gauges, and the bounded recent event
ring. The default store merges Rust startup phases with the renderer's bounded
startup trace, so process setup, React commit, first frame, native event
registration, and session restoration can be compared on the same page.

Refresh is user-driven so the observer does not create a polling workload.
The JSON action saves exactly the currently displayed snapshot through the
native desktop file dialog and reports the selected path after the write
completes. A separate diagnostic-bundle action delegates to the native exporter
through the parameterless route-facing store method, while the default service
supplies the renderer ring and device locale metadata.

The route also owns the explicit diagnostic-mode toggle. Enabling it persists
renderer debug and info events in addition to the default warning and error
stream until the user disables it. The page states that the ZIP remains local,
is not uploaded automatically, and must be reviewed before manual Issue
attachment. Loading, configuration, and export failures remain visible.
