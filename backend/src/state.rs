use crate::{generator::Generator, session::AudioSession, storage::Store};
use std::sync::{Arc, Mutex, atomic::AtomicBool};
use tokio::sync::Notify;

#[derive(Clone)]
pub struct StudioState {
    pub store: Arc<Mutex<Store>>,
    pub audio: Arc<Mutex<AudioSession>>,
    pub shutdown: Arc<Notify>,
    pub connected: Arc<AtomicBool>,
    pub close_requested: Arc<Notify>,
    pub generator: Generator,
}
impl StudioState {
    pub fn new(store: Store) -> Self {
        let store = Arc::new(Mutex::new(store));
        Self {
            generator: Generator::start(store.clone()),
            store,
            audio: Arc::new(Mutex::new(AudioSession::new())),
            shutdown: Arc::new(Notify::new()),
            connected: Arc::new(AtomicBool::new(false)),
            close_requested: Arc::new(Notify::new()),
        }
    }
}
