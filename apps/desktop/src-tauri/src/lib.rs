use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        // Updates. The updater checks a signed manifest and refuses anything
        // not signed by the key in tauri.conf.json, so a compromised download
        // host still cannot ship the operator a modified binary.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The process plugin is what lets the app relaunch itself once an
        // update is installed. Without it the update lands and the operator
        // has to close and reopen the app to be running it.
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running Toreroflow");
}
