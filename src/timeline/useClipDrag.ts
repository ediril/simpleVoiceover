import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Clip, Track, MediaAsset } from '../types'
import type { ClipEditMode } from '../protocol'
import type { TimelineProps } from './types'
import type { TimelineViewport } from './useTimelineViewport'
import { clipBoundaries, snapDelta } from './snapping'
import { clipEditRange, editedClip, sourceDuration } from './clipEdit'
interface ClipDrag {
  pointerId: number
  originX: number
  pixelsPerSecond: number
  trackId: string
  clip: Clip
  mode: ClipEditMode
  sourceDuration: number
  moved: boolean
  next: Clip
}

export function useClipDrag(
  props: TimelineProps,
  viewport: TimelineViewport,
  assetMap: Map<string, MediaAsset>,
) {
  const {
    tracks,
    recording,
    operationPending,
    tool,
    onSelectTrack,
    onSelectClip,
    onSplitClip,
    onEditClip,
  } = props
  const { rulerRef, view, pixelsPerSecond } = viewport
  const [preview, setPreview] = useState<{ trackId: string; clip: Clip } | null>(null)
  const drag = useRef<ClipDrag | null>(null)
  const pending = useRef<ClipDrag | null>(null)
  useEffect(() => {
    const current = pending.current
    if (!current) return
    const clip = tracks
      .find((track) => track.id === current.trackId)
      ?.clips.find((clip) => clip.id === current.clip.id)
    if (
      !clip ||
      ['start', 'offset', 'duration'].every(
        (field) =>
          Math.abs(
            clip[field as keyof Pick<Clip, 'start' | 'offset' | 'duration'>] -
              current.next[field as keyof Pick<Clip, 'start' | 'offset' | 'duration'>],
          ) < 1e-8,
      )
    ) {
      pending.current = null
      setPreview(null)
    }
  }, [tracks])
  const beginClipDrag = (event: ReactPointerEvent<HTMLDivElement>, track: Track, clip: Clip) => {
    if (event.button !== 0) return
    event.stopPropagation()
    onSelectTrack(track.id)
    onSelectClip(clip.id)
    if (track.locked || recording || operationPending || pending.current) return
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-trim]')?.dataset.trim
    if (tool === 'split' && !edge) {
      if (clip.script) return
      const left = rulerRef.current?.getBoundingClientRect().left ?? 0
      const time = view.start + (event.clientX - left) / pixelsPerSecond
      onSplitClip(track.id, clip.id, time)
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      pixelsPerSecond,
      trackId: track.id,
      clip,
      mode: edge === 'left' || edge === 'right' ? edge : 'move',
      sourceDuration: sourceDuration(clip, clip.assetId ? assetMap.get(clip.assetId) : undefined),
      moved: false,
      next: clip,
    }
  }

  const moveClip = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    if (!current.moved && Math.abs(event.clientX - current.originX) < 3) return
    current.moved = true
    let delta = (event.clientX - current.originX) / current.pixelsPerSecond
    const original = current.clip
    if (props.snapping) {
      const { minimum, maximum } = clipEditRange(original, current.mode, current.sourceDuration)
      const edges =
        current.mode === 'move'
          ? [original.start, original.start + original.duration]
          : [current.mode === 'left' ? original.start : original.start + original.duration]
      delta = snapDelta(
        delta,
        edges,
        clipBoundaries(tracks, [current.trackId], [original.id]),
        current.pixelsPerSecond,
        minimum,
        maximum,
      )
    }
    const next = editedClip(original, current.mode, delta, current.sourceDuration)
    current.next = next
    setPreview({ trackId: current.trackId, clip: next })
  }

  const finishClip = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    const delta =
      current.mode === 'right'
        ? current.next.duration - current.clip.duration
        : current.next.start - current.clip.start
    if (current.moved && !cancelled && delta !== 0) {
      pending.current = current
      void onEditClip(current.trackId, current.clip.id, current.mode, delta).then((saved) => {
        if (!saved && pending.current === current) {
          pending.current = null
          setPreview(null)
        }
      })
    } else setPreview(null)
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return { preview, drag, beginClipDrag, moveClip, finishClip }
}
export type ClipDragging = ReturnType<typeof useClipDrag>
