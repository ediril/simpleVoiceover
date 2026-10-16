import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceList =
  | { status: 'loading' }
  | { status: 'ready'; voices: string[] }
  | { status: 'failed'; error: string }

export function useVoiceList(
  loadVoices: () => Promise<VoiceList>,
  onFailure?: (error: string) => void,
) {
  const [list, setList] = useState<VoiceList>({ status: 'loading' })
  const request = useRef(0)
  const failure = useRef(onFailure)
  useEffect(() => {
    failure.current = onFailure
  })
  const reload = useCallback(() => {
    const current = ++request.current
    setList({ status: 'loading' })
    void loadVoices().then((result) => {
      if (current !== request.current) return
      setList(result)
      if (result.status === 'failed') failure.current?.(result.error)
    })
  }, [loadVoices])
  useEffect(() => {
    const requests = request
    reload()
    return () => {
      requests.current++
    }
  }, [reload])
  return [list, reload] as const
}
