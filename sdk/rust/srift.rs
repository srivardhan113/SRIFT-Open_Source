//! SRIFT Rust SDK — sync + async client (uses `ureq` for sync, `reqwest` for async).
//!
//! Pick your features in Cargo.toml:
//!   [dependencies]
//!   srift = { version = "2", features = ["blocking"] }   # uses ureq
//!   # OR
//!   srift = { version = "2", features = ["async"] }      # uses reqwest + tokio
//!
//! Runs on: any target Rust supports — Linux, macOS, Windows, BSD, Wasm32-wasi,
//! embedded (no_std variant in `srift-no-std`), Tauri, Cloudflare Workers (with reqwest-wasm).
//!
//! Quick example:
//!   use srift::blocking::Srift;
//!   let s = Srift::new(None);
//!   let r = s.quick_share("/abs/path/file.zip", None).unwrap();
//!   println!("{}", r.share_url);

use serde::{Deserialize, Serialize};
use std::env;

const DEFAULT_BASE: &str = "http://127.0.0.1:3822";

#[derive(Debug, thiserror::Error)]
pub enum SriftError {
    #[error("daemon unreachable: {0}. Start it with: srift daemon start")]
    Unreachable(String),
    #[error("srift error: {0}")]
    Server(String),
    #[error("transport: {0}")]
    Transport(String),
}

#[derive(Debug, Deserialize)]
pub struct QuickShareResult {
    pub success: bool,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[serde(rename = "shareUrl")]
    pub share_url: String,
    pub protocol: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
}

#[derive(Debug, Deserialize)]
pub struct Transfer {
    #[serde(rename = "fileId")] pub file_id: String,
    pub name: String,
    pub size: u64,
    pub progress: f64,
    #[serde(rename = "speedKBps")] pub speed_kbps: f64,
    #[serde(rename = "etaSeconds")] pub eta_seconds: f64,
    pub protocol: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct Session {
    pub id: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
    #[serde(rename = "isConnected")] pub is_connected: bool,
}

#[derive(Debug, Deserialize)]
pub struct Status {
    pub session: Session,
    #[serde(rename = "activeTransfers", default)] pub active_transfers: Vec<Transfer>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    #[serde(rename = "messageId")] pub message_id: String,
    pub sender: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Serialize)]
struct QuickShareBody<'a> {
    #[serde(rename = "filePath")] file_path: &'a str,
    #[serde(rename = "sessionName", skip_serializing_if = "Option::is_none")] session_name: Option<&'a str>
}

#[derive(Serialize)]
struct SessionStartBody<'a> {
    #[serde(rename = "sessionName", skip_serializing_if = "Option::is_none")] session_name: Option<&'a str>,
    #[serde(rename = "roomSecret", skip_serializing_if = "Option::is_none")] room_secret: Option<&'a str>
}

#[derive(Serialize)]
struct SessionJoinBody<'a> {
    #[serde(rename = "sessionId")] session_id: &'a str,
    #[serde(rename = "username", skip_serializing_if = "Option::is_none")] username: Option<&'a str>,
    #[serde(rename = "roomSecret", skip_serializing_if = "Option::is_none")] room_secret: Option<&'a str>
}

pub fn base_url(provided: Option<&str>) -> String {
    let mut url = provided.map(String::from)
        .or_else(|| env::var("SRIFT_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());
    if url.ends_with('/') { url.pop(); }
    url
}

// ─── Sync client (feature = "blocking", uses ureq) ──────────────────────────
#[cfg(feature = "blocking")]
pub mod blocking {
    use super::*;

    pub struct Srift { base: String }

    impl Srift {
        pub fn new(base_url: Option<&str>) -> Self { Self { base: super::base_url(base_url) } }

        fn post<B: Serialize, R: for<'de> Deserialize<'de>>(&self, path: &str, body: &B) -> Result<R, SriftError> {
            let url = format!("{}{}", self.base, path);
            match ureq::post(&url).send_json(body) {
                Ok(resp) => resp.into_json().map_err(|e| SriftError::Transport(e.to_string())),
                Err(ureq::Error::Status(code, resp)) => {
                    let val: serde_json::Value = resp.into_json().unwrap_or_default();
                    let msg = val.get("error").and_then(|v| v.as_str())
                        .unwrap_or("unknown error").to_string();
                    Err(SriftError::Server(msg))
                }
                Err(e) => Err(SriftError::Unreachable(e.to_string())),
            }
        }

        fn get<R: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<R, SriftError> {
            let url = format!("{}{}", self.base, path);
            match ureq::get(&url).call() {
                Ok(resp) => resp.into_json().map_err(|e| SriftError::Transport(e.to_string())),
                Err(ureq::Error::Status(code, resp)) => {
                    let val: serde_json::Value = resp.into_json().unwrap_or_default();
                    let msg = val.get("error").and_then(|v| v.as_str())
                        .unwrap_or(&format!("HTTP {}", code)).to_string();
                    Err(SriftError::Server(msg))
                }
                Err(e) => Err(SriftError::Unreachable(e.to_string())),
            }
        }

        pub fn quick_share(&self, file_path: &str, session_name: Option<&str>) -> Result<QuickShareResult, SriftError> {
            self.post("/quick-share", &QuickShareBody { file_path, session_name })
        }
        pub fn status(&self) -> Result<Status, SriftError> { self.get("/status") }
        pub fn state(&self) -> Result<serde_json::Value, SriftError> { self.get("/state") }
        pub fn start_session(&self, name: Option<&str>, room_secret: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/start", &SessionStartBody { session_name: name, room_secret })
        }
        pub fn join_session(&self, session_id: &str, username: Option<&str>, room_secret: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/join", &SessionJoinBody { session_id, username, room_secret })
        }
        pub fn approve_join(&self, temp_user_id: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/session/approve", &serde_json::json!({ "tempUserId": temp_user_id }))
        }
        pub fn reject_join(&self, temp_user_id: &str, reason: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/reject", &serde_json::json!({ "tempUserId": temp_user_id, "reason": reason }))
        }
        pub fn kick_user(&self, user_id: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/session/kick", &serde_json::json!({ "userId": user_id }))
        }
        pub fn close_session(&self) -> Result<serde_json::Value, SriftError> {
            self.post("/session/close", &serde_json::json!({}))
        }
        pub fn send_file(&self, file_path: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/send", &serde_json::json!({ "filePath": file_path }))
        }
        pub fn accept_transfer(&self, file_id: &str, save_dir: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/receive", &serde_json::json!({ "fileId": file_id, "saveDir": save_dir }))
        }
        pub fn send_chat(&self, message: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/chat/send", &serde_json::json!({ "message": message }))
        }
        pub fn chat_history(&self) -> Result<Vec<ChatMessage>, SriftError> { self.get("/chat/history") }
        pub fn list_transfers(&self) -> Result<Vec<Transfer>, SriftError> {
            Ok(self.status()?.active_transfers)
        }
    }
}

// ─── Async client (feature = "async", uses reqwest) ─────────────────────────
#[cfg(feature = "async")]
pub mod r#async {
    use super::*;
    use reqwest::Client;

    pub struct Srift { base: String, http: Client }

    impl Srift {
        pub fn new(base_url: Option<&str>) -> Self {
            Self { base: super::base_url(base_url), http: Client::new() }
        }

        async fn post<B: Serialize, R: for<'de> Deserialize<'de>>(&self, path: &str, body: &B) -> Result<R, SriftError> {
            let r = self.http.post(format!("{}{}", self.base, path))
                .json(body)
                .send().await.map_err(|e| SriftError::Unreachable(e.to_string()))?;
            if !r.status().is_success() {
                let val: serde_json::Value = r.json().await.unwrap_or_default();
                let msg = val.get("error").and_then(|v| v.as_str())
                    .unwrap_or("unknown error").to_string();
                return Err(SriftError::Server(msg));
            }
            r.json().await.map_err(|e| SriftError::Transport(e.to_string()))
        }

        async fn get<R: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<R, SriftError> {
            let r = self.http.get(format!("{}{}", self.base, path))
                .send().await.map_err(|e| SriftError::Unreachable(e.to_string()))?;
            if !r.status().is_success() {
                let val: serde_json::Value = r.json().await.unwrap_or_default();
                let msg = val.get("error").and_then(|v| v.as_str())
                    .unwrap_or("unknown error").to_string();
                return Err(SriftError::Server(msg));
            }
            r.json().await.map_err(|e| SriftError::Transport(e.to_string()))
        }

        pub async fn quick_share(&self, file_path: &str, session_name: Option<&str>) -> Result<QuickShareResult, SriftError> {
            self.post("/quick-share", &QuickShareBody { file_path, session_name }).await
        }
        pub async fn status(&self) -> Result<Status, SriftError> { self.get("/status").await }
        pub async fn state(&self) -> Result<serde_json::Value, SriftError> { self.get("/state").await }
        pub async fn start_session(&self, name: Option<&str>, room_secret: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/start", &SessionStartBody { session_name: name, room_secret }).await
        }
        pub async fn join_session(&self, session_id: &str, username: Option<&str>, room_secret: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/join", &SessionJoinBody { session_id, username, room_secret }).await
        }
        pub async fn approve_join(&self, temp_user_id: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/session/approve", &serde_json::json!({ "tempUserId": temp_user_id })).await
        }
        pub async fn reject_join(&self, temp_user_id: &str, reason: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/session/reject", &serde_json::json!({ "tempUserId": temp_user_id, "reason": reason })).await
        }
        pub async fn kick_user(&self, user_id: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/session/kick", &serde_json::json!({ "userId": user_id })).await
        }
        pub async fn close_session(&self) -> Result<serde_json::Value, SriftError> {
            self.post("/session/close", &serde_json::json!({})).await
        }
        pub async fn send_file(&self, file_path: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/send", &serde_json::json!({ "filePath": file_path })).await
        }
        pub async fn accept_transfer(&self, file_id: &str, save_dir: Option<&str>) -> Result<serde_json::Value, SriftError> {
            self.post("/receive", &serde_json::json!({ "fileId": file_id, "saveDir": save_dir })).await
        }
        pub async fn send_chat(&self, message: &str) -> Result<serde_json::Value, SriftError> {
            self.post("/chat/send", &serde_json::json!({ "message": message })).await
        }
        pub async fn chat_history(&self) -> Result<Vec<ChatMessage>, SriftError> { self.get("/chat/history").await }
        pub async fn list_transfers(&self) -> Result<Vec<Transfer>, SriftError> {
            Ok(self.status().await?.active_transfers)
        }
    }
}
