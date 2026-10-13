import type { Track, MediaAsset } from '../types'
import type { ReactNode } from 'react'
import type { ClipEditMode, ScriptClipRef } from '../protocol'
import type { ClipRegion, TimelineSelection } from './selection'
import type { ScriptClip, ScriptClipStatus } from './script'
export type TimelineTool = 'select' | 'split' | 'script'
export interface TimelineProps {
  transport?: ReactNode
  tracks: Track[]
  assets: MediaAsset[]
  selectedTrackId: string
  selectedClipId: string | null
  selection: TimelineSelection | null
  onSelectRegion: (selection: TimelineSelection | null) => void
  onMoveRegions: (regions: ClipRegion[], delta: number, shift: number) => Promise<boolean>
  onCopy: () => void
  onPaste: () => void
  canPaste: boolean
  onSelectTrack: (id: string) => void
  onSelectClip: (id: string | null) => void
  onUpdateTrack: (id: string, patch: Partial<Track>) => void
  onEditClip: (
    trackId: string,
    clipId: string,
    mode: ClipEditMode,
    delta: number,
  ) => Promise<boolean>
  onSplitClip: (trackId: string, clipId: string, position: number) => void
  onSeek: (time: number) => void
  position: number
  duration: number
  recording: boolean
  operationPending: boolean
  recordStart: number
  tool: TimelineTool
  onToolChange: (tool: TimelineTool) => void
  snapping: boolean
  onSnappingChange: (enabled: boolean) => void
  onAddTrack: () => void
  onRemoveTrack: (track: Track) => void
  onRemoveClip: () => void
  getLevel: (id: string) => number
  scriptStatus: (clip: ScriptClip) => ScriptClipStatus
  onAddScriptClip: (trackId: string, position: number, duration: number) => Promise<string | null>
  onSaveScript: (trackId: string, clipId: string, text: string, generate: boolean) => boolean
  onGenerateScripts: (clips: ScriptClipRef[]) => void
  onCancelGeneration: () => void
}
