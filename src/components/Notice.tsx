import { t, translateMessage } from '../i18n'
import { Check, HelpCircle, X } from 'lucide-react'
import type { StudioController } from '../useStudio'

type Props = Pick<StudioController, 'notice' | 'error' | 'errorAction' | 'setNotice' | 'setError'>

export default function Notice({ notice, error, errorAction, setNotice, setError }: Props) {
  if (!notice && !error) return null
  const dismiss = () => {
    setNotice('')
    setError('')
  }
  return (
    <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      {error ? <HelpCircle size={17} /> : <Check size={17} />}
      <span className="notice-content">{translateMessage(error || notice)}</span>
      {error && errorAction && (
        <button
          className="toast-action"
          onClick={() => {
            errorAction.run()
            dismiss()
          }}
        >
          {errorAction.label}
        </button>
      )}
      <button aria-label={t('notice.close')} onClick={dismiss}>
        <X size={15} />
      </button>
    </div>
  )
}
