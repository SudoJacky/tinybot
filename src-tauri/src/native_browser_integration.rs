fn main() {
    if let Err(error) = tinybot_desktop_lib::run_native_browser_integration() {
        eprintln!("native browser integration failed: {error}");
        std::process::exit(1);
    }
}
