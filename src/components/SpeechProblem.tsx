import { CircleAlert } from 'lucide-react'
import { t, translateMessage } from '../i18n'
import { isSpeechUnavailable } from '../timeline/script'

export default function SpeechProblem({ error, onHelp }: { error: string; onHelp: () => void }) {
  const unavailable = isSpeechUnavailable(error)
  return (
    <div className="speech-unavailable" role="alert">
      <CircleAlert size={15} />
      <div>
        <p>{unavailable ? t('speech.notReady') : translateMessage(error)}</p>
        {unavailable && (
          <button type="button" className="text-button" onClick={onHelp}>
            {t('speech.setupHelp')}
          </button>
        )}
      </div>
    </div>
  )
}
