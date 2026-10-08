/// Desktop shell for SpriteStrack. The editor itself is the web app in `../src`;
/// the plugins give it native save dialogs, file writing and opening links in
/// the system browser.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running SpriteStrack");
}
