import { t, type TranslationKey } from '../i18n'
import { Square, WandSparkles } from 'lucide-react'
import { formatTime } from '../types'
import type { StudioController } from '../useStudio'
import { useVoiceList } from '../hooks/useVoiceList'
import type { ScriptClipState } from '../timeline/script'
import SpeechProblem from './SpeechProblem'

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
  const voiceOptions =
    projectVoice && !listed.includes(projectVoice) ? [projectVoice, ...listed] : listed
  return (
    <div className="script-panel">
      <div className="panel-heading">
        <span className="eyebrow">{t('script.voiceHeading')}</span>
      </div>
      {voiceList.status === 'failed' ? (
        <SpeechProblem error={voiceList.error} onHelp={openSpeechHelp} />
      ) : (
        <select
          aria-label={t('script.voice')}
          value={projectVoice ?? ''}
          disabled={voiceList.status !== 'ready' || blocked}
          onChange={(event) => changeProjectVoice(event.target.value)}
        >
          <option value="">{t('script.voiceDefault', { voice: defaultVoice })}</option>
          {voiceOptions.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
      )}
      <div className="script-actions">
        <button
          className="button accent"
          disabled={!pendingScripts.length || blocked || !!busy}
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
          {scriptClips.map(({ trackId, clip }) => {
            const status = scriptStatus(clip)
            return (
              <li key={clip.id}>
                <button
                  className={selectedClipId === clip.id ? 'is-selected' : ''}
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
