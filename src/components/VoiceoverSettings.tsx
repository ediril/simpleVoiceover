import { useState } from 'react'
import { t, translateMessage } from '../i18n'
import type { StudioController } from '../useStudio'
import { useVoiceList } from '../hooks/useVoiceList'
import SpeechProblem from './SpeechProblem'
import VoiceSelect from './VoiceSelect'

type Props = Pick<
  StudioController,
  | 'speechUrl'
  | 'defaultVoice'
  | 'loadVoices'
  | 'saveSpeechPreferences'
  | 'openSpeechHelp'
  | 'operationPending'
>

export default function VoiceoverSettings({
  speechUrl,
  defaultVoice,
  loadVoices,
  saveSpeechPreferences,
  openSpeechHelp,
  operationPending,
}: Props) {
  const [url, setUrl] = useState(speechUrl)
  const [voice, setVoice] = useState(defaultVoice)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [voiceList, reloadVoices] = useVoiceList(loadVoices)
  const changed = url.trim() !== speechUrl || voice.trim() !== defaultVoice
  const listed = voiceList.status === 'ready' ? voiceList.voices : []
  const save = async () => {
    setSaving(true)
    setSaveError(null)
    const error = await saveSpeechPreferences(url.trim(), voice.trim())
    setSaving(false)
    setSaveError(error)
    if (!error && url.trim() !== speechUrl) reloadVoices()
  }
  return (
    <form
      className="settings-section"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed && !saving) void save()
      }}
    >
      <h3>{t('settings.voiceover')}</h3>
      <label className="settings-field">
        <span>{t('settings.speechUrl')}</span>
        <input
          type="url"
          value={url}
          spellCheck={false}
          placeholder="http://localhost:8880"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>{t('settings.speechVoice')}</span>
        {voiceList.status === 'failed' ? (
          <input
            type="text"
            value={voice}
            spellCheck={false}
            onChange={(event) => setVoice(event.target.value)}
          />
        ) : (
          <VoiceSelect
            value={voice}
            voices={listed}
            label={t('settings.speechVoice')}
            disabled={voiceList.status === 'loading'}
            onChange={setVoice}
          />
        )}
      </label>
      {voiceList.status === 'failed' && (
        <SpeechProblem error={voiceList.error} onHelp={openSpeechHelp} />
      )}
      <p className="hint muted">
        {t(voiceList.status === 'failed' ? 'settings.voiceUnavailable' : 'settings.voiceHint')}
      </p>
      {saveError && (
        <p className="settings-error" role="alert">
          {translateMessage(saveError)}
        </p>
      )}
      <button
        type="submit"
        className="button secondary"
        disabled={!changed || saving || operationPending}
      >
        {t('settings.saveVoiceover')}
      </button>
    </form>
  )
}
