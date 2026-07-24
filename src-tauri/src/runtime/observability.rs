use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct AgentRuntimeMetrics {
    state: Arc<Mutex<AgentRuntimeMetricsState>>,
}

#[derive(Debug, Default)]
struct AgentRuntimeMetricsState {
    counters: BTreeMap<String, u64>,
    durations: BTreeMap<String, DurationAggregate>,
    gauges: BTreeMap<String, i64>,
}

#[derive(Clone, Copy, Debug, Default)]
struct DurationAggregate {
    count: u64,
    total_ms: u64,
    max_ms: u64,
}

impl AgentRuntimeMetrics {
    #[cfg(test)]
    pub fn isolated() -> Self {
        Self::default()
    }

    pub fn increment(&self, name: &str) {
        self.increment_by(name, 1);
    }

    pub fn increment_by(&self, name: &str, value: u64) {
        let mut state = self
            .state
            .lock()
            .expect("agent runtime metrics lock should not be poisoned");
        let counter = state.counters.entry(name.to_string()).or_default();
        *counter = counter.saturating_add(value);
    }

    pub fn record_duration(&self, name: &str, duration: Duration) {
        self.record_duration_ms(name, duration.as_millis().min(u128::from(u64::MAX)) as u64);
    }

    pub fn record_duration_ms(&self, name: &str, duration_ms: u64) {
        let mut state = self
            .state
            .lock()
            .expect("agent runtime metrics lock should not be poisoned");
        let aggregate = state.durations.entry(name.to_string()).or_default();
        aggregate.count = aggregate.count.saturating_add(1);
        aggregate.total_ms = aggregate.total_ms.saturating_add(duration_ms);
        aggregate.max_ms = aggregate.max_ms.max(duration_ms);
    }

    pub fn set_gauge(&self, name: &str, value: i64) {
        self.state
            .lock()
            .expect("agent runtime metrics lock should not be poisoned")
            .gauges
            .insert(name.to_string(), value);
    }

    pub fn snapshot(&self) -> Value {
        let state = self
            .state
            .lock()
            .expect("agent runtime metrics lock should not be poisoned");
        let counters = state
            .counters
            .iter()
            .map(|(name, value)| (name.clone(), Value::from(*value)))
            .collect::<serde_json::Map<_, _>>();
        let durations = state
            .durations
            .iter()
            .map(|(name, aggregate)| {
                let average_ms = if aggregate.count == 0 {
                    0.0
                } else {
                    aggregate.total_ms as f64 / aggregate.count as f64
                };
                (
                    name.clone(),
                    serde_json::json!({
                        "count": aggregate.count,
                        "totalMs": aggregate.total_ms,
                        "maxMs": aggregate.max_ms,
                        "averageMs": average_ms,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let gauges = state
            .gauges
            .iter()
            .map(|(name, value)| (name.clone(), Value::from(*value)))
            .collect::<serde_json::Map<_, _>>();
        serde_json::json!({
            "schemaVersion": 1,
            "generatedAtUnixMs": now_unix_ms(),
            "counters": counters,
            "durations": durations,
            "gauges": gauges,
        })
    }
}

pub fn global_agent_runtime_metrics() -> &'static AgentRuntimeMetrics {
    static METRICS: OnceLock<AgentRuntimeMetrics> = OnceLock::new();
    METRICS.get_or_init(AgentRuntimeMetrics::default)
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "observability_tests.rs"]
mod tests;
