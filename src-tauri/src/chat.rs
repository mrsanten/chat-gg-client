use crate::settings::{AnthropicAuth, MoonshotAuth, OpenAiAuth};

const SYSTEM_PROMPT: &str =
    "Odpowiadaj w tym samym języku, w którym pisze użytkownik. Jeśli użytkownik pisze po polsku, odpowiadaj po polsku. Jeśli po angielsku, po angielsku. Nigdy nie mieszaj dwóch języków w jednej odpowiedzi.";
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{ipc::Channel, AppHandle};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use std::process::Stdio;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
}

fn anthropic_content(msg: &ChatMessageDto) -> serde_json::Value {
    if msg.images.is_empty() {
        return json!(msg.content);
    }
    let mut blocks: Vec<serde_json::Value> = msg
        .images
        .iter()
        .map(|img| {
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.mime_type,
                    "data": img.base64,
                },
            })
        })
        .collect();
    if !msg.content.is_empty() {
        blocks.push(json!({ "type": "text", "text": msg.content }));
    }
    json!(blocks)
}

fn openai_content(msg: &ChatMessageDto) -> serde_json::Value {
    if msg.images.is_empty() {
        return json!(msg.content);
    }
    let mut parts: Vec<serde_json::Value> = Vec::new();
    if !msg.content.is_empty() {
        parts.push(json!({ "type": "text", "text": msg.content }));
    }
    for img in &msg.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{};base64,{}", img.mime_type, img.base64),
            },
        }));
    }
    json!(parts)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatProviderRequest {
    Anthropic { model: String },
    OpenAi { model: String },
    Moonshot { model: String },
    ClaudeCode { model: String },
    Codex { model: String },
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

async fn run_anthropic(
    api_key: &str,
    model: &str,
    history: Vec<ChatMessageDto>,
    channel: Channel<StreamEvent>,
) -> anyhow::Result<()> {
    let body = json!({
        "model": model,
        "max_tokens": 2048,
        "stream": true,
        "system": SYSTEM_PROMPT,
        "messages": history.iter().map(|m| json!({
            "role": m.role,
            "content": anthropic_content(m),
        })).collect::<Vec<_>>(),
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Anthropic API {}: {}", status, text);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        loop {
            let Some(idx) = buf.find("\n\n") else { break };
            let event = buf[..idx].to_string();
            buf.drain(..idx + 2);

            for line in event.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    if rest.trim() == "[DONE]" {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                        if v.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                            if let Some(text) = v
                                .get("delta")
                                .and_then(|d| d.get("text"))
                                .and_then(|t| t.as_str())
                            {
                                let _ = channel.send(StreamEvent::Delta {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

async fn run_openai_compat(
    label: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    history: Vec<ChatMessageDto>,
    channel: Channel<StreamEvent>,
) -> anyhow::Result<()> {
    let mut messages: Vec<serde_json::Value> = vec![json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    })];
    messages.extend(history.iter().map(|m| json!({
        "role": m.role,
        "content": openai_content(m),
    })));
    let body = json!({
        "model": model,
        "stream": true,
        "messages": messages,
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("{} API {}: {}", label, status, text);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        loop {
            let Some(idx) = buf.find("\n\n") else { break };
            let event = buf[..idx].to_string();
            buf.drain(..idx + 2);

            for line in event.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    if rest.trim() == "[DONE]" {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                        if let Some(text) = v
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|t| t.as_str())
                        {
                            let _ = channel.send(StreamEvent::Delta {
                                text: text.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

async fn run_claude_code(
    binary_path: Option<&str>,
    model: &str,
    history: Vec<ChatMessageDto>,
    channel: Channel<StreamEvent>,
) -> anyhow::Result<()> {
    let bin = binary_path.unwrap_or("claude");

    let last_user = history
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .ok_or_else(|| anyhow::anyhow!("no user message"))?;

    if !last_user.images.is_empty() {
        anyhow::bail!(
            "Tryb subskrypcji (Claude Code) nie obsługuje obrazków w tej apce. Przełącz Anthropic na 'API key' w Ustawieniach żeby wysyłać obrazki."
        );
    }

    let mut cmd = Command::new(bin);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--model")
        .arg(model)
        .arg("--append-system-prompt")
        .arg(SYSTEM_PROMPT)
        .arg(&last_user.content)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn()
        .map_err(|e| anyhow::anyhow!("nie udało się uruchomić '{}': {}. Czy Claude Code jest zainstalowane i w PATH?", bin, e))?;

    let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("brak stdout"))?;
    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut got_delta = false;
    let mut final_assistant_text: Option<String> = None;

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if kind == "stream_event" {
            let Some(evt) = v.get("event") else { continue };
            let evt_type = evt.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if evt_type == "content_block_delta" {
                if let Some(text) = evt
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    got_delta = true;
                    let _ = channel.send(StreamEvent::Delta { text: text.to_string() });
                }
            }
        } else if kind == "assistant" {
            if let Some(content) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                let mut buf = String::new();
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            buf.push_str(text);
                        }
                    }
                }
                if !buf.is_empty() {
                    final_assistant_text = Some(buf);
                }
            }
        }
    }

    if !got_delta {
        if let Some(text) = final_assistant_text {
            let _ = channel.send(StreamEvent::Delta { text });
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        anyhow::bail!("claude exited with status {}", status);
    }
    Ok(())
}

/// Subskrypcja ChatGPT przez OpenAI Codex CLI.
///
/// Wymaga zainstalowanego `codex` (`npm i -g @openai/codex`) i zalogowania
/// (`codex login`, otwiera browser do ChatGPT). Po loginie sesja jest
/// zapisana w `~/.codex/`.
///
/// Używamy trybu `codex exec --json`, który drukuje JSONL ze zdarzeniami.
/// Parser jest defensywny: akceptuje kilka wariantów nazw pól, bo Codex CLI
/// wciąż zmienia API.
async fn run_codex(
    binary_path: Option<&str>,
    model: &str,
    history: Vec<ChatMessageDto>,
    channel: Channel<StreamEvent>,
) -> anyhow::Result<()> {
    let bin = binary_path.unwrap_or("codex");

    let last_user = history
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .ok_or_else(|| anyhow::anyhow!("no user message"))?;

    if !last_user.images.is_empty() {
        anyhow::bail!(
            "Tryb subskrypcji (Codex CLI) nie obsługuje obrazków w tej apce. Przełącz OpenAI na 'API key' w Ustawieniach żeby wysyłać obrazki."
        );
    }

    let mut cmd = Command::new(bin);
    cmd.arg("exec")
        .arg("--json")
        .arg("--skip-git-repo-check")
        .arg("--model")
        .arg(model)
        .arg(&last_user.content)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!(
            "nie udało się uruchomić '{}': {}. Czy Codex CLI jest zainstalowane (`npm i -g @openai/codex`) i w PATH?",
            bin,
            e
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("brak stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("brak stderr"))?;

    let mut reader = tokio::io::BufReader::new(stdout).lines();

    let mut got_delta = false;
    let mut final_assistant_text: Option<String> = None;
    let mut saw_json = false;

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            // Niejson — w starszych wersjach Codex CLI exec drukuje czysty
            // tekst odpowiedzi. Traktujemy całą linię jako część finalnego
            // tekstu, jeśli nie widzieliśmy jeszcze żadnego JSON-a.
            if !saw_json {
                final_assistant_text
                    .get_or_insert_with(String::new)
                    .push_str(trimmed);
                final_assistant_text.as_mut().unwrap().push('\n');
            }
            continue;
        };
        saw_json = true;

        // Codex CLI zmienia nazwy w wydaniach. Próbujemy kilku wariantów.
        let kind = v
            .get("type")
            .and_then(|t| t.as_str())
            .or_else(|| v.get("msg").and_then(|m| m.get("type")).and_then(|t| t.as_str()))
            .unwrap_or("");

        // Lokalizacja payloadu: część wersji opakowuje w `msg`/`event`/`payload`.
        let payload = v
            .get("msg")
            .or_else(|| v.get("event"))
            .or_else(|| v.get("payload"))
            .unwrap_or(&v);

        match kind {
            "agent_message_delta" | "message_delta" | "delta" => {
                if let Some(text) = payload
                    .get("delta")
                    .and_then(|t| t.as_str())
                    .or_else(|| payload.get("content").and_then(|t| t.as_str()))
                    .or_else(|| payload.get("text").and_then(|t| t.as_str()))
                {
                    got_delta = true;
                    let _ = channel.send(StreamEvent::Delta {
                        text: text.to_string(),
                    });
                }
            }
            "agent_message" | "message" | "agent_response" => {
                if let Some(text) = payload
                    .get("message")
                    .and_then(|t| t.as_str())
                    .or_else(|| payload.get("content").and_then(|t| t.as_str()))
                    .or_else(|| payload.get("text").and_then(|t| t.as_str()))
                {
                    final_assistant_text = Some(text.to_string());
                }
            }
            "task_complete" | "task_finished" | "done" | "completed" => {
                break;
            }
            "error" | "task_failed" => {
                let msg = payload
                    .get("message")
                    .and_then(|t| t.as_str())
                    .or_else(|| payload.get("error").and_then(|t| t.as_str()))
                    .unwrap_or("nieznany błąd Codex CLI");
                anyhow::bail!("codex error: {msg}");
            }
            _ => {}
        }
    }

    if !got_delta {
        if let Some(text) = final_assistant_text {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                let _ = channel.send(StreamEvent::Delta {
                    text: trimmed.to_string(),
                });
            }
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        // Złap stderr, żeby przekazać sensowny błąd userowi.
        let mut stderr_lines = tokio::io::BufReader::new(stderr).lines();
        let mut err_buf = String::new();
        while let Ok(Some(line)) = stderr_lines.next_line().await {
            err_buf.push_str(&line);
            err_buf.push('\n');
            if err_buf.len() > 2048 {
                break;
            }
        }
        let trimmed = err_buf.trim();
        let detail = if trimmed.is_empty() {
            String::new()
        } else {
            format!(": {trimmed}")
        };
        anyhow::bail!("codex exited with status {status}{detail}");
    }
    Ok(())
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    request: ChatProviderRequest,
    history: Vec<ChatMessageDto>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let settings = crate::settings::load_settings(app).unwrap_or_default();

    let result = match request {
        ChatProviderRequest::Anthropic { model } => match settings.anthropic.auth {
            AnthropicAuth::ApiKey { api_key } if !api_key.is_empty() => {
                run_anthropic(&api_key, &model, history, on_event.clone()).await
            }
            AnthropicAuth::ApiKey { .. } => Err(anyhow::anyhow!(
                "Anthropic API key jest pusty. Otwórz Ustawienia i wklej klucz."
            )),
            AnthropicAuth::ClaudeCode { .. } => Err(anyhow::anyhow!(
                "Anthropic ustawiony na Claude Code: użyj kind=claude_code"
            )),
            AnthropicAuth::None => Err(anyhow::anyhow!(
                "Brak konfiguracji Anthropic. Otwórz Ustawienia."
            )),
        },
        ChatProviderRequest::OpenAi { model } => match settings.openai.auth {
            OpenAiAuth::ApiKey { api_key } if !api_key.is_empty() => {
                run_openai_compat(
                    "OpenAI",
                    "https://api.openai.com/v1",
                    &api_key,
                    &model,
                    history,
                    on_event.clone(),
                )
                .await
            }
            OpenAiAuth::ApiKey { .. } => Err(anyhow::anyhow!(
                "OpenAI API key jest pusty. Otwórz Ustawienia i wklej klucz."
            )),
            OpenAiAuth::Codex { .. } => Err(anyhow::anyhow!(
                "OpenAI ustawiony na Codex CLI: użyj kind=codex"
            )),
            OpenAiAuth::None => Err(anyhow::anyhow!(
                "Brak konfiguracji OpenAI. Otwórz Ustawienia."
            )),
        },
        ChatProviderRequest::Moonshot { model } => match settings.moonshot.auth {
            MoonshotAuth::ApiKey { api_key, base_url } if !api_key.is_empty() => {
                let base = base_url.unwrap_or_else(|| "https://api.moonshot.ai/v1".to_string());
                run_openai_compat("Moonshot", &base, &api_key, &model, history, on_event.clone())
                    .await
            }
            MoonshotAuth::ApiKey { .. } => Err(anyhow::anyhow!(
                "Moonshot API key jest pusty. Otwórz Ustawienia i wklej klucz."
            )),
            MoonshotAuth::None => Err(anyhow::anyhow!(
                "Brak konfiguracji Moonshot (Kimi). Otwórz Ustawienia."
            )),
        },
        ChatProviderRequest::ClaudeCode { model } => match settings.anthropic.auth {
            AnthropicAuth::ClaudeCode { binary_path } => {
                run_claude_code(binary_path.as_deref(), &model, history, on_event.clone()).await
            }
            _ => Err(anyhow::anyhow!(
                "Tryb Claude Code nie jest aktywny. W Ustawieniach wybierz 'Subskrypcja (Claude Code)'."
            )),
        },
        ChatProviderRequest::Codex { model } => match settings.openai.auth {
            OpenAiAuth::Codex { binary_path } => {
                run_codex(binary_path.as_deref(), &model, history, on_event.clone()).await
            }
            _ => Err(anyhow::anyhow!(
                "Tryb Codex CLI nie jest aktywny. W Ustawieniach wybierz 'Subskrypcja (Codex CLI)'."
            )),
        },
    };

    match result {
        Ok(_) => {
            let _ = on_event.send(StreamEvent::Done);
            Ok(())
        }
        Err(e) => {
            let _ = on_event.send(StreamEvent::Error {
                message: e.to_string(),
            });
            Err(e.to_string())
        }
    }
}
