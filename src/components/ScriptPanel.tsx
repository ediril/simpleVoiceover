import { t, type TranslationKey } from '../i18n'
import { RefreshCw, Square, WandSparkles } from 'lucide-react'
import { formatTime } from '../types'
import type { StudioController } from '../useStudio'
import { useVoiceList } from '../hooks/useVoiceList'
import { scriptRowAction, type ScriptClipState, type ScriptRowAction } from '../timeline/script'
import { voiceName } from '../voices'
import SpeechProblem from './SpeechProblem'
import VoiceSelect from './VoiceSelect'

type Props = Pick<
  StudioController,
  | 'scriptClips'
  | 'scriptStatus'
  | 'pendingScripts'
  | 'generateScripts'
  | 'cancelGeneration'
  | 'generating'
  | 'projectVoice'
  | 'defaultVoice'
  | 'changeProjectVoice'
  | 'loadVoices'
  | 'openSpeechHelp'
  | 'showSpeechError'
  | 'seek'
  | 'setSelectedTrackId'
  | 'setSelectedClipId'
  | 'selectedClipId'
  | 'recording'
  | 'busy'
  | 'operationPending'
>

const statusLabels: Record<ScriptClipState, TranslationKey> = {
  draft: 'script.statusDraft',
  queued: 'script.queued',
  generating: 'script.statusGenerating',
  fits: 'script.statusFits',
  stale: 'script.statusStale',
  overflow: 'script.statusOverflow',
}

const rowActionLabels: Record<ScriptRowAction, TranslationKey> = {
  generate: 'script.rowGenerate',
  regenerate: 'script.rowRegenerate',
  stop: 'script.rowStop',
}

const rowActionTitles: Record<ScriptRowAction, TranslationKey> = {
  generate: 'script.rowGenerate',
  regenerate: 'script.rowRegenerate',
  stop: 'script.stop',
}

function RowActionIcon({ action }: { action: ScriptRowAction }) {
  if (action === 'stop') return <Square size={9} fill="currentColor" />
  if (action === 'regenerate') return <RefreshCw size={10} />
  return <WandSparkles size={11} />
}

export default function ScriptPanel({
  scriptClips,
  scriptStatus,
  pendingScripts,
  generateScripts,
  cancelGeneration,
  generating,
  projectVoice,
  defaultVoice,
  changeProjectVoice,
  loadVoices,
  openSpeechHelp,
  showSpeechError,
  seek,
  setSelectedTrackId,
  setSelectedClipId,
  selectedClipId,
  recording,
  busy,
  operationPending,
}: Props) {
  const [voiceList] = useVoiceList(loadVoices, showSpeechError)
  const blocked = recording || operationPending
  const listed = voiceList.status === 'ready' ? voiceList.voices : []
  const generationBlocked = blocked || !!busy
  return (
    <div className="script-panel">
      <div className="panel-heading">
        <span className="eyebrow">{t('script.voiceHeading')}</span>
      </div>
      {voiceList.status === 'failed' ? (
        <SpeechProblem error={voiceList.error} onHelp={openSpeechHelp} />
      ) : (
        <VoiceSelect
          label={t('script.voice')}
          value={projectVoice ?? ''}
          voices={listed}
          disabled={voiceList.status !== 'ready' || blocked}
          defaultLabel={t('script.voiceDefault', { voice: voiceName(defaultVoice) })}
          onChange={changeProjectVoice}
        />
      )}
      <div className="script-actions">
        <button
          className="button accent"
          disabled={!pendingScripts.length || generationBlocked}
          onClick={() => generateScripts(pendingScripts)}
        >
          <WandSparkles size={14} />
          {t('script.generateAll')}
        </button>
        <button className="button secondary" disabled={!generating} onClick={cancelGeneration}>
          <Square size={11} fill="currentColor" />
          {t('script.stopAll')}
        </button>
      </div>
      <div className="panel-heading">
        <span className="eyebrow">{t('script.listHeading')}</span>
        <span className="counter">{scriptClips.length}</span>
      </div>
      {scriptClips.length ? (
        <ol className="script-list">
          {scriptClips.map(({ trackId, locked, clip }) => {
            const status = scriptStatus(clip)
            const action = scriptRowAction(status.state, clip.script.text, locked)
            return (
              <li key={clip.id}>
                <button
                  className={`script-row ${selectedClipId === clip.id ? 'is-selected' : ''}`}
                  onClick={() => {
                    setSelectedTrackId(trackId)
                    setSelectedClipId(clip.id)
                    seek(clip.start)
                  }}
                >
                  <span className="script-time">{formatTime(clip.start)}</span>
                  <span className={`script-excerpt ${clip.script.text ? '' : 'muted'}`}>
                    {clip.script.text || t('script.untitled')}
                  </span>
                  <span className={`script-chip is-${status.state}`}>
                    {t(statusLabels[status.state])}
                  </span>
                </button>
                {action && (
                  <button
                    className={`script-row-action is-${action}`}
                    title={t(rowActionTitles[action])}
                    aria-label={action === 'regenerate' ? t(rowActionLabels[action]) : undefined}
                    disabled={action !== 'stop' && generationBlocked}
                    onClick={() =>
                      action === 'stop'
                        ? cancelGeneration()
                        : generateScripts([{ trackId, clipId: clip.id }])
                    }
                  >
                    <RowActionIcon action={action} />
                    {action !== 'regenerate' && t(rowActionLabels[action])}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="hint muted">{t('script.empty')}</p>
      )}
    </div>
  )
}
