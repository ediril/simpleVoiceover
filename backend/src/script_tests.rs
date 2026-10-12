use crate::{
    commands,
    media::wav_header,
    mixer::Mixer,
    model::{Clip, Project, SAMPLE_RATE, Script, Take, id},
    storage::Store,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::{fs::File, io::Write, path::Path};

fn new_store(path: &Path) -> Result<Store> {
    Store::open(path.join("config"), Some(path.join("work")))
}

fn add_script(store: &mut Store, track: usize, position: f64, duration: f64) -> Result<String> {
    let clip_id = id();
    commands::execute(
        store,
        &json!({"command":"script_add","trackId":store.project.tracks[track].id,"clipId":clip_id,"position":position,"duration":duration}),
    )?;
    Ok(clip_id)
}

fn run(store: &mut Store, command: Value) -> Result<Value> {
    commands::execute(store, &command)
}

fn import_tone(store: &mut Store, path: &Path, seconds: usize) -> Result<String> {
    let mut file = File::create(path)?;
    file.write_all(&wav_header(48000 * seconds as u64))?;
    for _ in 0..48000 * seconds {
        file.write_all(&[0, 32, 0, 32])?;
    }
    drop(file);
    commands::import_source(
        store,
        path.to_path_buf(),
        "take.wav".into(),
        "audio".into(),
        None,
        0.,
    )?;
    Ok(store.project.assets.last().unwrap().id.clone())
}

fn script_clip(store: &Store, clip_id: &str) -> Clip {
    store
        .project
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .find(|clip| clip.id == clip_id)
        .unwrap()
        .clone()
}

#[test]
fn draft_script_clip_saves_and_reopens_with_text_and_voice() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let mut store = new_store(temporary.path())?;
    let clip_id = add_script(&mut store, 1, 1.5, 3.)?;
    let track_id = store.project.tracks[1].id.clone();
    run(
        &mut store,
        json!({"command":"script_patch","trackId":track_id,"clipId":clip_id,"text":"  Welcome to the harbour.  "}),
    )?;
    run(
        &mut store,
        json!({"command":"project_voice","voice":"af_heart"}),
    )?;
    let file = temporary.path().join("saved").join("script.justspeak");
    store.save(&file)?;
    let mut reopened = new_store(&temporary.path().join("other"))?;
    reopened.load(&file)?;
    let clip = script_clip(&reopened, &clip_id);
    assert_eq!(clip.start, 1.5);
    assert_eq!(clip.duration, 3.);
    assert_eq!(clip.asset_id, None);
    assert_eq!(
        clip.script,
        Some(Script {
            text: "Welcome to the harbour.".into(),
            take: None
        })
    );
    assert_eq!(reopened.project.voice.as_deref(), Some("af_heart"));
    Ok(())
}

#[test]
fn script_clip_edges_set_its_slot_without_an_audio_limit() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let mut store = new_store(temporary.path())?;
    let clip_id = add_script(&mut store, 1, 1., 3.)?;
    let track_id = store.project.tracks[1].id.clone();
    let edit = |mode: &str, delta: f64| json!({"command":"clip_edit","trackId":track_id,"clipId":clip_id,"mode":mode,"delta":delta});
    run(&mut store, edit("right", 20.))?;
    assert_eq!(script_clip(&store, &clip_id).duration, 23.);
    run(&mut store, edit("left", -0.5))?;
    let clip = script_clip(&store, &clip_id);
    assert_eq!((clip.start, clip.offset, clip.duration), (0.5, 0., 23.5));
    run(&mut store, edit("right", -100.))?;
    assert_eq!(script_clip(&store, &clip_id).duration, 0.25);
    Ok(())
}

#[test]
fn script_clips_cannot_be_split_or_partially_edited() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let mut store = new_store(temporary.path())?;
    let clip_id = add_script(&mut store, 1, 0., 4.)?;
    let track_id = store.project.tracks[1].id.clone();
    assert!(
        run(
            &mut store,
            json!({"command":"clip_split","trackId":track_id,"clipId":clip_id,"position":2.}),
        )
        .is_err()
    );
    assert!(
        run(
            &mut store,
            json!({"command":"regions_edit","regions":[{"trackId":track_id,"clipId":clip_id,"from":1.,"to":2.}],"delta":0.,"trackOffset":0,"remove":true}),
        )
        .is_err()
    );
    run(
        &mut store,
        json!({"command":"regions_edit","regions":[{"trackId":track_id,"clipId":clip_id,"from":0.,"to":4.}],"delta":2.,"trackOffset":1}),
    )?;
    let moved = &store.project.tracks[2].clips[0];
    assert_eq!((moved.id.as_str(), moved.start), (clip_id.as_str(), 2.));
    assert!(moved.script.is_some());
    Ok(())
}

#[test]
fn script_clips_are_rejected_on_video_tracks_and_without_matching_audio() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let mut store = new_store(temporary.path())?;
    assert!(add_script(&mut store, 0, 0., 2.).is_err());
    let mut project: Project = store.project.clone();
    project.tracks[1].clips.push(Clip {
        id: id(),
        asset_id: None,
        name: String::new(),
        start: 0.,
        offset: 0.,
        duration: 1.,
        script: None,
    });
    assert!(project.validate().is_err());
    let mut project: Project = store.project.clone();
    project.tracks[1].clips.push(Clip {
        id: id(),
        asset_id: None,
        name: String::new(),
        start: 0.,
        offset: 0.,
        duration: 1.,
        script: Some(Script {
            text: "Hello".into(),
            take: Some(Take {
                text: "Hello".into(),
                voice: "af_heart".into(),
            }),
        }),
    });
    assert!(project.validate().is_err());
    Ok(())
}

#[test]
fn script_clip_plays_its_take_then_silence_and_returns_to_draft_without_it() -> Result<()> {
    let temporary = tempfile::tempdir()?;
    let mut store = new_store(temporary.path())?;
    let asset_id = import_tone(&mut store, &temporary.path().join("take.wav"), 1)?;
    for track in &mut store.project.tracks {
        track.clips.clear();
    }
    let draft_id = add_script(&mut store, 1, 0., 3.)?;
    let mut mixer = Mixer::unscaled(&store)?;
    let (silent, _) = mixer.block(&store.project, 0, 1024, None, None)?;
    assert!(silent.iter().flatten().all(|sample| *sample == 0.));
    let mut project = store.project.clone();
    let clip = project.tracks[1]
        .clips
        .iter_mut()
        .find(|clip| clip.id == draft_id)
        .unwrap();
    clip.asset_id = Some(asset_id.clone());
    clip.script = Some(Script {
        text: "Hello".into(),
        take: Some(Take {
            text: "Hello".into(),
            voice: "af_heart".into(),
        }),
    });
    store.replace(project)?;
    let mut mixer = Mixer::unscaled(&store)?;
    let (speech, _) = mixer.block(&store.project, SAMPLE_RATE as u64 / 2, 1024, None, None)?;
    assert!(speech.iter().flatten().any(|sample| *sample != 0.));
    let mut fresh = Mixer::unscaled(&store)?;
    let (after, _) = fresh.block(&store.project, SAMPLE_RATE as u64 * 2, 1024, None, None)?;
    drop(fresh);
    assert!(after.iter().flatten().all(|sample| *sample == 0.));
    drop(mixer);
    run(
        &mut store,
        json!({"command":"asset_remove","assetId":asset_id}),
    )?;
    let clip = script_clip(&store, &draft_id);
    assert_eq!(clip.asset_id, None);
    assert_eq!(clip.script.unwrap().take, None);
    Ok(())
}

#[test]
fn clips_saved_before_scripts_existed_still_load() -> Result<()> {
    let clip: Clip = serde_json::from_value(json!({
        "id": id(),
        "assetId": id(),
        "name": "voice.wav",
        "start": 1.,
        "offset": 0.,
        "duration": 2.
    }))?;
    assert!(clip.asset_id.is_some() && clip.script.is_none());
    assert!(
        !serde_json::to_string(&clip)?.contains("script"),
        "clips without a script keep the original JSON shape"
    );
    Ok(())
}
