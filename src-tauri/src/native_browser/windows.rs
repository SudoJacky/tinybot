use super::{
    model::{BrowserAction, BrowserProfilePersistence, BrowserRuntimeCapabilities, BrowserTabId},
    platform::{
        available_windows_capabilities, navigation_policy, safe_browser_url,
        BrowserNavigationPolicy, BrowserPlatformAction, BrowserPlatformCreateTab,
        BrowserPlatformEvent, BrowserPlatformEventSink, BrowserPlatformObservation,
        BrowserPlatformProfile, BrowserPlatformSemanticNode, BrowserPlatformSurface,
        BrowserPlatformTabState, BrowserRuntimeAdapter,
    },
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Wry,
};
use tokio::sync::{mpsc, oneshot};
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    ProcessFailedEventHandler, WebMessageReceivedEventHandler,
};
use windows::core::{HSTRING, PWSTR};

const DIRECT_INPUT_MESSAGE: &str = "tinybot-browser-direct-input-v1";
const MAX_SEMANTIC_NODES: usize = 500;
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(15);

const DIRECT_INPUT_SCRIPT: &str = r#"
(() => {
  if (window.__tinybotBrowserDirectInputInstalled) return;
  Object.defineProperty(window, '__tinybotBrowserDirectInputInstalled', { value: true });
  const notify = (event) => {
    if (event.isTrusted && window.chrome?.webview) {
      window.chrome.webview.postMessage('tinybot-browser-direct-input-v1');
    }
  };
  addEventListener('pointerdown', notify, true);
  addEventListener('keydown', notify, true);
  addEventListener('input', notify, true);
})();
"#;

const OBSERVE_SCRIPT: &str = r#"
(() => {
  const limit = 500;
  const candidates = Array.from(document.querySelectorAll(
    'a[href],button,input,textarea,select,[role],[tabindex],[contenteditable="true"],iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i]'
  ));
  const cssPath = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.localName;
      if (!part) break;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  };
  const nodes = [];
  for (const element of candidates.slice(0, limit)) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const inputType = String(element.getAttribute('type') || '').toLowerCase();
    const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase();
    const sensitive = inputType === 'password' || /cc-|one-time-code/.test(autocomplete);
    const captchaSignal = /captcha|recaptcha|hcaptcha/i.test([
      element.id,
      element.className,
      element.getAttribute('src'),
      element.getAttribute('aria-label')
    ].filter(Boolean).join(' '));
    const protectedReason = inputType === 'file' ? 'native_file_picker' : captchaSignal ? 'captcha' : null;
    const explicitName = element.getAttribute('aria-label') || element.getAttribute('title') || '';
    const textName = sensitive ? '' : String(element.innerText || element.getAttribute('placeholder') || '').trim();
    nodes.push({
      selector: cssPath(element),
      role: element.getAttribute('role') || element.localName || 'element',
      name: String(explicitName || textName).slice(0, 160),
      frame: window === window.top ? 'top' : 'child',
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      focused: document.activeElement === element,
      sensitive,
      protectedReason
    });
  }
  return {
    viewportWidth: Math.max(1, Math.round(window.innerWidth)),
    viewportHeight: Math.max(1, Math.round(window.innerHeight)),
    deviceScale: window.devicePixelRatio || 1,
    truncated: candidates.length > limit,
    nodes
  };
})()
"#;

#[derive(Clone)]
struct BrowserTabHandle {
    webview: Webview<Wry>,
    profile: BrowserPlatformProfile,
    navigation: Arc<NavigationCompletion>,
}

#[derive(Default)]
struct NavigationCompletion {
    completed: Mutex<u64>,
    notify: tokio::sync::Notify,
}

impl NavigationCompletion {
    fn revision(&self) -> u64 {
        *self
            .completed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mark_completed(&self) {
        let mut completed = self
            .completed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *completed = completed.saturating_add(1);
        self.notify.notify_one();
    }

    async fn wait_after(&self, revision: u64) -> Result<(), String> {
        tokio::time::timeout(NAVIGATION_TIMEOUT, async {
            loop {
                let notified = self.notify.notified();
                if self.revision() > revision {
                    return;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| "Native browser navigation completion timed out".to_string())
    }
}

pub(crate) struct WindowsBrowserRuntime {
    app: AppHandle,
    profile_root: PathBuf,
    tabs: RwLock<HashMap<BrowserTabId, BrowserTabHandle>>,
    event_sink: RwLock<Option<BrowserPlatformEventSink>>,
}

impl WindowsBrowserRuntime {
    pub(crate) fn new(app: AppHandle, profile_root: PathBuf) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(&profile_root).map_err(|error| {
            format!(
                "Failed to create native browser profile root {}: {error}",
                profile_root.display()
            )
        })?;
        Ok(Arc::new(Self {
            app,
            profile_root,
            tabs: RwLock::new(HashMap::new()),
            event_sink: RwLock::new(None),
        }))
    }

    fn tab(&self, tab_id: &BrowserTabId) -> Result<BrowserTabHandle, String> {
        self.tabs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .cloned()
            .ok_or_else(|| format!("Native browser tab {tab_id} is unavailable"))
    }

    fn insert_tab(&self, tab_id: BrowserTabId, handle: BrowserTabHandle) {
        self.tabs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(tab_id, handle);
    }

    fn remove_tab(&self, tab_id: &BrowserTabId) -> Option<BrowserTabHandle> {
        self.tabs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(tab_id)
    }
}

#[async_trait]
impl BrowserRuntimeAdapter for WindowsBrowserRuntime {
    fn runtime_kind(&self) -> &'static str {
        "windows_webview2"
    }

    fn runtime_version(&self) -> &'static str {
        "tauri-2.11.2/wry-0.55.1/webview2-com-0.38.2"
    }

    fn capabilities(&self) -> BrowserRuntimeCapabilities {
        available_windows_capabilities()
    }

    fn bind_event_sink(&self, sink: BrowserPlatformEventSink) {
        *self
            .event_sink
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sink);
    }

    async fn create_tab(
        &self,
        request: BrowserPlatformCreateTab,
    ) -> Result<BrowserPlatformTabState, String> {
        let url = safe_browser_url(&request.url)?;
        ensure_profile_path(&self.profile_root, &request.profile.data_directory)?;
        tokio::fs::create_dir_all(&request.profile.data_directory)
            .await
            .map_err(|error| format!("Failed to create browser profile directory: {error}"))?;

        let tab_id = request.tab_id.clone();
        let navigation_tab_id = tab_id.clone();
        let navigation_sink = self
            .event_sink
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let page_tab_id = tab_id.clone();
        let page_sink = navigation_sink.clone();
        let navigation_completion = Arc::new(NavigationCompletion::default());
        let page_navigation_completion = navigation_completion.clone();
        let title_tab_id = tab_id.clone();
        let title_sink = navigation_sink.clone();
        let popup_tab_id = tab_id.clone();
        let popup_sink = navigation_sink.clone();
        let download_tab_id = tab_id.clone();
        let download_sink = navigation_sink.clone();

        let builder = WebviewBuilder::new(
            format!("tinyos-browser-{}", safe_label(tab_id.as_str())),
            WebviewUrl::External(url.clone()),
        )
        .data_directory(request.profile.data_directory.clone())
        .incognito(request.profile.persistence == BrowserProfilePersistence::Incognito)
        .devtools(false)
        .initialization_script(DIRECT_INPUT_SCRIPT)
        .on_navigation(move |url| match navigation_policy(url) {
            BrowserNavigationPolicy::Embedded => true,
            BrowserNavigationPolicy::ExternalCandidate => {
                if let Some(sink) = navigation_sink.as_ref() {
                    sink(BrowserPlatformEvent::ExternalProtocolRequested {
                        tab_id: navigation_tab_id.clone(),
                        url: url.to_string(),
                    });
                }
                false
            }
            BrowserNavigationPolicy::Denied => {
                if let Some(sink) = navigation_sink.as_ref() {
                    sink(BrowserPlatformEvent::PolicyDenied {
                        tab_id: navigation_tab_id.clone(),
                        url: url.to_string(),
                        reason_code: "navigation_scheme_denied".to_string(),
                    });
                }
                false
            }
        })
        .on_page_load(move |webview, payload| {
            let Some(sink) = page_sink.clone() else {
                return;
            };
            let tab_id = page_tab_id.clone();
            let url = payload.url().to_string();
            match payload.event() {
                PageLoadEvent::Started => {
                    sink(BrowserPlatformEvent::NavigationStarted { tab_id, url })
                }
                PageLoadEvent::Finished => {
                    let navigation_completion = page_navigation_completion.clone();
                    tauri::async_runtime::spawn(async move {
                        let (can_go_back, can_go_forward) =
                            navigation_state(&webview).await.unwrap_or((false, false));
                        sink(BrowserPlatformEvent::NavigationFinished {
                            tab_id,
                            url,
                            can_go_back,
                            can_go_forward,
                        });
                        navigation_completion.mark_completed();
                    });
                }
            }
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(sink) = title_sink.as_ref() {
                sink(BrowserPlatformEvent::TitleChanged {
                    tab_id: title_tab_id.clone(),
                    title,
                });
            }
        })
        .on_new_window(move |url, _features| {
            if let Some(sink) = popup_sink.as_ref() {
                let event = match navigation_policy(&url) {
                    BrowserNavigationPolicy::Embedded => BrowserPlatformEvent::PopupRequested {
                        tab_id: popup_tab_id.clone(),
                        url: url.to_string(),
                    },
                    BrowserNavigationPolicy::ExternalCandidate => {
                        BrowserPlatformEvent::ExternalProtocolRequested {
                            tab_id: popup_tab_id.clone(),
                            url: url.to_string(),
                        }
                    }
                    BrowserNavigationPolicy::Denied => BrowserPlatformEvent::PolicyDenied {
                        tab_id: popup_tab_id.clone(),
                        url: url.to_string(),
                        reason_code: "popup_scheme_denied".to_string(),
                    },
                };
                sink(event);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                if let Some(sink) = download_sink.as_ref() {
                    sink(BrowserPlatformEvent::DownloadBlocked {
                        tab_id: download_tab_id.clone(),
                        url: url.to_string(),
                    });
                }
            }
            false
        });
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| "The main desktop window is unavailable".to_string())?;
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|error| format!("Failed to create native browser WebView2 child: {error}"))?;
        webview
            .hide()
            .map_err(|error| format!("Failed to hide new native browser surface: {error}"))?;
        let event_sink = {
            self.event_sink
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        };
        register_webview2_events(&webview, tab_id.clone(), event_sink).await?;

        if let Err(error) = navigation_completion.wait_after(0).await {
            let _ = webview.close();
            return Err(error);
        }

        self.insert_tab(
            tab_id,
            BrowserTabHandle {
                webview,
                profile: request.profile,
                navigation: navigation_completion,
            },
        );
        Ok(BrowserPlatformTabState {
            url: url.to_string(),
            title: "New tab".to_string(),
            can_go_back: false,
            can_go_forward: false,
            viewport_width: 1,
            viewport_height: 1,
            device_scale: 1.0,
        })
    }

    async fn close_tab(&self, tab_id: &BrowserTabId) -> Result<(), String> {
        let Some(handle) = self.remove_tab(tab_id) else {
            return Ok(());
        };
        handle
            .webview
            .close()
            .map_err(|error| format!("Failed to close native browser tab {tab_id}: {error}"))
    }

    async fn set_surface(&self, surface: BrowserPlatformSurface) -> Result<(), String> {
        let handle = self.tab(&surface.tab_id)?;
        if surface.visible {
            handle
                .webview
                .set_position(LogicalPosition::new(surface.rect.x, surface.rect.y))
                .map_err(|error| format!("Failed to position native browser surface: {error}"))?;
            handle
                .webview
                .set_size(LogicalSize::new(surface.rect.width, surface.rect.height))
                .map_err(|error| format!("Failed to size native browser surface: {error}"))?;
            handle
                .webview
                .show()
                .map_err(|error| format!("Failed to show native browser surface: {error}"))?;
            handle
                .webview
                .set_focus()
                .map_err(|error| format!("Failed to focus native browser surface: {error}"))?;
        } else {
            handle
                .webview
                .hide()
                .map_err(|error| format!("Failed to hide native browser surface: {error}"))?;
        }
        Ok(())
    }

    async fn navigate(&self, tab_id: &BrowserTabId, url: &str) -> Result<(), String> {
        let url = safe_browser_url(url)?;
        let handle = self.tab(tab_id)?;
        let revision = handle.navigation.revision();
        handle
            .webview
            .navigate(url)
            .map_err(|error| format!("Failed to navigate native browser tab: {error}"))?;
        handle.navigation.wait_after(revision).await
    }

    async fn back(&self, tab_id: &BrowserTabId) -> Result<(), String> {
        let handle = self.tab(tab_id)?;
        if !navigation_state(&handle.webview).await?.0 {
            return Err("Native browser tab has no back navigation entry".to_string());
        }
        let revision = handle.navigation.revision();
        core_action(&handle.webview, "go back", |core| unsafe { core.GoBack() }).await?;
        handle.navigation.wait_after(revision).await
    }

    async fn forward(&self, tab_id: &BrowserTabId) -> Result<(), String> {
        let handle = self.tab(tab_id)?;
        if !navigation_state(&handle.webview).await?.1 {
            return Err("Native browser tab has no forward navigation entry".to_string());
        }
        let revision = handle.navigation.revision();
        core_action(&handle.webview, "go forward", |core| unsafe {
            core.GoForward()
        })
        .await?;
        handle.navigation.wait_after(revision).await
    }

    async fn reload(&self, tab_id: &BrowserTabId) -> Result<(), String> {
        let handle = self.tab(tab_id)?;
        let revision = handle.navigation.revision();
        core_action(&handle.webview, "reload", |core| unsafe { core.Reload() }).await?;
        handle.navigation.wait_after(revision).await
    }

    async fn stop(&self, tab_id: &BrowserTabId) -> Result<(), String> {
        core_action(&self.tab(tab_id)?.webview, "stop", |core| unsafe {
            core.Stop()
        })
        .await
    }

    async fn observe(
        &self,
        tab_id: &BrowserTabId,
        capture: bool,
        semantic: bool,
    ) -> Result<BrowserPlatformObservation, String> {
        let handle = self.tab(tab_id)?;
        let observed: ObservedDocument = eval_json(&handle.webview, OBSERVE_SCRIPT).await?;
        let capture_base64 = if capture {
            let result = call_cdp(
                &handle.webview,
                "Page.captureScreenshot",
                json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false }),
            )
            .await?;
            Some(
                result
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "WebView2 screenshot response omitted image data".to_string())?
                    .to_string(),
            )
        } else {
            None
        };
        Ok(BrowserPlatformObservation {
            capture_base64,
            viewport_width: observed.viewport_width,
            viewport_height: observed.viewport_height,
            device_scale: observed.device_scale,
            semantic_nodes: if semantic {
                observed
                    .nodes
                    .into_iter()
                    .take(MAX_SEMANTIC_NODES)
                    .map(Into::into)
                    .collect()
            } else {
                Vec::new()
            },
            semantic_truncated: semantic && observed.truncated,
        })
    }

    async fn interact(
        &self,
        tab_id: &BrowserTabId,
        action: BrowserPlatformAction,
    ) -> Result<(), String> {
        let handle = self.tab(tab_id)?;
        match action {
            BrowserPlatformAction::ClickSelector { selector } => {
                eval_unit(&handle.webview, &selector_action(&selector, "click", None)?).await
            }
            BrowserPlatformAction::FillSelector { selector, text } => {
                eval_unit(
                    &handle.webview,
                    &selector_action(&selector, "fill", Some(&text))?,
                )
                .await
            }
            BrowserPlatformAction::Browser(action) => {
                interact_browser_action(self, tab_id, &handle.webview, action).await
            }
            BrowserPlatformAction::UserRequired { .. } => {
                Err("Protected browser action was not handled by the session manager".to_string())
            }
        }
    }

    async fn open_external(&self, url: &str) -> Result<(), String> {
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|error| format!("Failed to open confirmed external protocol: {error}"))
    }

    async fn delete_profile(&self, profile: &BrowserPlatformProfile) -> Result<(), String> {
        ensure_profile_path(&self.profile_root, &profile.data_directory)?;
        let profile_in_use = self
            .tabs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .any(|tab| tab.profile.data_directory == profile.data_directory);
        if profile_in_use {
            return Err(format!(
                "Cannot delete browser profile {} while a tab still owns it",
                profile.profile_id
            ));
        }
        if profile.data_directory.exists() {
            tokio::fs::remove_dir_all(&profile.data_directory)
                .await
                .map_err(|error| format!("Failed to remove incognito browser profile: {error}"))?;
        }
        Ok(())
    }
}

async fn interact_browser_action(
    runtime: &WindowsBrowserRuntime,
    tab_id: &BrowserTabId,
    webview: &Webview<Wry>,
    action: BrowserAction,
) -> Result<(), String> {
    match action {
        BrowserAction::Navigate { url } => runtime.navigate(tab_id, &url).await,
        BrowserAction::Back => runtime.back(tab_id).await,
        BrowserAction::Forward => runtime.forward(tab_id).await,
        BrowserAction::Reload => runtime.reload(tab_id).await,
        BrowserAction::Stop => runtime.stop(tab_id).await,
        BrowserAction::Click { x, y } => {
            if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
                return Err("Browser click coordinates must be finite and non-negative".to_string());
            }
            eval_unit(
                webview,
                &format!(
                    "(() => {{ const e = document.elementFromPoint({x}, {y}); if (!e) throw new Error('No element at browser coordinates'); e.click(); return true; }})()"
                ),
            )
            .await
        }
        BrowserAction::Type { text } => {
            let text = serde_json::to_string(&text).map_err(|error| error.to_string())?;
            eval_unit(
                webview,
                &format!(r#"(() => {{ const e = document.activeElement; if (!e) throw new Error('No focused browser element'); if ('value' in e) {{ const start = e.selectionStart ?? e.value.length; const end = e.selectionEnd ?? start; e.value = e.value.slice(0,start) + {text} + e.value.slice(end); e.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: {text} }})); }} else if (e.isContentEditable) {{ document.execCommand('insertText', false, {text}); }} else {{ throw new Error('Focused browser element does not accept text'); }} return true; }})()"#),
            )
            .await
        }
        BrowserAction::Key { key } => {
            let key = serde_json::to_string(&key).map_err(|error| error.to_string())?;
            eval_unit(
                webview,
                &format!("(() => {{ const e = document.activeElement || document.body; e.dispatchEvent(new KeyboardEvent('keydown', {{ key: {key}, bubbles: true }})); e.dispatchEvent(new KeyboardEvent('keyup', {{ key: {key}, bubbles: true }})); return true; }})()"),
            )
            .await
        }
        BrowserAction::Scroll { delta_x, delta_y } => {
            if !delta_x.is_finite() || !delta_y.is_finite() {
                return Err("Browser scroll deltas must be finite".to_string());
            }
            eval_unit(
                webview,
                &format!("(() => {{ window.scrollBy({{ left: {delta_x}, top: {delta_y}, behavior: 'instant' }}); return true; }})()"),
            )
            .await
        }
        BrowserAction::Wait {
            text,
            target_ref: _,
            timeout_ms,
        } => {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms.min(15_000));
            let expected = text
                .map(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
                .transpose()?;
            loop {
                let script = if let Some(expected) = expected.as_ref() {
                    format!("document.body?.innerText?.includes({expected}) === true")
                } else {
                    "document.readyState === 'complete'".to_string()
                };
                if eval_json::<bool>(webview, &script).await.unwrap_or(false) {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err("Browser wait condition timed out".to_string());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        BrowserAction::ClickTarget { .. }
        | BrowserAction::Fill { .. }
        | BrowserAction::UserHandoff { .. }
        | BrowserAction::Resume => {
            Err("Browser action was not normalized by the session manager".to_string())
        }
    }
}

fn selector_action(selector: &str, kind: &str, text: Option<&str>) -> Result<String, String> {
    let selector = serde_json::to_string(selector).map_err(|error| error.to_string())?;
    match kind {
        "click" => Ok(format!("(() => {{ const e = document.querySelector({selector}); if (!e) throw new Error('Browser target not found'); e.click(); return true; }})()")),
        "fill" => {
            let text = serde_json::to_string(text.unwrap_or_default()).map_err(|error| error.to_string())?;
            Ok(format!(r#"(() => {{ const e = document.querySelector({selector}); if (!e) throw new Error('Browser target not found'); if (!('value' in e)) throw new Error('Browser target does not accept text'); e.focus(); e.value = {text}; e.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: null }})); e.dispatchEvent(new Event('change', {{ bubbles: true }})); return true; }})()"#))
        }
        _ => Err("Unsupported normalized browser selector action".to_string()),
    }
}

async fn eval_unit(webview: &Webview<Wry>, script: &str) -> Result<(), String> {
    let _: Value = eval_json(webview, script).await?;
    Ok(())
}

async fn eval_json<T: for<'de> Deserialize<'de>>(
    webview: &Webview<Wry>,
    script: &str,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    webview
        .eval_with_callback(script.to_string(), move |result| {
            if let Some(tx) = tx
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            {
                let _ = tx.send(result);
            }
        })
        .map_err(|error| format!("Failed to evaluate browser script: {error}"))?;
    let result = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Browser script evaluation timed out".to_string())?
        .map_err(|_| "Browser script result channel closed".to_string())?;
    serde_json::from_str(&result).map_err(|error| format!("Invalid browser script result: {error}"))
}

async fn call_cdp(webview: &Webview<Wry>, method: &str, params: Value) -> Result<Value, String> {
    let method = method.to_string();
    let method_for_call = method.clone();
    let params = params.to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<Result<String, String>>();
    let immediate_tx = tx.clone();
    webview
        .with_webview(move |platform| {
            let result = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .map_err(|error| error.to_string())
                    .and_then(|core| {
                        let callback_tx = tx.clone();
                        let callback = CallDevToolsProtocolMethodCompletedHandler::create(
                            Box::new(move |status, json| {
                                let value = status.map(|_| json).map_err(|error| error.to_string());
                                let _ = callback_tx.send(value);
                                Ok(())
                            }),
                        );
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from(method_for_call),
                            &HSTRING::from(params),
                            &callback,
                        )
                        .map_err(|error| error.to_string())
                    })
            };
            if let Err(error) = result {
                let _ = immediate_tx.send(Err(error));
            }
        })
        .map_err(|error| format!("Failed to schedule WebView2 CDP call: {error}"))?;
    let result = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .map_err(|_| format!("WebView2 CDP method {method} timed out"))?
        .ok_or_else(|| format!("WebView2 CDP method {method} result channel closed"))??;
    serde_json::from_str(&result)
        .map_err(|error| format!("Invalid WebView2 CDP response for {method}: {error}"))
}

async fn core_action<F>(webview: &Webview<Wry>, name: &str, action: F) -> Result<(), String>
where
    F: FnOnce(&ICoreWebView2) -> windows::core::Result<()> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let name = name.to_string();
    webview
        .with_webview(move |platform| {
            let result = unsafe { platform.controller().CoreWebView2() }
                .map_err(|error| error.to_string())
                .and_then(|core| action(&core).map_err(|error| error.to_string()));
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to schedule browser {name}: {error}"))?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| format!("Browser {name} timed out"))?
        .map_err(|_| format!("Browser {name} result channel closed"))?
}

async fn navigation_state(webview: &Webview<Wry>) -> Result<(bool, bool), String> {
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |platform| {
            let result = unsafe { platform.controller().CoreWebView2() }
                .map_err(|error| error.to_string())
                .and_then(|core| unsafe {
                    let mut back = windows::core::BOOL::default();
                    let mut forward = windows::core::BOOL::default();
                    core.CanGoBack(&mut back)
                        .map_err(|error| error.to_string())?;
                    core.CanGoForward(&mut forward)
                        .map_err(|error| error.to_string())?;
                    Ok((back.as_bool(), forward.as_bool()))
                });
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to query browser navigation state: {error}"))?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "Browser navigation-state query timed out".to_string())?
        .map_err(|_| "Browser navigation-state result channel closed".to_string())?
}

async fn register_webview2_events(
    webview: &Webview<Wry>,
    tab_id: BrowserTabId,
    sink: Option<BrowserPlatformEventSink>,
) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|error| error.to_string())?;
                let message_tab = tab_id.clone();
                let message_sink = sink.clone();
                let message_handler =
                    WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut raw = PWSTR::null();
                        if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_ok()
                            && webview2_com::take_pwstr(raw) == DIRECT_INPUT_MESSAGE
                        {
                            if let Some(sink) = message_sink.as_ref() {
                                sink(BrowserPlatformEvent::UserInput {
                                    tab_id: message_tab.clone(),
                                });
                            }
                        }
                        Ok(())
                    }));
                let mut message_token = 0;
                unsafe { core.add_WebMessageReceived(&message_handler, &mut message_token) }
                    .map_err(|error| error.to_string())?;

                let failed_tab = tab_id.clone();
                let failed_sink = sink.clone();
                let failed_handler =
                    ProcessFailedEventHandler::create(Box::new(move |_sender, _args| {
                        if let Some(sink) = failed_sink.as_ref() {
                            sink(BrowserPlatformEvent::RendererCrashed {
                                tab_id: failed_tab.clone(),
                                reason: "webview2_process_failed".to_string(),
                            });
                        }
                        Ok(())
                    }));
                let mut failed_token = 0;
                unsafe { core.add_ProcessFailed(&failed_handler, &mut failed_token) }
                    .map_err(|error| error.to_string())?;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to register WebView2 browser events: {error}"))?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "WebView2 event registration timed out".to_string())?
        .map_err(|_| "WebView2 event registration result channel closed".to_string())?
}

fn ensure_profile_path(root: &Path, candidate: &Path) -> Result<(), String> {
    if !root.is_absolute() || !candidate.is_absolute() || !candidate.starts_with(root) {
        return Err("Browser profile path escaped the configured profile root".to_string());
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Browser profile path contains a parent traversal".to_string());
    }
    Ok(())
}

fn safe_label(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservedDocument {
    viewport_width: u32,
    viewport_height: u32,
    device_scale: f64,
    truncated: bool,
    nodes: Vec<ObservedNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservedNode {
    selector: String,
    role: String,
    name: String,
    frame: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    disabled: bool,
    focused: bool,
    sensitive: bool,
    protected_reason: Option<String>,
}

impl From<ObservedNode> for BrowserPlatformSemanticNode {
    fn from(value: ObservedNode) -> Self {
        Self {
            selector: value.selector,
            role: value.role,
            name: value.name,
            frame: value.frame,
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
            disabled: value.disabled,
            focused: value.focused,
            sensitive: value.sensitive,
            protected_reason: value.protected_reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_paths_must_stay_under_root() {
        let root = PathBuf::from(r"C:\tinybot\browser-profiles");
        assert!(ensure_profile_path(&root, &root.join("profile-a")).is_ok());
        assert!(ensure_profile_path(&root, &PathBuf::from(r"C:\tinybot\outside")).is_err());
    }

    #[tokio::test]
    async fn navigation_completion_waits_for_a_new_finished_revision() {
        let completion = Arc::new(NavigationCompletion::default());
        let baseline = completion.revision();
        let waiter = tokio::spawn({
            let completion = completion.clone();
            async move { completion.wait_after(baseline).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        completion.mark_completed();
        waiter.await.unwrap().unwrap();
    }

    #[test]
    fn child_webview_labels_are_capability_isolated() {
        assert_eq!(safe_label("browser/tab:1"), "browser-tab-1");
    }

    #[test]
    fn injected_scripts_are_narrow_and_privacy_bounded() {
        assert!(DIRECT_INPUT_SCRIPT.contains("event.isTrusted"));
        assert!(DIRECT_INPUT_SCRIPT.contains(DIRECT_INPUT_MESSAGE));
        assert!(!DIRECT_INPUT_SCRIPT.contains("__TAURI__"));
        assert!(OBSERVE_SCRIPT.contains("const limit = 500"));
        assert!(OBSERVE_SCRIPT.contains("parts.length < 8"));
        assert!(OBSERVE_SCRIPT.contains("slice(0, 160)"));
        assert!(OBSERVE_SCRIPT.contains("inputType === 'password'"));
        assert!(OBSERVE_SCRIPT.contains("cc-|one-time-code"));
        assert!(OBSERVE_SCRIPT.contains("sensitive ? ''"));
    }
}
