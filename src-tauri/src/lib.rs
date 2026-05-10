mod chat;
mod mls;
mod sessions;
mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 wymaga jawnej rejestracji default crypto providera w
    // procesie. Na desktopie zwykle łapie się automatycznie, ale na iOS
    // pierwszy TLS call (z reqwest 0.13 w plugin-updater itp.) panicuje
    // „No provider set". Robimy to TUTAJ, zanim jakikolwiek plugin wystartuje.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Updater i process plugin tylko na desktopie. Apple/Google nie
    // pozwalają na self-update, a relaunch() jest disabled na iOS.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
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
