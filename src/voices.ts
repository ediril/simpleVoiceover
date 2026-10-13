import { t, type TranslationKey } from './i18n'

export const featuredVoices: readonly string[] = [
  'af_heart',
  'af_bella',
  'am_michael',
  'am_fenrir',
  'bf_emma',
  'bm_george',
]

const accents: Readonly<Record<string, TranslationKey>> = {
  a: 'voice.accentAmerican',
  b: 'voice.accentBritish',
  e: 'voice.accentSpanish',
  f: 'voice.accentFrench',
  h: 'voice.accentHindi',
  i: 'voice.accentItalian',
  j: 'voice.accentJapanese',
  p: 'voice.accentBrazilian',
  z: 'voice.accentMandarin',
}

const genders: Readonly<Record<string, TranslationKey>> = {
  f: 'voice.female',
  m: 'voice.male',
}

const voiceIdPattern = /^([abefhijpz])([fm])_(v0)?([a-z]+)(?:_(inno))?$/

export interface VoiceLabel {
  name: string
  description: string
}

export interface VoiceOption {
  id: string
  label: string
}

export function voiceLabel(id: string): VoiceLabel {
  const match = voiceIdPattern.exec(id)
  if (!match) return { name: id, description: '' }
  const [, accent, gender, version, name, edition] = match
  const description = t('voice.description', {
    accent: t(accents[accent]),
    gender: t(genders[gender]),
  })
  const variant = version ?? edition
  return {
    name: name[0].toUpperCase() + name.slice(1),
    description: variant ? t('voice.withVariant', { description, variant }) : description,
  }
}

export const voiceName = (id: string) => voiceLabel(id).name

function voiceOption({ id, name, description }: VoiceLabel & { id: string }): VoiceOption {
  return { id, label: description ? t('voice.option', { name, description }) : name }
}

export function groupedVoiceOptions(ids: readonly string[]) {
  const listed = new Set(ids)
  const featured = featuredVoices
    .filter((id) => listed.has(id))
    .map((id) => voiceOption({ id, ...voiceLabel(id) }))
  const others = [...listed]
    .filter((id) => !featuredVoices.includes(id))
    .map((id) => ({ id, ...voiceLabel(id) }))
    .sort(
      (left, right) =>
        left.description.localeCompare(right.description) || left.name.localeCompare(right.name),
    )
    .map(voiceOption)
  return { featured, others }
}

export interface VoiceMenuEntry extends VoiceOption {
  checked: boolean
}

export interface VoiceMenu {
  current: string
  top: VoiceMenuEntry[]
  others: VoiceMenuEntry[]
}

export function voiceMenu(ids: readonly string[], value: string, defaultLabel?: string): VoiceMenu {
  const { featured, others } = groupedVoiceOptions(ids)
  const leading: VoiceOption[] = [
    ...(defaultLabel === undefined ? [] : [{ id: '', label: defaultLabel }]),
    ...(value && !ids.includes(value) ? [voiceOption({ id: value, ...voiceLabel(value) })] : []),
  ]
  const entry = (option: VoiceOption) => ({ ...option, checked: option.id === value })
  return {
    current: !value && defaultLabel !== undefined ? defaultLabel : voiceName(value),
    top: [...leading, ...featured].map(entry),
    others: others.map(entry),
  }
}
