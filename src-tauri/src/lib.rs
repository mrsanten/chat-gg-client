mod chat;
mod mls;
mod sessions;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            chat::chat_stream,
            sessions::list_sessions,
            sessions::load_session,
            sessions::save_session,
            sessions::delete_session,
            mls::mls_init,
            mls::mls_generate_key_packages,
            mls::mls_create_group_with_peer,
            mls::mls_process_welcome,
            mls::mls_encrypt,
            mls::mls_decrypt,
            mls::mls_list_groups,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
