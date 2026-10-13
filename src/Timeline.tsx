import { t } from './i18n'
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TimelineProps } from './timeline/types'
import { useTimelineViewport } from './timeline/useTimelineViewport'
import { useClipDrag } from './timeline/useClipDrag'
import TimelineToolbar from './timeline/TimelineToolbar'
import TimelineRuler from './timeline/TimelineRuler'
import TimelineTrack from './timeline/TimelineTrack'
import TimelineScrollbar from './timeline/TimelineScrollbar'
import { useTimelineSelection } from './timeline/useTimelineSelection'
import { useScriptDraw } from './timeline/useScriptDraw'
import ScriptEditor from './timeline/ScriptEditor'
import { isScriptClip } from './timeline/script'
import './timeline.css'

export default function Timeline(props: TimelineProps) {
  const { tracks, assets, selectedClipId, recording, position, tool } = props
  const viewport = useTimelineViewport(props)
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const clipDragging = useClipDrag(props, viewport, assetMap)
  const selecting = useTimelineSelection(props, viewport)
  const [editingClipId, setEditingClipId] = useState<string | null>(null)
  const scriptDrawing = useScriptDraw(props, viewport, setEditingClipId)
  const editingTrack = tracks.find((track) => track.clips.some((clip) => clip.id === editingClipId))
  const editingClip = editingTrack?.clips.find((clip) => clip.id === editingClipId)
  const openScriptEditor = (event: ReactMouseEvent<HTMLElement>) => {
    const element = document.elementFromPoint(event.clientX, event.clientY)
    if (!element || element.closest('button')) return
    const clipId = element.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId
    const track = tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
    const clip = track?.clips.find((clip) => clip.id === clipId)
    if (!track || !clip || !isScriptClip(clip) || track.locked || recording) return
    if (props.operationPending) return
    setEditingClipId(clip.id)
  }
  const selectedTrack = tracks.find((track) =>
    track.clips.some((clip) => clip.id === selectedClipId),
  )
  const canDelete =
    !recording &&
    !props.operationPending &&
    (props.selection?.regions.length
      ? props.selection.regions.every(
          (region) => !tracks.find((track) => track.id === region.trackId)?.locked,
        )
      : !!selectedClipId && !!selectedTrack && !selectedTrack.locked)
  const playheadLeft = (position - viewport.view.start) * viewport.pixelsPerSecond
  const playheadVisible = playheadLeft >= 0 && playheadLeft <= viewport.laneWidth
  return (
    <section
      ref={viewport.timelineRef}
      className={`tl-timeline ${tool === 'split' ? 'tl-split-mode' : ''} ${tool === 'script' ? 'tl-script-mode' : ''} ${viewport.panning ? 'is-panning' : ''}`}
      onPointerDownCapture={(event) => {
        viewport.beginPan(event)
        if (event.button === 0) selecting.captureMarquee(event)
      }}
      onPointerMoveCapture={viewport.movePan}
      onPointerUpCapture={viewport.endPan}
      onPointerCancelCapture={viewport.endPan}
      onPointerMove={selecting.move}
      onPointerUp={(event) => selecting.finish(event)}
      onPointerCancel={(event) => selecting.finish(event, true)}
      onLostPointerCapture={(event) => {
        viewport.endPan(event)
        selecting.finish(event, true)
      }}
      onDoubleClick={openScriptEditor}
      onAuxClick={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      aria-label={t('timeline.editor')}
    >
      <TimelineToolbar
        {...props}
        viewport={viewport}
        canDelete={canDelete}
        selectedTrack={selectedTrack}
      />
      <div className="tl-track-area">
        <TimelineRuler {...props} viewport={viewport} />
        {(selecting.preview?.tracks ?? tracks).map((track, index) => (
          <TimelineTrack
            key={track.id}
            {...props}
            track={track}
            index={index}
            viewport={viewport}
            clipDragging={clipDragging}
            selecting={selecting}
            scriptDrawing={scriptDrawing}
            selection={selecting.preview?.selection ?? props.selection}
            assetMap={assetMap}
          />
        ))}
        {playheadVisible && (
          <div
            className={`tl-playhead ${recording ? 'is-recording' : ''}`}
            style={{ left: `calc(var(--tl-header-width) + ${playheadLeft}px)` }}
          >
            <span />
          </div>
        )}
      </div>
      <TimelineScrollbar {...props} viewport={viewport} />
      {editingTrack && editingClip && isScriptClip(editingClip) && (
        <ScriptEditor
          key={editingClip.id}
          clipId={editingClip.id}
          initialText={editingClip.script.text}
          timelineRef={viewport.timelineRef}
          onSave={(text, generate) =>
            props.onSaveScript(editingTrack.id, editingClip.id, text, generate)
          }
          onClose={() => setEditingClipId(null)}
        />
      )}
    </section>
  )
}
