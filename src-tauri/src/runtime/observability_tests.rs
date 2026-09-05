use super::*;

#[test]
fn failed_nested_operation_keeps_error_and_records_both_boundaries() {
    let metrics = AgentRuntimeMetrics::isolated();
    let result: Result<(), &str> = metrics.measure("recovery.total", || {
        metrics.measure("recovery.reload", || Err("broken projection"))
    });
    assert_eq!(result, Err("broken projection"));
    let snapshot = metrics.snapshot();
    let samples = snapshot["recentDurations"].as_array().unwrap();
    assert_eq!(samples.len(), 2);
    assert_eq!(samples[0]["name"], "recovery.reload");
    assert_eq!(samples[1]["name"], "recovery.total");
    assert!(samples.iter().all(|sample| sample["outcome"] == "failed"));
    assert!(
        samples[1]["durationMs"].as_u64().unwrap() >= samples[0]["durationMs"].as_u64().unwrap()
    );
}

#[test]
fn evicting_duration_samples_preserves_lifetime_aggregates() {
    let metrics = AgentRuntimeMetrics::isolated();
    for duration in 0..305 {
        metrics.record_duration_ms("tool.durationMs", duration);
    }
    let snapshot = metrics.snapshot();
    assert_eq!(snapshot["durations"]["tool.durationMs"]["count"], 305);
    assert_eq!(snapshot["recentDurations"].as_array().unwrap().len(), 300);
    assert_eq!(snapshot["recentDurations"][0]["durationMs"], 5);
    assert_eq!(snapshot["droppedDurationSamples"], 5);
}

#[test]
fn snapshot_aggregates_bounded_metric_names_without_dynamic_labels() {
    let metrics = AgentRuntimeMetrics::isolated();
    metrics.increment("turn.started");
    metrics.increment_by("recovery.orphaned_turns.interrupted", 2);
    metrics.record_duration_ms("turn.durationMs", 10);
    metrics.record_duration_ms("turn.durationMs", 30);
    metrics.set_gauge("context.tokens.after", 42);

    let snapshot = metrics.snapshot();

    assert_eq!(snapshot["counters"]["turn.started"], 1);
    assert_eq!(
        snapshot["counters"]["recovery.orphaned_turns.interrupted"],
        2
    );
    assert_eq!(snapshot["durations"]["turn.durationMs"]["count"], 2);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["totalMs"], 40);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["maxMs"], 30);
    assert_eq!(snapshot["durations"]["turn.durationMs"]["averageMs"], 20.0);
    assert_eq!(snapshot["gauges"]["context.tokens.after"], 42);
}
