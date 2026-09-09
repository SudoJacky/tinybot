use super::model::{BrowserSessionId, BrowserTabId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum AnnotationAction {
    Start,
    Poll,
    Stop,
    Clear,
    Capture,
    Overlay {
        rect: Option<super::model::BrowserSurfaceRect>,
    },
    #[serde(rename_all = "camelCase")]
    Preview {
        document_id: String,
        selection_id: u64,
        property: String,
        value: String,
    },
    #[serde(rename_all = "camelCase")]
    Parent {
        document_id: String,
        selection_id: u64,
        index: u8,
    },
    #[serde(rename_all = "camelCase")]
    Reset {
        document_id: String,
        selection_id: u64,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAnnotationInput {
    pub browser_session_id: BrowserSessionId,
    pub tab_id: BrowserTabId,
    pub action: AnnotationAction,
}

pub(crate) fn validate_action(action: &AnnotationAction) -> Result<(), String> {
    match action {
        AnnotationAction::Overlay { rect: Some(rect) } => {
            rect.validate()?;
            if (rect.x + rect.width) * rect.device_scale > 32767.0
                || (rect.y + rect.height) * rect.device_scale > 32767.0
            {
                return Err("Annotation overlay exceeds native window bounds".to_string());
            }
        }
        AnnotationAction::Preview {
            property, value, ..
        } => {
            if ![
                "text",
                "color",
                "background-color",
                "font-size",
                "font-weight",
                "width",
                "height",
                "padding",
                "margin",
                "border-radius",
                "opacity",
            ]
            .contains(&property.as_str())
                || value.len() > 8000
            {
                return Err("Unsupported annotation property or value".to_string());
            }
        }
        AnnotationAction::Parent { index, .. } if *index > 7 => {
            return Err("Invalid annotation parent index".to_string())
        }
        _ => {}
    }
    Ok(())
}
