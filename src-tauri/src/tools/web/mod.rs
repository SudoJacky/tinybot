mod agent;
mod browser;
mod registry;

pub(crate) use agent::{dispatch_web_act, dispatch_web_open, dispatch_web_read};
#[cfg(test)]
pub(crate) use browser::{dispatch_browser_interact, dispatch_browser_observe};
pub(crate) use browser::{strip_browser_capture_data, WebToolCancellation};
pub(crate) use registry::WebToolContributor;

pub(crate) fn is_web_tool(method: &str) -> bool {
    matches!(method, "web.open" | "web.read" | "web.act")
}
