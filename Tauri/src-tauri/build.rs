fn main() {
    // Declaring the app's own commands puts them behind the capability system:
    // a command is callable only where `capabilities/` grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "session_token",
            "set_session_token",
            "clear_session_token",
            "take_openrouter_code",
            "release_window",
        ]),
    ))
    .expect("failed to run tauri-build");
}
