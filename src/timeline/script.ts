import type { Clip, MediaAsset, Track } from '../types'
import type { CommandPayloads, GenerationEvent, ScriptClipRef } from '../protocol'

export const speechWordsPerSecond = 2.5
export const minimumScriptSlot = 0.25
export const defaultScriptSlot = 4
export const overflowTolerance = 0.01
export const speechNoticeDuration = 10000
export const initialSpeedFactor = 2
export const progressEstimateCap = 0.95
export const progressTickMilliseconds = 200
const speedFactorSmoothing = 0.3

export type ScriptClip = Clip & { script: NonNullable<Clip['script']> }

export interface ActiveGeneration {
  state: 'queued' | 'generating'
  progress: number
}

export type ActiveGenerations = Readonly<Record<string, ActiveGeneration>>

interface GenerationTiming {
  startedAt: number
  expectedSeconds: number
  previousAssetId: string | null
}

export type TrackedGeneration =
  | { state: 'queued'; progress: number }
  | ({ state: 'generating'; progress: number } & GenerationTiming)

interface FinishedGeneration {
  elapsedSeconds: number
  previousAssetId: string | null
}

export interface SpeedFactor {
  value: number
  samples: number
}

export interface GenerationTracker {
  active: Readonly<Record<string, TrackedGeneration>>
  finished: Readonly<Record<string, FinishedGeneration>>
  speedFactor: SpeedFactor
}

export type GenerationAction =
  | { type: 'event'; event: GenerationEvent; at: number; clip: ScriptClip | undefined }
  | {
      type: 'snapshot'
      tracks: readonly Track[]
      assets: readonly Pick<MediaAsset, 'id' | 'duration'>[]
    }

export const idleGenerationTracker: GenerationTracker = {
  active: {},
  finished: {},
  speedFactor: { value: initialSpeedFactor, samples: 0 },
}

export type ScriptClipStatus =
  | { state: 'draft' | 'queued' | 'fits' | 'stale' }
  | { state: 'generating'; progress: number }
  | { state: 'overflow'; overflowSeconds: number }

export type ScriptClipState = ScriptClipStatus['state']

export type ScriptRowAction = 'generate' | 'regenerate' | 'stop'

export type FillLevel = 'ok' | 'tight' | 'over'

export const isScriptClip = (clip: Clip): clip is ScriptClip => !!clip.script

export function estimatedSpeechSeconds(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length
  return words / speechWordsPerSecond
}

export const expectedGenerationSeconds = (text: string, speedFactor: number) =>
  estimatedSpeechSeconds(text) * speedFactor

export function estimatedProgress(
  engineProgress: number,
  elapsedSeconds: number,
  expectedSeconds: number,
) {
  const estimate =
    expectedSeconds > 0
      ? Math.min(progressEstimateCap, Math.max(0, elapsedSeconds) / expectedSeconds)
      : 0
  return Math.max(engineProgress, estimate)
}

export function updatedSpeedFactor(
  current: SpeedFactor,
  elapsedSeconds: number,
  speechSeconds: number,
): SpeedFactor {
  if (!(elapsedSeconds > 0) || !(speechSeconds > 0)) return current
  const weight = Math.max(speedFactorSmoothing, 1 / (current.samples + 1))
  const measured = elapsedSeconds / speechSeconds
  return {
    value: current.value + (measured - current.value) * weight,
    samples: current.samples + 1,
  }
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
  return track && track.kind === 'voice' && !track.locked ? track : undefined
}

export function scriptRowAction(
  state: ScriptClipState,
  text: string,
  locked: boolean,
): ScriptRowAction | null {
  if (state === 'queued' || state === 'generating') return 'stop'
  if (locked || !text.trim()) return null
  if (state === 'draft') return 'generate'
  if (state === 'stale') return 'regenerate'
  return null
}

export function findScriptClip(tracks: readonly Track[], clipId: string) {
  for (const track of tracks)
    for (const clip of track.clips) if (clip.id === clipId && isScriptClip(clip)) return clip
  return undefined
}

export const projectVoicePayload = (voice: string): CommandPayloads['project_voice'] =>
  voice ? { voice } : {}

export function generationReducer(
  tracker: GenerationTracker,
  action: GenerationAction,
): GenerationTracker {
  return action.type === 'event'
    ? withGenerationEvent(tracker, action.event, action.at, action.clip)
    : withMeasuredTakes(tracker, action.tracks, action.assets)
}

function withGenerationEvent(
  tracker: GenerationTracker,
  event: GenerationEvent,
  at: number,
  clip: ScriptClip | undefined,
): GenerationTracker {
  const { active } = tracker
  const current = active[event.clipId]
  if (event.state === 'queued')
    return {
      ...tracker,
      active: { ...active, [event.clipId]: { state: 'queued', progress: event.progress } },
    }
  if (event.state === 'generating') {
    const timing: GenerationTiming =
      current?.state === 'generating'
        ? current
        : {
            startedAt: at,
            expectedSeconds: expectedGenerationSeconds(
              clip?.script.text ?? '',
              tracker.speedFactor.value,
            ),
            previousAssetId: clip?.assetId ?? null,
          }
    return {
      ...tracker,
      active: {
        ...active,
        [event.clipId]: {
          state: 'generating',
          progress: event.progress,
          startedAt: timing.startedAt,
          expectedSeconds: timing.expectedSeconds,
          previousAssetId: timing.previousAssetId,
        },
      },
    }
  }
  if (!current) return tracker
  const remaining = { ...active }
  delete remaining[event.clipId]
  const finished =
    event.state === 'done' && current.state === 'generating'
      ? {
          ...tracker.finished,
          [event.clipId]: {
            elapsedSeconds: (at - current.startedAt) / 1000,
            previousAssetId: current.previousAssetId,
          },
        }
      : tracker.finished
  return { ...tracker, active: remaining, finished }
}

function withMeasuredTakes(
  tracker: GenerationTracker,
  tracks: readonly Track[],
  assets: readonly Pick<MediaAsset, 'id' | 'duration'>[],
): GenerationTracker {
  const waiting = Object.entries(tracker.finished)
  if (!waiting.length) return tracker
  const durations = new Map(assets.map((asset) => [asset.id, asset.duration]))
  const finished = { ...tracker.finished }
  let speedFactor = tracker.speedFactor
  for (const [clipId, generation] of waiting) {
    const clip = findScriptClip(tracks, clipId)
    if (!clip) {
      delete finished[clipId]
      continue
    }
    const speechSeconds = clip.assetId ? durations.get(clip.assetId) : undefined
    if (clip.assetId === generation.previousAssetId || speechSeconds === undefined) continue
    speedFactor = updatedSpeedFactor(speedFactor, generation.elapsedSeconds, speechSeconds)
    delete finished[clipId]
  }
  if (Object.keys(finished).length === waiting.length) return tracker
  return { ...tracker, finished, speedFactor }
}

export function displayedGenerations(
  active: GenerationTracker['active'],
  now: number,
): ActiveGenerations {
  return Object.fromEntries(
    Object.entries(active).map(([clipId, generation]) => [
      clipId,
      generation.state === 'generating'
        ? {
            state: 'generating',
            progress: estimatedProgress(
              generation.progress,
              (now - generation.startedAt) / 1000,
              generation.expectedSeconds,
            ),
          }
        : generation,
    ]),
  )
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
