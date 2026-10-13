import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { t } from '../i18n'
import { clamp } from './viewport'
import { singleLineText } from './script'

const minimumWidth = 240
const maximumWidth = 480
const maximumHeight = 168
const windowMargin = 8

type Finish = 'save' | 'generate' | 'discard'

interface Placement {
  left: number
  top: number
  width: number
}

function placementFor(anchor: Element): Placement {
  const bounds = anchor.getBoundingClientRect()
  const width = clamp(bounds.width, minimumWidth, maximumWidth)
  return {
    left: clamp(bounds.left, windowMargin, window.innerWidth - width - windowMargin),
    top: clamp(bounds.top, windowMargin, window.innerHeight - maximumHeight - windowMargin),
    width,
  }
}

export default function ScriptEditor({
  clipId,
  initialText,
  timelineRef,
  onSave,
  onClose,
}: {
  clipId: string
  initialText: string
  timelineRef: RefObject<HTMLElement | null>
  onSave: (text: string, generate: boolean) => boolean
  onClose: () => void
}) {
  const [text, setText] = useState(initialText)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const finished = useRef(false)
  const finish = (mode: Finish) => {
    if (finished.current) return
    if (mode !== 'discard' && !onSave(text, mode === 'generate')) return
    finished.current = true
    onClose()
  }
  const latestFinish = useRef(finish)
  useEffect(() => {
    latestFinish.current = finish
  })
  useLayoutEffect(() => {
    const anchor = timelineRef.current?.querySelector(`[data-clip-id="${clipId}"]`)
    if (anchor) setPlacement(placementFor(anchor))
  }, [clipId, timelineRef])
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.style.height = 'auto'
    editor.style.height = `${editor.scrollHeight + editor.offsetHeight - editor.clientHeight}px`
  }, [text, placement])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    editor.setSelectionRange(editor.value.length, editor.value.length)
  }, [placement])
  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      if (!editorRef.current?.contains(event.target as Node)) latestFinish.current('save')
    }
    document.addEventListener('pointerdown', pointerDown, true)
    return () => document.removeEventListener('pointerdown', pointerDown, true)
  }, [])
  if (!placement) return null
  return (
    <textarea
      ref={editorRef}
      className="tl-script-editor"
      style={{ left: placement.left, top: placement.top, width: placement.width }}
      value={text}
      rows={1}
      maxLength={5000}
      spellCheck
      aria-label={t('script.editorLabel')}
      placeholder={t('script.editorPlaceholder')}
      onChange={(event) => setText(singleLineText(event.target.value))}
      onBlur={() => {
        if (document.hasFocus()) finish('save')
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          finish('generate')
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish('discard')
        }
      }}
    />
  )
}
