import { useCallback, useEffect, useState } from 'react'

export interface MessageAction {
  label: string
  run: () => void
}

export interface MessageOptions {
  action?: MessageAction
  duration?: number
}

const defaultDuration = 3000

export function useTransientMessage() {
  const [message, update] = useState<{
    text: string
    revision: number
    action?: MessageAction
    duration: number
  }>({ text: '', revision: 0, duration: defaultDuration })
  const setMessage = useCallback((text: string, options: MessageOptions = {}) => {
    update((previous) => ({
      text,
      revision: previous.revision + 1,
      action: options.action,
      duration: options.duration ?? defaultDuration,
    }))
  }, [])
  useEffect(() => {
    if (!message.text) return
    const timer = setTimeout(() => setMessage(''), message.duration)
    return () => clearTimeout(timer)
  }, [message, setMessage])
  return [message.text, setMessage, message.action] as const
}
