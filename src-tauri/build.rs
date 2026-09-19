include!("app_commands.rs");

fn main() {
    println!(
        "cargo:rustc-env=TINYBOT_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("Cargo must provide TARGET")
    );
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=app_commands.rs");
    println!("cargo:rerun-if-changed=permissions");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tinybot's Tauri application manifest")
}
