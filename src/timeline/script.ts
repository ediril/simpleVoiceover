import type { Clip, MediaAsset, Track } from '../types'
import type { CommandPayloads, GenerationEvent, ScriptClipRef } from '../protocol'

export const speechWordsPerSecond = 2.5
export const minimumScriptSlot = 0.25
export const defaultScriptSlot = 4
export const overflowTolerance = 0.01
export const speechNoticeDuration = 10000

export type ScriptClip = Clip & { script: NonNullable<Clip['script']> }

export interface ActiveGeneration {
  state: 'queued' | 'generating'
  progress: number
}

export type ActiveGenerations = Readonly<Record<string, ActiveGeneration>>

export type ScriptClipStatus =
  | { state: 'draft' | 'queued' | 'fits' | 'stale' }
  | { state: 'generating'; progress: number }
  | { state: 'overflow'; overflowSeconds: number }

export type ScriptClipState = ScriptClipStatus['state']

export type FillLevel = 'ok' | 'tight' | 'over'

export const isScriptClip = (clip: Clip): clip is ScriptClip => !!clip.script

export function estimatedSpeechSeconds(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length
  return words / speechWordsPerSecond
}

export function fillRatio(text: string, boxSeconds: number): { ratio: number; level: FillLevel } {
  const ratio = boxSeconds > 0 ? estimatedSpeechSeconds(text) / boxSeconds : Infinity
  return { ratio, level: ratio < 0.85 ? 'ok' : ratio <= 1 ? 'tight' : 'over' }
}

export function scriptClipStatus(
  clip: ScriptClip,
  asset: Pick<MediaAsset, 'duration'> | undefined,
  effectiveVoice: string,
  generation: ActiveGeneration | undefined,
): ScriptClipStatus {
  if (generation?.state === 'generating')
    return { state: 'generating', progress: generation.progress }
  if (generation?.state === 'queued') return { state: 'queued' }
  const take = clip.script.take
  if (!take || !asset) return { state: 'draft' }
  if (take.text !== clip.script.text || take.voice !== effectiveVoice) return { state: 'stale' }
  const overflowSeconds = asset.duration - clip.duration
  if (overflowSeconds > overflowTolerance) return { state: 'overflow', overflowSeconds }
  return { state: 'fits' }
}

export function scriptClipsInOrder(tracks: Track[]) {
  return tracks
    .flatMap((track) =>
      track.clips
        .filter(isScriptClip)
        .map((clip) => ({ trackId: track.id, locked: track.locked, clip })),
    )
    .sort((a, b) => a.clip.start - b.clip.start)
}

export function pendingScriptClips(
  tracks: Track[],
  statusOf: (clip: ScriptClip) => ScriptClipStatus,
): ScriptClipRef[] {
  return scriptClipsInOrder(tracks)
    .filter(({ locked, clip }) => {
      const { state } = statusOf(clip)
      return !locked && (state === 'draft' || state === 'stale') && clip.script.text.trim() !== ''
    })
    .map(({ trackId, clip }) => ({ trackId, clipId: clip.id }))
}

export function scriptSaveRequests(
  trackId: string,
  clip: ScriptClip,
  text: string,
  generate: boolean,
): {
  patch: CommandPayloads['script_patch'] | null
  generate: CommandPayloads['script_generate'] | null
} {
  const trimmed = singleLineText(text).trim()
  return {
    patch: trimmed !== clip.script.text ? { trackId, clipId: clip.id, text: trimmed } : null,
    generate: generate && trimmed ? { clips: [{ trackId, clipId: clip.id }] } : null,
  }
}

export function scriptDrawTarget(tracks: Track[], trackId: string) {
  const track = tracks.find((track) => track.id === trackId)
  return track && track.kind !== 'video' && !track.locked ? track : undefined
}

export const projectVoicePayload = (voice: string): CommandPayloads['project_voice'] =>
  voice ? { voice } : {}

export function generationReducer(
  active: ActiveGenerations,
  event: GenerationEvent,
): ActiveGenerations {
  if (event.state === 'queued' || event.state === 'generating')
    return { ...active, [event.clipId]: { state: event.state, progress: event.progress } }
  if (!Object.hasOwn(active, event.clipId)) return active
  const remaining = { ...active }
  delete remaining[event.clipId]
  return remaining
}

export const isGenerating = (active: ActiveGenerations) => Object.keys(active).length > 0

export function isSpeechUnavailable(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.includes('[[error.speechUnavailable')
}

export const singleLineText = (text: string) => text.replace(/[\r\n]+/g, ' ')

export function scriptDraftRange(from: number, to: number, moved: boolean) {
  if (!moved) return { position: Math.max(0, from), duration: defaultScriptSlot }
  const position = Math.max(0, Math.min(from, to))
  return { position, duration: Math.max(minimumScriptSlot, Math.max(from, to) - position) }
}
