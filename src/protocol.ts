import { t } from './i18n'
import type { Track, MediaAsset } from './types'
import type { LanguagePreference } from './i18n'
import type { EffectPreset } from './effectPresets'
import type { ClipRegion, ClipClipboard } from './timeline/selection'
import type { AudioDeviceCatalog } from './audio/devices'

export interface OperationProgress {
  label: string
  percent: number
}

export interface Snapshot {
  project: {
    id: string
    name: string
    tracks: Track[]
    assets: Omit<MediaAsset, 'url'>[]
    voice?: string
  }
  config: {
    workingDirectory: string
    speechUrl: string
    speechVoice: string
    projectFile: string | null
    dirty: boolean
    language?: LanguagePreference
    effectPresets?: EffectPreset[]
    inputDevice?: string
    outputDevice?: string
  }
  duration: number
  canUndo: boolean
  canRedo: boolean
}
export type ClipEditMode = 'move' | 'left' | 'right'
export interface ScriptClipRef {
  trackId: string
  clipId: string
}
export type GenerationState = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled'
export interface GenerationEvent {
  clipId: string
  state: GenerationState
  progress: number
  error?: string
}
export interface CommandPayloads {
  snapshot: Record<string, never>
  preferences_patch: { preference: LanguagePreference }
  audio_preferences_patch: { inputDevice: string; outputDevice: string }
  audio_devices: Record<string, never>
  audio_devices_sync: Record<string, never>
  preset_save: Omit<EffectPreset, 'id'>
  regions_edit: { regions: ClipRegion[]; delta: number; trackOffset: number; remove?: boolean }
  clips_paste: {
    projectId: string
    clips: ClipClipboard['clips']
    trackId: string
    position: number
  }
  working_directory: { path?: string }
  save: { saveAs?: boolean }
  open: Record<string, never>
  import_native: { trackId: string; position: number }
  import_paths: { paths: string[]; trackId: string; position: number }
  export: { trackId: string | null; format: 'wav' | 'mp3' }
  track_patch: { trackId: string; patch: Partial<Track> }
  track_add: Record<string, never>
  track_remove: { trackId: string }
  clip_remove: { trackId: string; clipId: string | null }
  clip_place: { trackId: string; assetId: string; position: number }
  asset_remove: { assetId: string }
  clip_edit: { trackId: string; clipId: string; mode: ClipEditMode; delta: number }
  clip_split: { trackId: string; clipId: string; position: number }
  undo: Record<string, never>
  redo: Record<string, never>
  play: { position: number }
  pause: Record<string, never>
  monitor: { enabled: boolean }
  record_begin: { position: number }
  record_end: Record<string, never>
  script_add: { trackId: string; clipId: string; position: number; duration: number }
  script_patch: { trackId: string; clipId: string; text: string }
  project_voice: { voice?: string }
  speech_preferences_patch: { url: string; voice: string }
  script_generate: { clips: ScriptClipRef[] }
  script_cancel: Record<string, never>
  speech_voices: Record<string, never>
  speech_help: Record<string, never>
}
export type CommandName = keyof CommandPayloads
export interface CommandResult {
  saved?: boolean
  path?: string
  snapshot?: Snapshot
  regions?: ClipRegion[]
  audioDevices?: AudioDeviceCatalog
  voices?: string[]
}

export function decodeAudioPacket(data: ArrayBuffer) {
  if (data.byteLength < 16 || (data.byteLength - 16) % 8 !== 0)
    throw new Error(t('error.audioPacketCorrupt'))
  const view = new DataView(data)
  if (
    view.getUint32(0, true) !== 0x504f5653 ||
    view.getUint32(4, true) * 8 + 16 !== data.byteLength
  )
    throw new Error(t('error.audioPacketFormat'))
  return { samples: new Float32Array(data.slice(16)), position: view.getFloat64(8, true) }
}
