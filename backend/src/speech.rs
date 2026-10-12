use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};

pub const SAMPLE_RATE: u32 = 24_000;
const BYTES_PER_SECOND: f64 = SAMPLE_RATE as f64 * 2.;
const WORDS_PER_SECOND: f64 = 2.5;
const MAX_STREAM_BYTES: u64 = 2_000_000_000;

pub fn estimated_seconds(text: &str) -> f64 {
    (text.split_whitespace().count() as f64 / WORDS_PER_SECOND).max(0.5)
}

pub fn seconds(bytes: usize) -> f64 {
    bytes as f64 / BYTES_PER_SECOND
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(3)))
            .timeout_global(timeout)
            .http_status_as_error(false)
            .build(),
    )
}

fn unavailable(url: &str) -> anyhow::Error {
    anyhow::anyhow!(crate::i18n::formatted_message(
        "error.speechUnavailable",
        &[("url", url.into())]
    ))
}

fn check_status(status: u16, body: &str) -> Result<()> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value["detail"]["message"]
                .as_str()
                .or(value["detail"].as_str())
                .or(value["error"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| status.to_string());
    bail!(crate::i18n::formatted_message(
        "error.speechFailed",
        &[("detail", detail)]
    ))
}

pub fn parse_voices(body: &str) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(body)?;
    let voices: Vec<String> = value["voices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|voice| {
            voice
                .as_str()
                .or(voice["id"].as_str())
                .or(voice["name"].as_str())
                .map(str::to_owned)
        })
        .collect();
    if voices.is_empty() {
        bail!(crate::i18n::formatted_message(
            "error.speechFailed",
            &[("detail", "voices".into())]
        ));
    }
    Ok(voices)
}

pub fn voices(url: &str) -> Result<Vec<String>> {
    let mut response = agent(Some(Duration::from_secs(5)))
        .get(format!("{url}/v1/audio/voices"))
        .call()
        .map_err(|_| unavailable(url))?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|_| unavailable(url))?;
    check_status(response.status().as_u16(), &body)?;
    parse_voices(&body)
}

pub fn stream(
    url: &str,
    text: &str,
    voice: &str,
    mut chunk: impl FnMut(&[u8]) -> bool,
) -> Result<bool> {
    let request = json!({
        "model": "kokoro",
        "input": text,
        "voice": voice,
        "response_format": "pcm",
        "stream": true,
        "speed": 1.0
    });
    let response = agent(None)
        .post(format!("{url}/v1/audio/speech"))
        .header("Content-Type", "application/json")
        .send(serde_json::to_vec(&request)?.as_slice())
        .map_err(|_| unavailable(url))?;
    let status = response.status().as_u16();
    let mut reader = response
        .into_body()
        .into_with_config()
        .limit(MAX_STREAM_BYTES)
        .reader();
    if !(200..300).contains(&status) {
        let mut body = String::new();
        let _ = reader.read_to_string(&mut body);
        check_status(status, &body)?;
    }
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|_| unavailable(url))?;
        if read == 0 {
            return Ok(true);
        }
        if !chunk(&buffer[..read]) {
            return Ok(false);
        }
    }
}

pub fn wav(pcm: &[u8]) -> Vec<u8> {
    let pcm = &pcm[..pcm.len() & !1];
    let data = pcm.len() as u32;
    let mut file = Vec::with_capacity(44 + pcm.len());
    file.extend(b"RIFF");
    file.extend((36 + data).to_le_bytes());
    file.extend(b"WAVEfmt ");
    file.extend(16u32.to_le_bytes());
    file.extend(1u16.to_le_bytes());
    file.extend(1u16.to_le_bytes());
    file.extend(SAMPLE_RATE.to_le_bytes());
    file.extend((SAMPLE_RATE * 2).to_le_bytes());
    file.extend(2u16.to_le_bytes());
    file.extend(16u16.to_le_bytes());
    file.extend(b"data");
    file.extend(data.to_le_bytes());
    file.extend(pcm);
    file
}
