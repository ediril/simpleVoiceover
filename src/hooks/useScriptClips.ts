import { useCallback, useMemo } from 'react'
import { t } from '../i18n'
import type {
  CommandName,
  CommandPayloads,
  CommandResult,
  ScriptClipRef,
  Snapshot,
} from '../protocol'
import type { MediaAsset } from '../types'
import type { VoiceList } from './useVoiceList'
import {
  pendingScriptClips,
  projectVoicePayload,
  scriptClipStatus,
  scriptClipsInOrder,
  scriptSaveRequests,
  type ActiveGenerations,
  type ScriptClip,
} from '../timeline/script'

type Request = <K extends CommandName>(
  command: K,
  payload?: CommandPayloads[K],
) => Promise<CommandResult>

type Operation = <T>(
  label: string,
  run: () => Promise<T>,
  onFailure?: (reason: unknown) => void,
) => Promise<T | undefined>

interface Options {
  snapshot: Snapshot | null
  assets: MediaAsset[]
  generations: ActiveGenerations
  request: Request
  operation: Operation
  operationBlocked: boolean
  showError: (reason: unknown) => void
  showSpeechError: (reason: unknown) => void
  setNotice: (text: string) => void
}

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

export function useScriptClips({
  snapshot,
  assets,
  generations,
  request,
  operation,
  operationBlocked,
  showError,
  showSpeechError,
  setNotice,
}: Options) {
  const tracks = snapshot?.project.tracks ?? []
  const projectVoice = snapshot?.project.voice
  const defaultVoice = snapshot?.config.speechVoice ?? ''
  const effectiveVoice = projectVoice ?? defaultVoice
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const scriptStatus = useCallback(
    (clip: ScriptClip) =>
      scriptClipStatus(
        clip,
        clip.assetId ? assetById.get(clip.assetId) : undefined,
        effectiveVoice,
        generations[clip.id],
      ),
    [assetById, effectiveVoice, generations],
  )
  const scriptClips = scriptClipsInOrder(tracks)
  const pendingScripts = pendingScriptClips(tracks, scriptStatus)
  const refuseWhileBlocked = () => {
    if (operationBlocked) showError(t('error.waitForOperation'))
    return operationBlocked
  }
  const generateScripts = (clips: ScriptClipRef[]) => {
    if (!clips.length || refuseWhileBlocked()) return
    void operation(
      t('action.generateSpeech'),
      () => request('script_generate', { clips }),
      showSpeechError,
    )
  }
  const addScriptClip = async (trackId: string, position: number, duration: number) => {
    const clipId = crypto.randomUUID()
    const result = await operation(t('action.addScript'), () =>
      request('script_add', { trackId, clipId, position, duration }),
    )
    return result ? clipId : null
  }
  const saveScript = (trackId: string, clipId: string, text: string, generate: boolean) => {
    const clip = scriptClips.find((entry) => entry.clip.id === clipId)?.clip
    if (!clip) return true
    const requests = scriptSaveRequests(trackId, clip, text, generate)
    if (!requests.patch && !requests.generate) return true
    if (refuseWhileBlocked()) return false
    void operation(
      t(requests.generate ? 'action.generateSpeech' : 'action.editClip'),
      async () => {
        if (requests.patch) await request('script_patch', requests.patch)
        if (requests.generate) await request('script_generate', requests.generate)
      },
      showSpeechError,
    )
    return true
  }
  const cancelGeneration = () => {
    void request('script_cancel').catch(showError)
  }
  const changeProjectVoice = (voice: string) => {
    if (refuseWhileBlocked()) return
    void operation(t('action.changeVoice'), () =>
      request('project_voice', projectVoicePayload(voice)),
    )
  }
  const loadVoices = useCallback(async (): Promise<VoiceList> => {
    try {
      return { status: 'ready', voices: (await request('speech_voices')).voices ?? [] }
    } catch (reason) {
      return { status: 'failed', error: messageOf(reason) }
    }
  }, [request])
  const saveSpeechPreferences = async (url: string, voice: string) => {
    if (operationBlocked) return t('error.waitForOperation')
    const outcome = { error: null as string | null }
    const saved = await operation(
      t('action.saveVoiceover'),
      () => request('speech_preferences_patch', { url, voice }),
      (reason) => {
        outcome.error = messageOf(reason)
      },
    )
    if (saved) setNotice(t('settings.voiceoverSaved'))
    return outcome.error
  }
  return {
    projectVoice,
    defaultVoice,
    speechUrl: snapshot?.config.speechUrl ?? '',
    scriptStatus,
    scriptClips,
    pendingScripts,
    generateScripts,
    addScriptClip,
    saveScript,
    cancelGeneration,
    changeProjectVoice,
    loadVoices,
    saveSpeechPreferences,
  }
}
