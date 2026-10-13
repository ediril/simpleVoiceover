import { useEffect, useMemo, useReducer, useRef, useState, type MutableRefObject } from 'react'
import type { Snapshot } from '../protocol'
import type { StudioClient } from '../services/StudioClient'
import type { Track } from '../types'
import {
  displayedGenerations,
  findScriptClip,
  generationReducer,
  idleGenerationTracker,
  isGenerating,
  progressTickMilliseconds,
} from '../timeline/script'

export function useScriptGeneration(
  engineRef: MutableRefObject<StudioClient | null>,
  snapshot: Snapshot | null,
  onFailure: (error: string) => void,
) {
  const [tracker, dispatch] = useReducer(generationReducer, idleGenerationTracker)
  const [now, setNow] = useState(() => performance.now())
  const tracks = useRef<readonly Track[]>([])
  useEffect(() => {
    if (!snapshot) return
    tracks.current = snapshot.project.tracks
    dispatch({ type: 'snapshot', tracks: snapshot.project.tracks, assets: snapshot.project.assets })
  }, [snapshot])
  useEffect(() => {
    const client = engineRef.current
    if (!client) return
    client.onGeneration = (event) => {
      dispatch({
        type: 'event',
        event,
        at: performance.now(),
        clip: findScriptClip(tracks.current, event.clipId),
      })
      if (event.state === 'failed' && event.error) onFailure(event.error)
    }
    return () => {
      client.onGeneration = () => {}
    }
  }, [engineRef, onFailure])
  const running = Object.values(tracker.active).some(
    (generation) => generation.state === 'generating',
  )
  useEffect(() => {
    if (!running) return
    setNow(performance.now())
    const timer = window.setInterval(() => setNow(performance.now()), progressTickMilliseconds)
    return () => window.clearInterval(timer)
  }, [running])
  const generations = useMemo(
    () => displayedGenerations(tracker.active, now),
    [tracker.active, now],
  )
  return { generations, generating: isGenerating(tracker.active) }
}
