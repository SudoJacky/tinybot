use axum::{
    extract::{Query, Request},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::net::SocketAddr;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

const ROOT_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>TinyBot browser fixture</title></head>
<body>
  <h1>Native browser fixture</h1>
  <nav>
    <a id="history-a" href="/history/a">History A</a>
    <a id="redirect" href="/redirect">Redirect</a>
    <a id="download" href="/download">Download</a>
    <a id="mailto" href="mailto:fixture@example.com">Mail</a>
    <a id="meeting" href="msteams://fixture">Meeting</a>
    <a id="file-scheme" href="file:///tinybot-fixture">File</a>
    <a id="javascript-scheme" href="javascript:void 0">JavaScript</a>
    <a id="data-scheme" href="data:text/plain,fixture">Data</a>
    <a id="tauri-scheme" href="tauri://fixture">Tauri</a>
  </nav>
  <form id="fixture-form">
    <label>Text <input id="text-input" autocomplete="off"></label>
    <label>Password <input id="password-input" type="password" autocomplete="current-password"></label>
    <label>Card <input id="card-input" inputmode="numeric" autocomplete="cc-number"></label>
    <label>OTP <input id="otp-input" inputmode="numeric" autocomplete="one-time-code"></label>
    <label>Upload <input id="file-input" type="file"></label>
  </form>
  <div id="captcha" role="group" aria-label="CAPTCHA verification" data-captcha="true">CAPTCHA</div>
  <button id="dynamic-button" type="button">Update dynamic text</button>
  <button id="popup-button" type="button">Open popup</button>
  <p id="dynamic-text" aria-live="polite">idle</p>
  <p id="key-output">no key</p>
  <p id="ipc-status" role="status">ipc-pending</p>
  <div style="height: 1400px"></div>
  <button id="scroll-target" type="button">Scroll target</button>
  <script>
    let updates = 0;
    document.querySelector('#dynamic-button').addEventListener('click', () => {
      document.querySelector('#dynamic-text').textContent = `updated-${++updates}`;
    });
    document.querySelector('#popup-button').addEventListener('click', () => {
      window.open('/popup', 'tinybot-fixture-popup');
    });
    document.querySelector('#text-input').addEventListener('keydown', event => {
      document.querySelector('#key-output').textContent = `key-${event.key}`;
    });
    document.body.dataset.tauriGlobal = String(typeof window.__TAURI__ !== 'undefined');
    document.body.dataset.tauriInternals = String(typeof window.__TAURI_INTERNALS__ !== 'undefined');
    document.body.dataset.tinybotIpc = String(typeof window.__TINYBOT__ !== 'undefined');
    const publishIpcStatus = invocation => {
      document.querySelector('#ipc-status').textContent = [
        `global-${document.body.dataset.tauriGlobal}`,
        `internals-${document.body.dataset.tauriInternals}`,
        `invoke-${invocation}`,
        `tinybot-${document.body.dataset.tinybotIpc}`
      ].join(';');
    };
    if (window.__TAURI_INTERNALS__?.invoke) {
      window.__TAURI_INTERNALS__.invoke('native_browser_integration_probe')
        .then(() => publishIpcStatus('allowed'))
        .catch(() => publishIpcStatus('denied'));
    } else {
      publishIpcStatus('unavailable');
    }
  </script>
</body>
</html>"#;

const STATE_HTML: &str = r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture state</title></head>
<body>
  <p id="cookie-state"></p>
  <p id="local-state"></p>
  <p id="session-state"></p>
  <script>
    const localKey = 'tinybot-fixture-local';
    const sessionKey = 'tinybot-fixture-session';
    localStorage.setItem(localKey, String(Number(localStorage.getItem(localKey) || '0') + 1));
    sessionStorage.setItem(sessionKey, String(Number(sessionStorage.getItem(sessionKey) || '0') + 1));
    document.querySelector('#cookie-state').textContent = document.cookie || 'no-cookie';
    document.querySelector('#local-state').textContent = localStorage.getItem(localKey);
    document.querySelector('#session-state').textContent = sessionStorage.getItem(sessionKey);
  </script>
</body>
</html>"#;

pub(crate) struct NativeBrowserFixture {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

impl NativeBrowserFixture {
    pub(crate) async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Failed to bind native browser fixture: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Failed to read native browser fixture address: {error}"))?;
        let (shutdown, shutdown_rx) = oneshot::channel();
        eprintln!("[native-browser-fixture] listening on http://{address}");
        let task = tokio::spawn(async move {
            axum::serve(listener, fixture_router())
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .map_err(|error| format!("Native browser fixture server failed: {error}"))
        });
        Ok(Self {
            address,
            shutdown: Some(shutdown),
            task: Some(task),
        })
    }

    pub(crate) fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url(), normalized_path(path))
    }

    pub(crate) async fn close(mut self) -> Result<(), String> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let Some(task) = self.task.take() else {
            return Ok(());
        };
        task.await
            .map_err(|error| format!("Native browser fixture task failed: {error}"))?
    }
}

impl Drop for NativeBrowserFixture {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn fixture_router() -> Router {
    Router::new()
        .route("/", get(|| async { Html(ROOT_HTML) }))
        .route(
            "/history/a",
            get(|| async { history_page("A", "/history/b") }),
        )
        .route(
            "/history/b",
            get(|| async { history_page("B", "/history/a") }),
        )
        .route(
            "/redirect",
            get(|| async { Redirect::temporary("/history/b") }),
        )
        .route(
            "/popup",
            get(|| async { Html("<title>Fixture popup</title><h1>Popup</h1>") }),
        )
        .route("/cookie/set", get(set_cookie))
        .route("/cookie/read", get(|| async { Html(STATE_HTML) }))
        .route("/state", get(|| async { Html(STATE_HTML) }))
        .route("/slow", get(slow_page))
        .route("/race", get(race_page))
        .route("/download", get(download))
        .layer(middleware::from_fn(log_request))
}

fn history_page(name: &str, next: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><title>History {name}</title><h1 id=history-page>History {name}</h1><a id=history-next href=\"{next}\">Next</a>"
    ))
}

async fn set_cookie() -> impl IntoResponse {
    (
        [(
            header::SET_COOKIE,
            HeaderValue::from_static("tinybot_fixture=shared; Path=/; SameSite=Lax"),
        )],
        Html("<title>Cookie set</title><h1>Cookie set</h1><a href=\"/cookie/read\">Read</a>"),
    )
}

#[derive(Deserialize)]
struct SlowQuery {
    ms: Option<u64>,
}

async fn slow_page(Query(query): Query<SlowQuery>) -> Html<String> {
    let delay_ms = query.ms.unwrap_or(250).min(30_000);
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    Html(format!(
        "<title>Slow fixture</title><h1 id=slow-complete>slow-{delay_ms}</h1>"
    ))
}

#[derive(Deserialize)]
struct RaceQuery {
    target: Option<String>,
    delay: Option<u64>,
}

async fn race_page(Query(query): Query<RaceQuery>) -> Html<String> {
    let target = match query.target.as_deref() {
        Some("a") => "/history/a",
        _ => "/history/b",
    };
    let delay_ms = query.delay.unwrap_or(50).min(5_000);
    Html(format!(
        "<!doctype html><title>Navigation race</title><h1>Navigation race</h1><script>setTimeout(() => location.href = '{target}', {delay_ms});</script>"
    ))
}

async fn download() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"tinybot-fixture.txt\"",
            ),
        ],
        "native-browser-fixture-download",
    )
}

async fn log_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let response = next.run(request).await;
    eprintln!(
        "[native-browser-fixture] {method} {uri} -> {}",
        response.status()
    );
    response
}

fn normalized_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn fixture_owns_a_random_port_and_serves_browser_scenarios() {
        let fixture = NativeBrowserFixture::start().await.unwrap();
        let second = NativeBrowserFixture::start().await.unwrap();

        assert_ne!(fixture.address, second.address);
        assert!(fixture.url("/").starts_with("http://127.0.0.1:"));

        let root = get(&fixture, "/").await;
        assert!(root.contains("200 OK"));
        assert!(root.contains("autocomplete=\"current-password\""));
        assert!(root.contains("autocomplete=\"cc-number\""));
        assert!(root.contains("autocomplete=\"one-time-code\""));
        assert!(root.contains("window.open('/popup'"));
        assert!(root.contains("tauri://fixture"));

        let redirect = get(&fixture, "/redirect").await;
        assert!(redirect.contains("307 Temporary Redirect"));
        assert!(redirect
            .to_ascii_lowercase()
            .contains("location: /history/b"));

        let cookie = get(&fixture, "/cookie/set").await;
        assert!(cookie
            .to_ascii_lowercase()
            .contains("set-cookie: tinybot_fixture=shared"));

        let download = get(&fixture, "/download").await;
        assert!(download.contains("attachment; filename=\"tinybot-fixture.txt\""));
        assert!(download.ends_with("native-browser-fixture-download"));

        second.close().await.unwrap();
        fixture.close().await.unwrap();
    }

    async fn get(fixture: &NativeBrowserFixture, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(fixture.address)
            .await
            .unwrap();
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                    fixture.address
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }
}
