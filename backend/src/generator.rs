use crate::{
    commands,
    model::{Clip, Project, Take, id},
    speech,
    storage::Store,
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    path::Path,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub track_id: String,
    pub clip_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationState {
    Queued,
    Generating,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationEvent {
    pub clip_id: String,
    pub state: GenerationState,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

type Sink = Arc<dyn Fn(GenerationEvent) + Send + Sync>;

struct Shared {
    queue: Mutex<VecDeque<Job>>,
    ready: Condvar,
    cancel: AtomicBool,
    sink: Mutex<Sink>,
}

impl Shared {
    fn emit(&self, clip_id: &str, state: GenerationState, progress: f64, error: Option<String>) {
        let sink = self.sink.lock().unwrap().clone();
        sink(GenerationEvent {
            clip_id: clip_id.into(),
            state,
            progress,
            error,
        });
    }
}

#[derive(Clone)]
pub struct Generator {
    shared: Arc<Shared>,
}

impl Generator {
    pub fn start(store: Arc<Mutex<Store>>) -> Self {
        let shared = Arc::new(Shared {
            queue: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            cancel: AtomicBool::new(false),
            sink: Mutex::new(Arc::new(|_| {})),
        });
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("speech".into())
            .spawn(move || {
                loop {
                    let job = {
                        let mut queue = worker.queue.lock().unwrap();
                        loop {
                            if let Some(job) = queue.pop_front() {
                                worker.cancel.store(false, Ordering::SeqCst);
                                break job;
                            }
                            queue = worker.ready.wait(queue).unwrap();
                        }
                    };
                    process(&store, &worker, &job);
                }
            })
            .expect("speech worker thread");
        Self { shared }
    }

    pub fn set_sink(&self, sink: impl Fn(GenerationEvent) + Send + Sync + 'static) {
        *self.shared.sink.lock().unwrap() = Arc::new(sink);
    }

    pub fn enqueue(&self, jobs: impl IntoIterator<Item = Job>) {
        let mut queue = self.shared.queue.lock().unwrap();
        let mut added = vec![];
        for job in jobs {
            if !queue.contains(&job) {
                added.push(job.clip_id.clone());
                queue.push_back(job);
            }
        }
        drop(queue);
        for clip_id in added {
            self.shared
                .emit(&clip_id, GenerationState::Queued, 0., None);
        }
        self.shared.ready.notify_one();
    }

    pub fn cancel(&self) {
        let drained: Vec<Job> = self.shared.queue.lock().unwrap().drain(..).collect();
        self.shared.cancel.store(true, Ordering::SeqCst);
        for job in drained {
            self.shared
                .emit(&job.clip_id, GenerationState::Cancelled, 0., None);
        }
    }
}

fn process(store: &Mutex<Store>, shared: &Shared, job: &Job) {
    shared.emit(&job.clip_id, GenerationState::Generating, 0., None);
    match generate(store, shared, job) {
        Ok(true) => shared.emit(&job.clip_id, GenerationState::Done, 1., None),
        Ok(false) => shared.emit(&job.clip_id, GenerationState::Cancelled, 0., None),
        Err(error) => shared.emit(
            &job.clip_id,
            GenerationState::Failed,
            0.,
            Some(error.to_string()),
        ),
    }
}

fn find<'a>(project: &'a mut Project, job: &Job) -> Result<&'a mut Clip> {
    project
        .tracks
        .iter_mut()
        .find(|track| track.id == job.track_id)
        .and_then(|track| track.clips.iter_mut().find(|clip| clip.id == job.clip_id))
        .filter(|clip| clip.script.is_some())
        .context(crate::i18n::message("error.clipMissing"))
}

fn generate(store: &Mutex<Store>, shared: &Shared, job: &Job) -> Result<bool> {
    let (url, text, voice) = {
        let mut store = store
            .lock()
            .map_err(|_| anyhow::anyhow!(crate::i18n::message("error.storeUnavailable")))?;
        let voice = store
            .project
            .voice
            .clone()
            .unwrap_or_else(|| store.config.speech_voice.clone());
        let url = store.config.speech_url.clone();
        let text = find(&mut store.project, job)?
            .script
            .as_ref()
            .map(|script| script.text.clone())
            .unwrap_or_default();
        (url, text, voice)
    };
    ensure!(!text.is_empty(), crate::i18n::message("error.scriptEmpty"));
    let estimate = speech::estimated_seconds(&text);
    let mut pcm = Vec::new();
    let completed = speech::stream(&url, &text, &voice, |bytes| {
        pcm.extend_from_slice(bytes);
        let progress = (speech::seconds(pcm.len()) / estimate).min(0.95);
        shared.emit(&job.clip_id, GenerationState::Generating, progress, None);
        !shared.cancel.load(Ordering::SeqCst)
    })?;
    if !completed || shared.cancel.load(Ordering::SeqCst) {
        return Ok(false);
    }
    ensure!(
        pcm.len() >= 2,
        crate::i18n::formatted_message("error.speechFailed", &[("detail", "empty".into())])
    );
    let file = std::env::temp_dir().join(format!("simpleVoiceover-take-{}.wav", id()));
    fs::write(&file, speech::wav(&pcm))?;
    let attached = attach(store, job, &file, &text, &voice);
    let _ = fs::remove_file(&file);
    attached.map(|_| true)
}

fn asset_name(text: &str) -> String {
    let words: String = text.chars().take(40).collect();
    format!("{}.wav", words.trim())
}

fn attach(store: &Mutex<Store>, job: &Job, file: &Path, text: &str, voice: &str) -> Result<()> {
    let mut store = store
        .lock()
        .map_err(|_| anyhow::anyhow!(crate::i18n::message("error.storeUnavailable")))?;
    let decoded = commands::decode_source(&mut store, file, &asset_name(text), "audio")?;
    let committed = (|| {
        let asset = decoded
            .assets
            .first()
            .context(crate::i18n::message("error.noDecodableAudio"))?
            .clone();
        let mut project = store.project.clone();
        let clip = find(&mut project, job)?;
        let previous = clip.asset_id.replace(asset.id.clone());
        if let Some(script) = clip.script.as_mut() {
            script.take = Some(Take {
                text: text.into(),
                voice: voice.into(),
            });
        }
        project.assets.push(asset);
        if let Some(previous) = previous {
            let still_used = project
                .tracks
                .iter()
                .flat_map(|track| &track.clips)
                .any(|clip| clip.asset_id.as_deref() == Some(previous.as_str()));
            if !still_used {
                project.assets.retain(|asset| asset.id != previous);
            }
        }
        Ok::<_, anyhow::Error>(project)
    })();
    match committed {
        Ok(project) => store.replace(project),
        Err(error) => {
            decoded.discard(&mut store)?;
            Err(error)
        }
    }
}
