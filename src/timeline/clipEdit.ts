import type { Clip, MediaAsset } from '../types'
import type { ClipEditMode } from '../protocol'
import { minimumScriptSlot } from './script'
import { clamp } from './viewport'

const minimumAudioDuration = 1 / 48000

export function sourceDuration(clip: Clip, asset: Pick<MediaAsset, 'duration'> | undefined) {
  if (clip.script) return Infinity
  return asset?.duration ?? clip.offset + clip.duration
}

export function clipEditRange(clip: Clip, mode: ClipEditMode, source: number) {
  const minimumDuration = clip.script ? minimumScriptSlot : minimumAudioDuration
  if (mode === 'move') return { minimum: -clip.start, maximum: Infinity }
  if (mode === 'left')
    return {
      minimum: clip.script ? -clip.start : -Math.min(clip.start, clip.offset),
      maximum: Math.max(0, clip.duration - minimumDuration),
    }
  return {
    minimum: minimumDuration - clip.duration,
    maximum: source - clip.offset - clip.duration,
  }
}

export function editedClip(clip: Clip, mode: ClipEditMode, delta: number, source: number): Clip {
  const { minimum, maximum } = clipEditRange(clip, mode, source)
  const adjusted = clamp(delta, minimum, maximum)
  if (mode === 'move') return { ...clip, start: clip.start + adjusted }
  if (mode === 'right') return { ...clip, duration: clip.duration + adjusted }
  return {
    ...clip,
    start: clip.start + adjusted,
    offset: clip.script ? clip.offset : clip.offset + adjusted,
    duration: clip.duration - adjusted,
  }
}
