import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Track } from '../types'
import type { TimelineProps } from './types'
import type { TimelineViewport } from './useTimelineViewport'
import { clipBoundaries, snapDelta } from './snapping'
import { scriptDraftRange, scriptDrawTarget } from './script'

interface Draw {
  pointerId: number
  originX: number
  trackId: string
  from: number
  to: number
  moved: boolean
}

export interface ScriptGhost {
  trackId: string
  start: number
  end: number
}

export function useScriptDraw(
  props: TimelineProps,
  viewport: TimelineViewport,
  onCreated: (clipId: string) => void,
) {
  const draw = useRef<Draw | null>(null)
  const [ghost, setGhost] = useState<ScriptGhost | null>(null)
  const timeAt = (clientX: number, trackId: string) => {
    const left = viewport.rulerRef.current?.getBoundingClientRect().left ?? 0
    const time = Math.max(0, viewport.view.start + (clientX - left) / viewport.pixelsPerSecond)
    if (!props.snapping) return time
    const targets = clipBoundaries(props.tracks, [trackId], [])
    return time + snapDelta(0, [time], targets, viewport.pixelsPerSecond, -time)
  }
  const canDraw = (track: Track) =>
    props.tool === 'script' &&
    !!scriptDrawTarget(props.tracks, track.id) &&
    !props.recording &&
    !props.operationPending
  const abandon = () => {
    draw.current = null
    setGhost(null)
  }
  useEffect(() => {
    const current = draw.current
    if (current && (!scriptDrawTarget(props.tracks, current.trackId) || props.recording)) abandon()
  }, [props.tracks, props.recording])
  const begin = (event: ReactPointerEvent<HTMLElement>, track: Track) => {
    if (event.button !== 0 || !canDraw(track)) return false
    event.preventDefault()
    event.stopPropagation()
    props.onSelectTrack(track.id)
    props.onSelectClip(null)
    event.currentTarget.setPointerCapture(event.pointerId)
    const time = timeAt(event.clientX, track.id)
    draw.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      trackId: track.id,
      from: time,
      to: time,
      moved: false,
    }
    return true
  }
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = draw.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.abs(event.clientX - current.originX) < 3) return
    current.moved = true
    current.to = timeAt(event.clientX, current.trackId)
    setGhost({
      trackId: current.trackId,
      start: Math.min(current.from, current.to),
      end: Math.max(current.from, current.to),
    })
  }
  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const current = draw.current
    if (!current || current.pointerId !== event.pointerId) return
    abandon()
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancelled || !scriptDrawTarget(props.tracks, current.trackId)) return
    const { position, duration } = scriptDraftRange(current.from, current.to, current.moved)
    void props.onAddScriptClip(current.trackId, position, duration).then((clipId) => {
      if (clipId) onCreated(clipId)
    })
  }
  return { ghost, begin, move, finish }
}

export type ScriptDrawing = ReturnType<typeof useScriptDraw>
