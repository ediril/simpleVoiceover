import { useEffect, useReducer, type MutableRefObject } from 'react'
import type { StudioClient } from '../services/StudioClient'
import { generationReducer, isGenerating } from '../timeline/script'

export function useScriptGeneration(
  engineRef: MutableRefObject<StudioClient | null>,
  onFailure: (error: string) => void,
) {
  const [generations, dispatch] = useReducer(generationReducer, {})
  useEffect(() => {
    const client = engineRef.current
    if (!client) return
    client.onGeneration = (event) => {
      dispatch(event)
      if (event.state === 'failed' && event.error) onFailure(event.error)
    }
    return () => {
      client.onGeneration = () => {}
    }
  }, [engineRef, onFailure])
  return { generations, generating: isGenerating(generations) }
}
