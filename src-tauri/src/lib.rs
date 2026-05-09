mod chat;
mod sessions;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            chat::chat_stream,
            sessions::list_sessions,
            sessions::load_session,
            sessions::save_session,
            sessions::delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
