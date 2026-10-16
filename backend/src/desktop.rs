use crate::{
    commands, controller,
    generator::{GenerationState, Job},
    progress::Progress,
    state::StudioState,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct DesktopState {
    studio: StudioState,
    allow_close: AtomicBool,
    #[cfg(target_os = "linux")]
    routing: crate::audio_devices::Routing,
}

#[tauri::command]
async fn studio_command(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopState>>,
    request: Value,
) -> std::result::Result<Value, String> {
    if request["command"] == "audio_devices" {
        #[cfg(target_os = "linux")]
        return state
            .routing
            .catalog()
            .map(|devices| serde_json::json!({"audioDevices":devices}))
            .map_err(|error| error.to_string());
        #[cfg(not(target_os = "linux"))]
        return Ok(
            serde_json::json!({"audioDevices":{"inputs":[],"outputs":[],"nativeRouting":false,"available":true}}),
        );
    }
    if request["command"] == "audio_devices_sync" {
        #[cfg(target_os = "linux")]
        {
            let state = state.inner().clone();
            tauri::async_runtime::spawn_blocking(move || state.routing.synchronize())
                .await
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
        }
        return Ok(serde_json::json!({}));
    }
    if let Some(response) = speech_command(&state.studio, &request).await {
        return response;
    }
    let studio = state.studio.clone();
    let progress_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut store = studio
            .store
            .lock()
            .map_err(|_| anyhow::anyhow!(crate::i18n::message("error.storeUnavailable")))?;
        let mut audio = studio
            .audio
            .lock()
            .map_err(|_| anyhow::anyhow!(crate::i18n::message("error.engineUnavailable")))?;
        store.progress = Progress::new(move |event| {
            let _ = progress_app.emit("studio-progress", event);
        });
        let result = controller::execute(&mut store, &mut audio, &request);
        store.progress = Progress::default();
        Ok::<_, anyhow::Error>((result, commands::snapshot(&store)))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let (result, snapshot) = result;
    let _ = app.emit("studio-snapshot", snapshot);
    result.map_err(|e| e.to_string())
}

const SPEECH_HELP: &str = "https://github.com/ediril/simpleVoiceover#ai-voiceover";
const SPEECH_COMMANDS: [&str; 4] = [
    "script_generate",
    "script_cancel",
    "speech_voices",
    "speech_help",
];

async fn speech_command(
    studio: &StudioState,
    request: &Value,
) -> Option<std::result::Result<Value, String>> {
    if !SPEECH_COMMANDS.contains(&request["command"].as_str()?) {
        return None;
    }
    let studio = studio.clone();
    let request = request.clone();
    Some(
        tauri::async_runtime::spawn_blocking(move || speech_request(&studio, &request))
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string())),
    )
}

fn speech_request(studio: &StudioState, request: &Value) -> Result<Value> {
    match request["command"].as_str().unwrap_or_default() {
        "script_cancel" => studio.generator.cancel(),
        "speech_help" => open_in_browser(SPEECH_HELP)?,
        command => {
            let url = studio
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!(crate::i18n::message("error.storeUnavailable")))?
                .config
                .speech_url
                .clone();
            let voices = crate::speech::voices(&url)?;
            if command == "speech_voices" {
                return Ok(json!({ "voices": voices }));
            }
            let jobs = request["clips"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|clip| {
                    Some(Job {
                        track_id: clip["trackId"].as_str()?.into(),
                        clip_id: clip["clipId"].as_str()?.into(),
                    })
                });
            studio.generator.enqueue(jobs);
        }
    }
    Ok(json!({}))
}

fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).spawn()?;
    Ok(())
}

#[tauri::command]
fn close_studio(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopState>>,
    without_saving: bool,
) -> std::result::Result<(), String> {
    let mut store = state
        .studio
        .store
        .try_lock()
        .map_err(|_| crate::i18n::message("error.waitForOperation"))?;
    let audio = state
        .studio
        .audio
        .try_lock()
        .map_err(|_| crate::i18n::message("error.waitForOperation"))?;
    crate::lifecycle::prepare_close(&mut store, &audio, without_saving)
        .map_err(|error| error.to_string())?;
    state.allow_close.store(true, Ordering::SeqCst);
    drop(audio);
    drop(store);
    if let Some(window) = app.get_webview_window("main") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn run(studio: StudioState, address: &str) -> Result<()> {
    let desktop = Arc::new(DesktopState {
        studio: studio.clone(),
        allow_close: AtomicBool::new(false),
        #[cfg(target_os = "linux")]
        routing: crate::audio_devices::Routing::start(studio.store.clone()),
    });
    let url: tauri::Url = format!("http://{address}").parse()?;
    let closed = desktop.clone();
    tauri::Builder::default()
        .manage(desktop)
        .invoke_handler(tauri::generate_handler![studio_command, close_studio])
        .setup(move |app| {
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("studio")
                    .window("main")
                    .remote(format!("{}/*", url.origin().ascii_serialization()))
                    .permission("core:event:default")
                    .permission("core:window:allow-minimize")
                    .permission("core:window:allow-toggle-maximize")
                    .permission("core:window:allow-start-dragging")
                    .permission("core:window:allow-set-fullscreen")
                    .permission("core:window:allow-is-fullscreen")
                    .permission("core:menu:allow-new")
                    .permission("core:menu:allow-popup")
                    .permission("core:resources:allow-close")
                    .permission("allow-studio-command")
                    .permission("allow-close-studio"),
            )?;
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let permission_url = url.clone();
            let (width, height) = initial_window_size(app.primary_monitor()?.map(|monitor| {
                let area = monitor
                    .work_area()
                    .size
                    .to_logical::<f64>(monitor.scale_factor());
                (area.width, area.height)
            }));
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title(format!("simpleVoiceover v{}", env!("CARGO_PKG_VERSION")))
                .decorations(false)
                .inner_size(width, height)
                .center()
                .min_inner_size(960., 700.)
                .on_navigation(move |next| next.origin() == url.origin());
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let builder = builder.on_permission_request(move |webview, kind| {
                microphone_permission(webview.url().ok().as_ref(), &permission_url, kind)
            });
            let window = builder.build()?;
            #[cfg(target_os = "linux")]
            window.with_webview(|webview| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(settings) = webview.inner().settings() {
                    settings.set_enable_media_stream(true);
                    settings.set_enable_webrtc(true);
                }
            })?;
            let handle = window.app_handle().clone();
            let generation_handle = handle.clone();
            let generation_store = studio.store.clone();
            studio.generator.set_sink(move |event| {
                let _ = generation_handle.emit("studio-generation", &event);
                if event.state == GenerationState::Done
                    && let Ok(store) = generation_store.lock()
                {
                    let _ = generation_handle.emit("studio-snapshot", commands::snapshot(&store));
                }
            });
            let close = studio.close_requested.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    close.notified().await;
                    let _ = handle.emit("studio-close-requested", ());
                }
            });
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && !closed.allow_close.load(Ordering::SeqCst)
            {
                api.prevent_close();
                let _ = window.emit("studio-close-requested", ());
            }
        })
        .build(tauri::generate_context!())?
        .run(|_, _event| {
            #[cfg(target_os = "linux")]
            if matches!(_event, tauri::RunEvent::Exit) {
                crate::audio_output::cleanup();
            }
        });
    Ok(())
}

const PREFERRED_WINDOW_SIZE: (f64, f64) = (1440., 900.);

fn initial_window_size(work_area: Option<(f64, f64)>) -> (f64, f64) {
    let (width, height) = PREFERRED_WINDOW_SIZE;
    work_area.map_or(
        PREFERRED_WINDOW_SIZE,
        |(available_width, available_height)| {
            (width.min(available_width), height.min(available_height))
        },
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn microphone_permission(
    current_url: Option<&tauri::Url>,
    studio_url: &tauri::Url,
    kind: PermissionKind,
) -> PermissionResponse {
    if kind == PermissionKind::Microphone
        && current_url.is_some_and(|url| url.origin() == studio_url.origin())
    {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn microphone_access_is_limited_to_the_studio_origin() {
        let studio = tauri::Url::parse("http://127.0.0.1:5174/").unwrap();
        for address in ["http://127.0.0.1:5174/", "http://127.0.0.1:5174/settings"] {
            let current = tauri::Url::parse(address).unwrap();
            assert_eq!(
                microphone_permission(Some(&current), &studio, PermissionKind::Microphone),
                PermissionResponse::Allow
            );
        }
        for address in [
            "http://127.0.0.1:5175/",
            "http://localhost:5174/",
            "https://127.0.0.1:5174/",
            "http://127.0.0.1.example.com:5174/",
            "http://127.0.0.1:5174@external.example/",
            "https://external.example/",
            "about:blank",
        ] {
            let current = tauri::Url::parse(address).unwrap();
            assert_eq!(
                microphone_permission(Some(&current), &studio, PermissionKind::Microphone),
                PermissionResponse::Deny,
                "{address}"
            );
        }
        assert_eq!(
            microphone_permission(None, &studio, PermissionKind::Microphone),
            PermissionResponse::Deny
        );
    }

    #[test]
    fn microphone_access_does_not_grant_other_permissions() {
        let studio = tauri::Url::parse("http://127.0.0.1:5174/").unwrap();
        for kind in [
            PermissionKind::Camera,
            PermissionKind::DisplayCapture,
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
            PermissionKind::Other,
        ] {
            assert_eq!(
                microphone_permission(Some(&studio), &studio, kind),
                PermissionResponse::Deny
            );
        }
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    #[test]
    fn window_opens_at_preferred_size_on_large_screens() {
        assert_eq!(initial_window_size(Some((2560., 1415.))), (1440., 900.));
        assert_eq!(initial_window_size(None), (1440., 900.));
    }

    #[test]
    fn window_fits_inside_smaller_work_areas() {
        assert_eq!(initial_window_size(Some((1280., 775.))), (1280., 775.));
        assert_eq!(initial_window_size(Some((1512., 865.))), (1440., 865.));
    }
}
