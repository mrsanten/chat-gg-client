use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredImage {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: String,
    #[serde(default)]
    pub errored: bool,
    #[serde(default)]
    pub images: Vec<StoredImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    pub messages: Vec<StoredMessage>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SessionsFile {
    #[serde(default)]
    sessions: HashMap<String, ChatSession>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(rename = "messageCount")]
    pub message_count: usize,
}

fn sessions_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("sessions.json"))
}

fn read_file(app: &AppHandle) -> Result<SessionsFile, String> {
    let path = sessions_path(app)?;
    if !path.exists() {
        return Ok(SessionsFile::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))
}

fn write_file(app: &AppHandle, file: &SessionsFile) -> Result<(), String> {
    let path = sessions_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(file).map_err(|e| format!("ser: {e}"))?;
    std::fs::write(&tmp, raw).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_sessions(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let file = read_file(&app)?;
    let mut metas: Vec<SessionMeta> = file
        .sessions
        .into_values()
        .map(|s| SessionMeta {
            id: s.id,
            model_id: s.model_id,
            title: s.title,
            created_at: s.created_at,
            updated_at: s.updated_at,
            message_count: s.messages.len(),
        })
        .collect();
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

#[tauri::command]
pub fn load_session(app: AppHandle, id: String) -> Result<Option<ChatSession>, String> {
    let file = read_file(&app)?;
    Ok(file.sessions.get(&id).cloned())
}

#[tauri::command]
pub fn save_session(app: AppHandle, session: ChatSession) -> Result<(), String> {
    let mut file = read_file(&app).unwrap_or_default();
    file.sessions.insert(session.id.clone(), session);
    write_file(&app, &file)
}

#[tauri::command]
pub fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    let mut file = read_file(&app).unwrap_or_default();
    file.sessions.remove(&id);
    write_file(&app, &file)
}
