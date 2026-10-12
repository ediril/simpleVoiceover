use crate::{
    commands,
    generator::{GenerationEvent, GenerationState, Generator, Job},
    model::id,
    speech,
    storage::Store,
};
use anyhow::Result;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        mpsc::{Receiver, channel},
    },
    thread,
    time::Duration,
};

struct FakeKokoro {
    url: String,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

fn fake_kokoro(chunks: usize, chunk_delay: Duration) -> FakeKokoro {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let recorded = requests.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let recorded = recorded.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header == "\r\n" {
                        break;
                    }
                    if let Some(value) = header.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let mut stream = stream;
                if request_line.starts_with("GET /v1/audio/voices") {
                    let body = json!({"voices":["af_heart","am_michael"]}).to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    return;
                }
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_slice(&body).unwrap());
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: audio/pcm\r\nConnection: close\r\n\r\n"
                );
                let chunk: Vec<u8> = (0..speech::SAMPLE_RATE / 4)
                    .flat_map(|_| 8000i16.to_le_bytes())
                    .collect();
                for _ in 0..chunks {
                    if stream.write_all(&chunk).is_err() {
                        return;
                    }
                    thread::sleep(chunk_delay);
                }
            });
        }
    });
    FakeKokoro { url, requests }
}

fn studio(
    url: &str,
) -> Result<(
    tempfile::TempDir,
    Arc<Mutex<Store>>,
    Generator,
    Receiver<GenerationEvent>,
)> {
    let temporary = tempfile::tempdir()?;
    let mut store = Store::open(
        temporary.path().join("config"),
        Some(temporary.path().join("work")),
    )?;
    store.set_speech(url, "af_heart")?;
    let store = Arc::new(Mutex::new(store));
    let generator = Generator::start(store.clone());
    let (sender, events) = channel();
    let sender = Mutex::new(sender);
    generator.set_sink(move |event| {
        let _ = sender.lock().unwrap().send(event);
    });
    Ok((temporary, store, generator, events))
}

fn script(store: &Arc<Mutex<Store>>, text: &str) -> Result<Job> {
    let mut store = store.lock().unwrap();
    let track_id = store.project.tracks[1].id.clone();
    let clip_id = id();
    commands::execute(
        &mut store,
        &json!({"command":"script_add","trackId":track_id,"clipId":clip_id,"position":0.,"duration":4.}),
    )?;
    commands::execute(
        &mut store,
        &json!({"command":"script_patch","trackId":track_id,"clipId":clip_id,"text":text}),
    )?;
    Ok(Job { track_id, clip_id })
}

fn wait_for(events: &Receiver<GenerationEvent>, state: GenerationState) -> Vec<GenerationEvent> {
    let mut seen = vec![];
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("generation event");
        let done = event.state == state;
        seen.push(event);
        if done {
            return seen;
        }
    }
}

#[test]
fn generated_speech_becomes_the_clip_take() -> Result<()> {
    let kokoro = fake_kokoro(4, Duration::from_millis(5));
    let (_temporary, store, generator, events) = studio(&kokoro.url)?;
    let job = script(&store, "Welcome to the harbour at dawn.")?;
    generator.enqueue([job.clone()]);
    let seen = wait_for(&events, GenerationState::Done);
    assert_eq!(seen[0].state, GenerationState::Queued);
    let progress: Vec<f64> = seen
        .iter()
        .filter(|event| event.state == GenerationState::Generating)
        .map(|event| event.progress)
        .collect();
    assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(progress.iter().any(|value| *value > 0.));
    let request = kokoro.requests.lock().unwrap()[0].clone();
    assert_eq!(request["input"], "Welcome to the harbour at dawn.");
    assert_eq!(request["voice"], "af_heart");
    assert_eq!(request["response_format"], "pcm");
    let store = store.lock().unwrap();
    let clip = &store.project.tracks[1].clips[0];
    let script = clip.script.as_ref().unwrap();
    let take = script.take.as_ref().unwrap();
    assert_eq!(
        (take.text.as_str(), take.voice.as_str()),
        (script.text.as_str(), "af_heart")
    );
    let asset = store
        .project
        .assets
        .iter()
        .find(|asset| Some(&asset.id) == clip.asset_id.as_ref())
        .unwrap();
    assert!((asset.duration - 1.).abs() < 0.01, "{}", asset.duration);
    assert_eq!(asset.kind, "audio");
    Ok(())
}

#[test]
fn regenerating_replaces_the_previous_take_and_uses_the_project_voice() -> Result<()> {
    let kokoro = fake_kokoro(2, Duration::ZERO);
    let (_temporary, store, generator, events) = studio(&kokoro.url)?;
    let job = script(&store, "First version.")?;
    generator.enqueue([job.clone()]);
    wait_for(&events, GenerationState::Done);
    let first = store.lock().unwrap().project.tracks[1].clips[0]
        .asset_id
        .clone()
        .unwrap();
    commands::execute(
        &mut store.lock().unwrap(),
        &json!({"command":"project_voice","voice":"am_michael"}),
    )?;
    generator.enqueue([job]);
    wait_for(&events, GenerationState::Done);
    assert_eq!(kokoro.requests.lock().unwrap()[1]["voice"], "am_michael");
    let store = store.lock().unwrap();
    let clip = &store.project.tracks[1].clips[0];
    assert_ne!(clip.asset_id.as_deref(), Some(first.as_str()));
    assert!(store.project.assets.iter().all(|asset| asset.id != first));
    assert_eq!(store.project.assets.len(), 1);
    Ok(())
}

#[test]
fn cancelling_stops_the_stream_and_clears_the_queue() -> Result<()> {
    let kokoro = fake_kokoro(40, Duration::from_millis(50));
    let (_temporary, store, generator, events) = studio(&kokoro.url)?;
    let current = script(&store, "A long sentence that takes a while to speak aloud.")?;
    let waiting = script(&store, "This one never starts.")?;
    generator.enqueue([current.clone(), waiting.clone()]);
    loop {
        let event = events.recv_timeout(Duration::from_secs(10)).unwrap();
        if event.state == GenerationState::Generating && event.progress > 0. {
            break;
        }
    }
    generator.cancel();
    let mut cancelled = vec![];
    while cancelled.len() < 2 {
        let event = events.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_ne!(event.state, GenerationState::Done);
        if event.state == GenerationState::Cancelled {
            cancelled.push(event.clip_id);
        }
    }
    cancelled.sort();
    let mut expected = vec![current.clip_id, waiting.clip_id];
    expected.sort();
    assert_eq!(cancelled, expected);
    let store = store.lock().unwrap();
    assert!(
        store.project.tracks[1]
            .clips
            .iter()
            .all(|clip| clip.asset_id.is_none())
    );
    assert!(store.project.assets.is_empty());
    assert_eq!(kokoro.requests.lock().unwrap().len(), 1);
    Ok(())
}

#[test]
fn unreachable_kokoro_and_empty_clips_fail_with_a_reason() -> Result<()> {
    let closed = TcpListener::bind("127.0.0.1:0")?;
    let url = format!("http://{}", closed.local_addr()?);
    drop(closed);
    let (_temporary, store, generator, events) = studio(&url)?;
    assert!(
        speech::voices(&url)
            .unwrap_err()
            .to_string()
            .contains("error.speechUnavailable")
    );
    let unreachable = script(&store, "Hello there.")?;
    let empty = script(&store, "   ")?;
    generator.enqueue([unreachable, empty]);
    let failures: Vec<String> = (0..2)
        .map(|_| {
            wait_for(&events, GenerationState::Failed)
                .pop()
                .unwrap()
                .error
                .unwrap()
        })
        .collect();
    assert!(failures[0].contains("error.speechUnavailable"));
    assert!(failures[1].contains("error.scriptEmpty"));
    Ok(())
}

#[test]
fn voice_lists_accept_names_or_objects() -> Result<()> {
    assert_eq!(
        speech::parse_voices(r#"{"voices":["af_heart","bf_emma"]}"#)?,
        ["af_heart", "bf_emma"]
    );
    assert_eq!(
        speech::parse_voices(r#"{"voices":[{"id":"af_heart"},{"name":"bf_emma"}]}"#)?,
        ["af_heart", "bf_emma"]
    );
    assert!(speech::parse_voices(r#"{"voices":[]}"#).is_err());
    Ok(())
}

#[test]
#[ignore = "needs a running Kokoro-FastAPI server at http://localhost:8880"]
fn live_kokoro_generates_a_take() -> Result<()> {
    let (_temporary, store, generator, events) = studio("http://localhost:8880")?;
    assert!(speech::voices("http://localhost:8880")?.contains(&"af_heart".to_owned()));
    let job = script(
        &store,
        "Welcome to the harbour at dawn, where the cats are already awake.",
    )?;
    generator.enqueue([job]);
    let seen = wait_for(&events, GenerationState::Done);
    let generating = seen
        .iter()
        .filter(|event| event.state == GenerationState::Generating && event.progress > 0.)
        .count();
    let store = store.lock().unwrap();
    let asset = &store.project.assets[0];
    println!(
        "duration {:.2}s, {} progress events",
        asset.duration, generating
    );
    assert!((2.5..6.).contains(&asset.duration));
    assert!(generating > 1, "progress arrives while streaming");
    Ok(())
}
