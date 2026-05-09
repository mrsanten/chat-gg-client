use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    pub anthropic: AnthropicSettings,
    pub openai: OpenAiSettings,
    pub moonshot: MoonshotSettings,
    pub macros: Vec<Macro>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Macro {
    pub id: String,
    pub name: String,
    pub template: String,
    /// "action" (default) lub "session". Trzymamy jako string, żeby kompatybilność wsteczna była łatwa.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_send: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AnthropicAuth {
    None,
    ApiKey { api_key: String },
    ClaudeCode { binary_path: Option<String> },
}

impl Default for AnthropicAuth {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum OpenAiAuth {
    None,
    ApiKey { api_key: String },
}

impl Default for OpenAiAuth {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AnthropicSettings {
    pub auth: AnthropicAuth,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct OpenAiSettings {
    pub auth: OpenAiAuth,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum MoonshotAuth {
    None,
    ApiKey {
        api_key: String,
        #[serde(default)]
        base_url: Option<String>,
    },
}

impl Default for MoonshotAuth {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MoonshotSettings {
    pub auth: MoonshotAuth,
    pub model_id: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    let parsed: Settings = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;
    Ok(parsed)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| format!("ser: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("write: {e}"))?;
    Ok(())
}
