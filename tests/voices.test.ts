import { afterEach, describe, expect, it } from 'vitest'
import { setLanguagePreference, t } from '../src/i18n'
import { groupedVoiceOptions, voiceLabel, voiceMenu } from '../src/voices'

afterEach(() => setLanguagePreference('system'))

describe('voice labels', () => {
  it.each([
    ['af_bella', 'Bella', 'US female'],
    ['bf_v0emma', 'Emma', 'British female, v0'],
    ['am_price_inno', 'Price', 'US male, inno'],
    ['zm_yunxi', 'Yunxi', 'Mandarin Chinese male'],
    ['pf_dora', 'Dora', 'Brazilian Portuguese female'],
  ])('%s is %s, %s', (id, name, description) => {
    setLanguagePreference('en')
    expect(voiceLabel(id)).toEqual({ name, description })
  })
  it('shows ids that do not follow the Kokoro pattern unchanged', () => {
    for (const id of ['custom-voice', 'af_bella+am_adam', 'xf_bella', 'af_', 'af_v0', 'AF_BELLA'])
      expect(voiceLabel(id)).toEqual({ name: id, description: '' })
  })
  it('localizes accent and gender', () => {
    setLanguagePreference('de')
    expect(voiceLabel('bf_emma')).toEqual({
      name: 'Emma',
      description: t('voice.description', {
        accent: t('voice.accentBritish'),
        gender: t('voice.female'),
      }),
    })
    expect(voiceLabel('bf_emma').description).not.toContain('British')
  })
})

describe('voice options', () => {
  it('lists the six featured voices first, in order, with their description', () => {
    setLanguagePreference('en')
    const { featured, others } = groupedVoiceOptions([
      'bm_george',
      'bf_emma',
      'am_fenrir',
      'af_sky',
      'am_michael',
      'af_bella',
      'af_heart',
    ])
    expect(featured).toEqual([
      { id: 'af_heart', label: 'Heart (US female)' },
      { id: 'af_bella', label: 'Bella (US female)' },
      { id: 'am_michael', label: 'Michael (US male)' },
      { id: 'am_fenrir', label: 'Fenrir (US male)' },
      { id: 'bf_emma', label: 'Emma (British female)' },
      { id: 'bm_george', label: 'George (British male)' },
    ])
    expect(others).toEqual([{ id: 'af_sky', label: 'Sky (US female)' }])
  })
  it('skips featured voices the server does not list', () => {
    setLanguagePreference('en')
    const { featured, others } = groupedVoiceOptions(['bm_lewis', 'bm_george', 'af_bella'])
    expect(featured).toEqual([
      { id: 'af_bella', label: 'Bella (US female)' },
      { id: 'bm_george', label: 'George (British male)' },
    ])
    expect(others.map((option) => option.id)).toEqual(['bm_lewis'])
  })
  it('sorts the other voices by description, then name, without duplicates', () => {
    setLanguagePreference('en')
    const { featured, others } = groupedVoiceOptions([
      'am_michael',
      'bf_v0emma',
      'af_sky',
      'bm_lewis',
      'bf_isabella',
      'af_alloy',
      'af_sky',
      'bf_alice',
      'am_michael',
    ])
    expect(featured).toEqual([{ id: 'am_michael', label: 'Michael (US male)' }])
    expect(others).toEqual([
      { id: 'bf_alice', label: 'Alice (British female)' },
      { id: 'bf_isabella', label: 'Isabella (British female)' },
      { id: 'bf_v0emma', label: 'Emma (British female, v0)' },
      { id: 'bm_lewis', label: 'Lewis (British male)' },
      { id: 'af_alloy', label: 'Alloy (US female)' },
      { id: 'af_sky', label: 'Sky (US female)' },
    ])
  })
  it('shows unknown voices by their id', () => {
    setLanguagePreference('en')
    expect(groupedVoiceOptions(['my_custom_voice']).others).toEqual([
      { id: 'my_custom_voice', label: 'my_custom_voice' },
    ])
  })
})

describe('voice menu', () => {
  const listed = ['bf_isabella', 'af_heart', 'am_michael', 'bm_lewis']
  it('checks the current voice at the top level and inside Other voices', () => {
    setLanguagePreference('en')
    expect(voiceMenu(listed, 'af_heart')).toEqual({
      current: 'Heart',
      top: [
        { id: 'af_heart', label: 'Heart (US female)', checked: true },
        { id: 'am_michael', label: 'Michael (US male)', checked: false },
      ],
      others: [
        { id: 'bf_isabella', label: 'Isabella (British female)', checked: false },
        { id: 'bm_lewis', label: 'Lewis (British male)', checked: false },
      ],
    })
    const nested = voiceMenu(listed, 'bm_lewis')
    expect(nested.current).toBe('Lewis')
    expect(nested.top.some((entry) => entry.checked)).toBe(false)
    expect(nested.others.filter((entry) => entry.checked).map((entry) => entry.id)).toEqual([
      'bm_lewis',
    ])
  })
  it('starts with the default choice and keeps a voice the server no longer lists', () => {
    setLanguagePreference('en')
    const projectDefault = voiceMenu(listed, '', 'Default (Heart)')
    expect(projectDefault.current).toBe('Default (Heart)')
    expect(projectDefault.top[0]).toEqual({ id: '', label: 'Default (Heart)', checked: true })
    const missing = voiceMenu(listed, 'af_nicole', 'Default (Heart)')
    expect(missing.current).toBe('Nicole')
    expect(missing.top.slice(0, 2)).toEqual([
      { id: '', label: 'Default (Heart)', checked: false },
      { id: 'af_nicole', label: 'Nicole (US female)', checked: true },
    ])
  })
})
