import { t } from '../i18n'
import { LockKeyhole, RefreshCw, ScrollText, Square } from 'lucide-react'
import type { MediaAsset } from '../types'
import Waveform from './Waveform'
import { fillRatio, type ScriptClip, type ScriptClipStatus } from './script'

const keepFromClip = (event: { stopPropagation: () => void }) => event.stopPropagation()

export default function ScriptClipBody({
  clip,
  status,
  asset,
  locked,
  color,
  waveformOffset,
  waveformDuration,
  width,
  onRegenerate,
  onCancel,
}: {
  clip: ScriptClip
  status: ScriptClipStatus
  asset?: MediaAsset
  locked: boolean
  color: string
  waveformOffset: number
  waveformDuration: number
  width: number
  onRegenerate: () => void
  onCancel: () => void
}) {
  const text = clip.script.text
  const audible = status.state === 'fits' || status.state === 'stale' || status.state === 'overflow'
  const fill = fillRatio(text, clip.duration)
  return (
    <>
      <div className="tl-clip-heading">
        <span className="tl-script-title">
          <ScrollText size={10} />
          {t('script.clip')}
        </span>
        {locked && <LockKeyhole size={9} />}
      </div>
      <div className="tl-script-body">
        {audible && (
          <Waveform
            asset={asset}
            offset={waveformOffset}
            duration={waveformDuration}
            width={width}
            color={color}
          />
        )}
        <p className={`tl-script-text ${text ? '' : 'is-placeholder'}`}>
          {text || t('script.placeholder')}
        </p>
        {status.state === 'queued' && <span className="tl-script-label">{t('script.queued')}</span>}
        {status.state === 'generating' && (
          <span className="tl-script-progress">
            <span className="tl-script-progress-bar">
              <i style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </span>
            <small>{t('script.progress', { percent: Math.round(status.progress * 100) })}</small>
          </span>
        )}
        {status.state === 'draft' && text && (
          <span
            className={`tl-script-fill is-${fill.level}`}
            style={{ width: `${Math.min(1, fill.ratio) * 100}%` }}
          />
        )}
      </div>
      {status.state === 'generating' && (
        <button
          className="tl-script-action"
          title={t('script.stop')}
          aria-label={t('script.stop')}
          onPointerDown={keepFromClip}
          onKeyDown={keepFromClip}
          onDoubleClick={keepFromClip}
          onClick={onCancel}
        >
          <Square size={8} fill="currentColor" />
        </button>
      )}
      {status.state === 'stale' && !locked && (
        <button
          className="tl-script-action"
          title={t('script.regenerate')}
          aria-label={t('script.regenerate')}
          onPointerDown={keepFromClip}
          onKeyDown={keepFromClip}
          onDoubleClick={keepFromClip}
          onClick={onRegenerate}
        >
          <RefreshCw size={10} />
        </button>
      )}
    </>
  )
}
