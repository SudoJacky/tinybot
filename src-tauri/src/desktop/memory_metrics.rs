use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const MEMORY_SNAPSHOT_SCHEMA: &str = "tinybot.memory_snapshot.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopMemorySnapshot {
    pub(crate) schema_version: String,
    pub(crate) sampled_at_unix_ms: u64,
    pub(crate) status: DesktopMemoryStatus,
    pub(crate) native: Option<ProcessMemorySnapshot>,
    pub(crate) webview2: WebView2MemorySnapshot,
    pub(crate) total_private_bytes: Option<u64>,
    pub(crate) total_working_set_bytes: Option<u64>,
    pub(crate) collection_errors: Vec<MemoryCollectionError>,
}

#[cfg(any(test, not(windows)))]
impl DesktopMemorySnapshot {
    pub(crate) fn unsupported(sampled_at_unix_ms: u64) -> Self {
        Self {
            schema_version: MEMORY_SNAPSHOT_SCHEMA.to_string(),
            sampled_at_unix_ms,
            status: DesktopMemoryStatus::Unsupported,
            native: None,
            webview2: WebView2MemorySnapshot::default(),
            total_private_bytes: None,
            total_working_set_bytes: None,
            collection_errors: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopMemoryStatus {
    Available,
    Partial,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessMemorySnapshot {
    pub(crate) pid: u32,
    pub(crate) private_bytes: u64,
    pub(crate) working_set_bytes: u64,
    pub(crate) peak_working_set_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WebView2MemorySnapshot {
    pub(crate) private_bytes: u64,
    pub(crate) working_set_bytes: u64,
    pub(crate) processes: Vec<WebView2ProcessMemorySnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WebView2ProcessMemorySnapshot {
    pub(crate) pid: u32,
    pub(crate) kind: String,
    pub(crate) private_bytes: u64,
    pub(crate) working_set_bytes: u64,
    pub(crate) peak_working_set_bytes: u64,
    pub(crate) webview_labels: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryCollectionError {
    pub(crate) scope: MemoryCollectionScope,
    pub(crate) code: String,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) webview_label: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MemoryCollectionScope {
    Native,
    Webview2,
}

pub(crate) async fn collect_desktop_memory(app: &AppHandle) -> DesktopMemorySnapshot {
    collect_platform_memory(app).await
}

#[cfg(not(windows))]
async fn collect_platform_memory(_app: &AppHandle) -> DesktopMemorySnapshot {
    DesktopMemorySnapshot::unsupported(now_unix_ms())
}

#[cfg(windows)]
async fn collect_platform_memory(app: &AppHandle) -> DesktopMemorySnapshot {
    use futures_util::future::join_all;
    use std::collections::{BTreeMap, BTreeSet};
    use std::time::Duration;
    use tauri::Manager;
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment8, COREWEBVIEW2_PROCESS_KIND, COREWEBVIEW2_PROCESS_KIND_BROWSER,
        COREWEBVIEW2_PROCESS_KIND_GPU, COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER,
        COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN, COREWEBVIEW2_PROCESS_KIND_RENDERER,
        COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER, COREWEBVIEW2_PROCESS_KIND_UTILITY,
    };
    use windows::core::Interface;

    #[derive(Debug)]
    struct WebView2ProcessReference {
        kind: String,
        webview_labels: BTreeSet<String>,
    }

    fn process_kind_label(kind: COREWEBVIEW2_PROCESS_KIND) -> &'static str {
        match kind {
            COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
            COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
            COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
            COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
            COREWEBVIEW2_PROCESS_KIND_PPAPI_PLUGIN => "ppapi_plugin",
            COREWEBVIEW2_PROCESS_KIND_PPAPI_BROKER => "ppapi_broker",
            COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => "sandbox_helper",
            _ => "unknown",
        }
    }

    fn query_webview2_processes(
        environment: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    ) -> Result<Vec<(u32, String)>, String> {
        let environment = environment
            .cast::<ICoreWebView2Environment8>()
            .map_err(|error| format!("WebView2 process information is unavailable: {error}"))?;
        let collection = unsafe { environment.GetProcessInfos() }
            .map_err(|error| format!("WebView2 process query failed: {error}"))?;
        let mut count = 0;
        unsafe { collection.Count(&mut count) }
            .map_err(|error| format!("WebView2 process count query failed: {error}"))?;
        let mut processes = Vec::with_capacity(count as usize);
        for index in 0..count {
            let process = unsafe { collection.GetValueAtIndex(index) }
                .map_err(|error| format!("WebView2 process {index} query failed: {error}"))?;
            let mut pid = 0_i32;
            let mut kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
            unsafe {
                process.ProcessId(&mut pid).map_err(|error| {
                    format!("WebView2 process {index} PID query failed: {error}")
                })?;
                process.Kind(&mut kind).map_err(|error| {
                    format!("WebView2 process {index} kind query failed: {error}")
                })?;
            }
            let pid = u32::try_from(pid)
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| format!("WebView2 process {index} returned invalid PID {pid}"))?;
            processes.push((pid, process_kind_label(kind).to_string()));
        }
        Ok(processes)
    }

    let sampled_at_unix_ms = now_unix_ms();
    let mut errors = Vec::new();
    let native = match read_process_memory(std::process::id()) {
        Ok(memory) => Some(memory),
        Err(message) => {
            errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Native,
                code: "process_memory_query_failed".to_string(),
                message,
                pid: Some(std::process::id()),
                webview_label: None,
            });
            None
        }
    };

    let mut pending_queries = Vec::new();
    for (label, webview) in app.webviews() {
        let (sender, receiver) = oneshot::channel();
        let query_label = label.clone();
        if let Err(error) = webview.with_webview(move |platform| {
            let result = query_webview2_processes(platform.environment());
            let _ = sender.send(result);
        }) {
            errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "webview_query_schedule_failed".to_string(),
                message: format!("Failed to schedule WebView2 memory query: {error}"),
                pid: None,
                webview_label: Some(label),
            });
            continue;
        }
        pending_queries.push(async move {
            (
                query_label,
                tokio::time::timeout(Duration::from_secs(2), receiver).await,
            )
        });
    }

    let mut references = BTreeMap::<u32, WebView2ProcessReference>::new();
    for (query_label, result) in join_all(pending_queries).await {
        match result {
            Ok(Ok(Ok(processes))) => {
                for (pid, kind) in processes {
                    let reference =
                        references
                            .entry(pid)
                            .or_insert_with(|| WebView2ProcessReference {
                                kind: kind.clone(),
                                webview_labels: BTreeSet::new(),
                            });
                    if reference.kind != kind {
                        errors.push(MemoryCollectionError {
                            scope: MemoryCollectionScope::Webview2,
                            code: "process_kind_conflict".to_string(),
                            message: format!(
                                "WebView2 PID {pid} was reported as both {} and {kind}",
                                reference.kind
                            ),
                            pid: Some(pid),
                            webview_label: Some(query_label.clone()),
                        });
                    }
                    reference.webview_labels.insert(query_label.clone());
                }
            }
            Ok(Ok(Err(message))) => errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "webview_process_query_failed".to_string(),
                message,
                pid: None,
                webview_label: Some(query_label),
            }),
            Ok(Err(_)) => errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "webview_query_channel_closed".to_string(),
                message: "WebView2 memory query closed before returning a result".to_string(),
                pid: None,
                webview_label: Some(query_label),
            }),
            Err(_) => errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "webview_query_timed_out".to_string(),
                message: "WebView2 memory query timed out after 2 seconds".to_string(),
                pid: None,
                webview_label: Some(query_label),
            }),
        }
    }

    let mut webview_processes = Vec::with_capacity(references.len());
    for (pid, reference) in references {
        match read_process_memory(pid) {
            Ok(memory) => webview_processes.push(WebView2ProcessMemorySnapshot {
                pid,
                kind: reference.kind,
                private_bytes: memory.private_bytes,
                working_set_bytes: memory.working_set_bytes,
                peak_working_set_bytes: memory.peak_working_set_bytes,
                webview_labels: reference.webview_labels.into_iter().collect(),
            }),
            Err(message) => errors.push(MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "process_memory_query_failed".to_string(),
                message,
                pid: Some(pid),
                webview_label: None,
            }),
        }
    }
    webview_processes.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.pid.cmp(&right.pid))
    });

    build_snapshot(sampled_at_unix_ms, native, webview_processes, errors)
}

fn build_snapshot(
    sampled_at_unix_ms: u64,
    native: Option<ProcessMemorySnapshot>,
    webview_processes: Vec<WebView2ProcessMemorySnapshot>,
    collection_errors: Vec<MemoryCollectionError>,
) -> DesktopMemorySnapshot {
    let webview_private_bytes = webview_processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.private_bytes)
    });
    let webview_working_set_bytes = webview_processes.iter().fold(0_u64, |total, process| {
        total.saturating_add(process.working_set_bytes)
    });
    let total_private_bytes = native
        .as_ref()
        .map(|native| native.private_bytes.saturating_add(webview_private_bytes));
    let total_working_set_bytes = native.as_ref().map(|native| {
        native
            .working_set_bytes
            .saturating_add(webview_working_set_bytes)
    });
    DesktopMemorySnapshot {
        schema_version: MEMORY_SNAPSHOT_SCHEMA.to_string(),
        sampled_at_unix_ms,
        status: if collection_errors.is_empty() {
            DesktopMemoryStatus::Available
        } else {
            DesktopMemoryStatus::Partial
        },
        native,
        webview2: WebView2MemorySnapshot {
            private_bytes: webview_private_bytes,
            working_set_bytes: webview_working_set_bytes,
            processes: webview_processes,
        },
        total_private_bytes,
        total_working_set_bytes,
        collection_errors,
    }
}

#[cfg(windows)]
fn read_process_memory(pid: u32) -> Result<ProcessMemorySnapshot, String> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError},
        System::{
            ProcessStatus::{
                K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
            },
            Threading::{GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    let current = pid == std::process::id();
    let handle = if current {
        unsafe { GetCurrentProcess() }
    } else {
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }
    };
    if handle.is_null() {
        return Err(format!(
            "Failed to open process {pid} for memory inspection: Windows error {}",
            unsafe { GetLastError() }
        ));
    }

    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    let succeeded = unsafe {
        K32GetProcessMemoryInfo(
            handle,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    };
    let error_code = (succeeded == 0).then(|| unsafe { GetLastError() });
    if !current {
        unsafe {
            CloseHandle(handle);
        }
    }
    if let Some(error_code) = error_code {
        return Err(format!(
            "Failed to read process {pid} memory counters: Windows error {error_code}"
        ));
    }
    Ok(ProcessMemorySnapshot {
        pid,
        private_bytes: counters.PrivateUsage as u64,
        working_set_bytes: counters.WorkingSetSize as u64,
        peak_working_set_bytes: counters.PeakWorkingSetSize as u64,
    })
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_native_and_webview2_memory_without_hiding_partial_errors() {
        let snapshot = build_snapshot(
            42,
            Some(ProcessMemorySnapshot {
                pid: 10,
                private_bytes: 100,
                working_set_bytes: 80,
                peak_working_set_bytes: 90,
            }),
            vec![WebView2ProcessMemorySnapshot {
                pid: 20,
                kind: "renderer".to_string(),
                private_bytes: 200,
                working_set_bytes: 150,
                peak_working_set_bytes: 175,
                webview_labels: vec!["main".to_string()],
            }],
            vec![MemoryCollectionError {
                scope: MemoryCollectionScope::Webview2,
                code: "process_memory_query_failed".to_string(),
                message: "process exited during collection".to_string(),
                pid: Some(21),
                webview_label: None,
            }],
        );

        assert_eq!(snapshot.status, DesktopMemoryStatus::Partial);
        assert_eq!(snapshot.total_private_bytes, Some(300));
        assert_eq!(snapshot.total_working_set_bytes, Some(230));
        assert_eq!(snapshot.webview2.processes.len(), 1);
        assert_eq!(snapshot.collection_errors.len(), 1);
    }

    #[test]
    fn omits_totals_when_native_process_memory_is_unavailable() {
        let snapshot = build_snapshot(
            42,
            None,
            vec![WebView2ProcessMemorySnapshot {
                pid: 20,
                kind: "renderer".to_string(),
                private_bytes: 200,
                working_set_bytes: 150,
                peak_working_set_bytes: 175,
                webview_labels: vec!["main".to_string()],
            }],
            Vec::new(),
        );

        assert_eq!(snapshot.total_private_bytes, None);
        assert_eq!(snapshot.total_working_set_bytes, None);
    }
}
