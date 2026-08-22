pub(crate) const DESKTOP_PET_WINDOW_LABEL: &str = "desktop-pet";
pub(crate) const DESKTOP_PET_CLOSE_REQUESTED_EVENT: &str = "desktop-pet-close-requested";

#[cfg(windows)]
pub(crate) fn create_desktop_pet_window(app: &mut tauri::App) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app,
        DESKTOP_PET_WINDOW_LABEL,
        tauri::WebviewUrl::App("index.html?surface=desktop-pet".into()),
    )
    .title("Tinybot Desktop Pet")
    .inner_size(76.0, 76.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .disable_drag_drop_handler()
    .build()?;
    eprintln!("desktop_pet_window_created visible=false");
    Ok(())
}

pub(crate) fn is_desktop_pet_window(label: &str) -> bool {
    label == DESKTOP_PET_WINDOW_LABEL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_desktop_pet_window_label() {
        assert!(is_desktop_pet_window("desktop-pet"));
        assert!(!is_desktop_pet_window("main"));
        assert!(!is_desktop_pet_window("desktop-pet-preview"));
    }
}
