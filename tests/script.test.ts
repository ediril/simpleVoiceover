import { describe, expect, it } from 'vitest'
import {
  estimatedSpeechSeconds,
  fillRatio,
  generationReducer,
  isGenerating,
  isSpeechUnavailable,
  pendingScriptClips,
  projectVoicePayload,
  scriptClipStatus,
  scriptDraftRange,
  scriptDrawTarget,
  scriptSaveRequests,
  singleLineText,
  type ActiveGeneration,
  type ActiveGenerations,
  type ScriptClip,
} from '../src/timeline/script'
import { editedClip, sourceDuration } from '../src/timeline/clipEdit'
import { neutralEffects, type Clip, type Track } from '../src/types'
import type { GenerationEvent } from '../src/protocol'

const scriptClip = (overrides: Partial<ScriptClip> = {}): ScriptClip => ({
  id: 'clip',
  assetId: 'take',
  name: '',
  start: 2,
  offset: 0,
  duration: 4,
  script: { text: 'Hello there', take: { text: 'Hello there', voice: 'af_heart' } },
  ...overrides,
})

const track = (id: string, clips: Clip[], locked = false): Track => ({
  id,
  name: 'track.voice',
  kind: 'voice',
  color: '#fff',
  mute: false,
  solo: false,
  locked,
  armed: false,
  fxBypass: true,
  volume: 0,
  pan: 0,
  effects: neutralEffects,
  clips,
})

describe('script clip status', () => {
  const generating: ActiveGeneration = { state: 'generating', progress: 0.4 }
  const queued: ActiveGeneration = { state: 'queued', progress: 0 }
  const cases: {
    name: string
    clip: ScriptClip
    asset?: { duration: number }
    voice?: string
    generation?: ActiveGeneration
    expected: ReturnType<typeof scriptClipStatus>
  }[] = [
    {
      name: 'generating wins over a stale overflowing take',
      clip: scriptClip({ script: { text: 'New', take: { text: 'Old', voice: 'af_heart' } } }),
      asset: { duration: 9 },
      generation: generating,
      expected: { state: 'generating', progress: 0.4 },
    },
    {
      name: 'queued wins over a missing take',
      clip: scriptClip({ assetId: null, script: { text: 'Hello' } }),
      generation: queued,
      expected: { state: 'queued' },
    },
    {
      name: 'draft without a take',
      clip: scriptClip({ assetId: null, script: { text: 'Hello' } }),
      expected: { state: 'draft' },
    },
    {
      name: 'draft when the take audio is missing',
      clip: scriptClip(),
      expected: { state: 'draft' },
    },
    {
      name: 'stale when the text changed, even if the audio overflows',
      clip: scriptClip({
        script: { text: 'Hello again', take: { text: 'Hello there', voice: 'af_heart' } },
      }),
      asset: { duration: 6 },
      expected: { state: 'stale' },
    },
    {
      name: 'stale when the effective voice changed',
      clip: scriptClip(),
      asset: { duration: 3 },
      voice: 'bm_george',
      expected: { state: 'stale' },
    },
    {
      name: 'overflow beyond the tolerance',
      clip: scriptClip(),
      asset: { duration: 5.25 },
      expected: { state: 'overflow', overflowSeconds: 1.25 },
    },
    {
      name: 'fits within the tolerance',
      clip: scriptClip(),
      asset: { duration: 4.009 },
      expected: { state: 'fits' },
    },
    {
      name: 'fits when shorter than the box',
      clip: scriptClip(),
      asset: { duration: 2 },
      expected: { state: 'fits' },
    },
  ]
  it.each(cases)('$name', ({ clip, asset, voice, generation, expected }) => {
    expect(scriptClipStatus(clip, asset, voice ?? 'af_heart', generation)).toEqual(expected)
  })
})

describe('speech estimate and fill bar', () => {
  it('estimates 2.5 words per second, ignoring extra whitespace', () => {
    expect(estimatedSpeechSeconds('')).toBe(0)
    expect(estimatedSpeechSeconds('  one   two\tthree four five  ')).toBe(2)
    expect(estimatedSpeechSeconds('word '.repeat(10))).toBe(4)
  })
  it('switches from ok to tight at 0.85 and to over above 1', () => {
    const tenWords = 'word '.repeat(10)
    expect(fillRatio(tenWords, 8)).toEqual({ ratio: 0.5, level: 'ok' })
    expect(fillRatio(tenWords, 4 / 0.84).level).toBe('ok')
    expect(fillRatio(tenWords, 4 / 0.85).level).toBe('tight')
    expect(fillRatio(tenWords, 4)).toEqual({ ratio: 1, level: 'tight' })
    expect(fillRatio(tenWords, 3.9).level).toBe('over')
  })
})

describe('generation reducer', () => {
  const event = (
    clipId: string,
    state: GenerationEvent['state'],
    progress = 0,
  ): GenerationEvent => ({ clipId, state, progress })
  it('tracks queued and generating clips until done, failed or cancelled', () => {
    let active: ActiveGenerations = {}
    active = generationReducer(active, event('a', 'queued'))
    active = generationReducer(active, event('b', 'queued'))
    active = generationReducer(active, event('c', 'queued'))
    expect(isGenerating(active)).toBe(true)
    active = generationReducer(active, event('a', 'generating', 0.3))
    expect(active.a).toEqual({ state: 'generating', progress: 0.3 })
    active = generationReducer(active, event('a', 'generating', 0.6))
    expect(active.a).toEqual({ state: 'generating', progress: 0.6 })
    active = generationReducer(active, event('a', 'done', 1))
    expect(Object.keys(active)).toEqual(['b', 'c'])
    active = generationReducer(active, { ...event('b', 'failed'), error: 'boom' })
    expect(Object.keys(active)).toEqual(['c'])
    expect(isGenerating(active)).toBe(true)
    active = generationReducer(active, event('c', 'cancelled'))
    expect(active).toEqual({})
    expect(isGenerating(active)).toBe(false)
  })
  it('keeps the same state for finished events of unknown clips', () => {
    const active: ActiveGenerations = { a: { state: 'queued', progress: 0 } }
    expect(generationReducer(active, event('z', 'cancelled'))).toBe(active)
  })
})

describe('script clip commands', () => {
  it('queues only unlocked draft or stale clips with text, in time order', () => {
    const late = scriptClip({ id: 'late', start: 9, assetId: null, script: { text: 'Later' } })
    const early = scriptClip({
      id: 'early',
      start: 1,
      script: { text: 'Changed', take: { text: 'Hello there', voice: 'af_heart' } },
    })
    const empty = scriptClip({ id: 'empty', assetId: null, script: { text: '   ' } })
    const ready = scriptClip({ id: 'ready' })
    const busy = scriptClip({ id: 'busy', assetId: null, script: { text: 'Queued text' } })
    const locked = scriptClip({ id: 'locked', assetId: null, script: { text: 'Locked' } })
    const recording: Clip = {
      id: 'recording',
      assetId: 'take',
      name: 'Take',
      start: 0,
      offset: 0,
      duration: 2,
    }
    const tracks = [
      track('voice', [late, empty, ready, busy, recording]),
      track('music', [early]),
      track('locked', [locked], true),
    ]
    const status = (clip: ScriptClip) =>
      scriptClipStatus(
        clip,
        clip.assetId ? { duration: 3 } : undefined,
        'af_heart',
        clip.id === 'busy' ? { state: 'queued', progress: 0 } : undefined,
      )
    expect(pendingScriptClips(tracks, status)).toEqual([
      { trackId: 'music', clipId: 'early' },
      { trackId: 'voice', clipId: 'late' },
    ])
  })
  it('clears the project voice by omitting it', () => {
    expect(projectVoicePayload('')).toEqual({})
    expect(projectVoicePayload('bf_emma')).toEqual({ voice: 'bf_emma' })
  })
  it('creates a four second clip on click and a snapped range of at least 0.25 s on drag', () => {
    expect(scriptDraftRange(3, 3.01, false)).toEqual({ position: 3, duration: 4 })
    expect(scriptDraftRange(6, 2, true)).toEqual({ position: 2, duration: 4 })
    expect(scriptDraftRange(2, 2.1, true)).toEqual({ position: 2, duration: 0.25 })
  })
  it('keeps edited script text on one line', () => {
    expect(singleLineText('First line\nsecond\r\n\nthird')).toBe('First line second third')
  })
  it('recognises the engine Kokoro error only', () => {
    expect(isSpeechUnavailable(new Error('[[error.speechUnavailable|7b7d]]'))).toBe(true)
    expect(isSpeechUnavailable('[[error.speechFailed|7b7d]]')).toBe(false)
  })
})

describe('saving script text', () => {
  const clip = scriptClip({ script: { text: 'Hello there' } })
  it('patches changed text as one trimmed line and queues it on Enter', () => {
    expect(scriptSaveRequests('voice', clip, '  New\nline  ', true)).toEqual({
      patch: { trackId: 'voice', clipId: 'clip', text: 'New line' },
      generate: { clips: [{ trackId: 'voice', clipId: 'clip' }] },
    })
  })
  it('queues unchanged text on Enter without patching it', () => {
    expect(scriptSaveRequests('voice', clip, 'Hello there ', true)).toEqual({
      patch: null,
      generate: { clips: [{ trackId: 'voice', clipId: 'clip' }] },
    })
  })
  it('saves without generating when clicking away, and never generates empty text', () => {
    expect(scriptSaveRequests('voice', clip, 'Hello there', false)).toEqual({
      patch: null,
      generate: null,
    })
    expect(scriptSaveRequests('voice', clip, '   ', true)).toEqual({
      patch: { trackId: 'voice', clipId: 'clip', text: '' },
      generate: null,
    })
  })
})

describe('script drawing target', () => {
  it('draws only on existing, unlocked, non-video tracks', () => {
    const audio = track('audio', [])
    const video = { ...track('video', []), kind: 'video' as const }
    const tracks = [audio, video, track('locked', [], true)]
    expect(scriptDrawTarget(tracks, 'audio')).toBe(audio)
    expect(scriptDrawTarget(tracks, 'video')).toBeUndefined()
    expect(scriptDrawTarget(tracks, 'locked')).toBeUndefined()
    expect(scriptDrawTarget(tracks, 'removed')).toBeUndefined()
  })
})

describe('script clip resizing', () => {
  const asset = { duration: 3 }
  it('extends a script slot past its take audio and keeps at least 0.25 s', () => {
    const clip = scriptClip()
    const source = sourceDuration(clip, asset)
    expect(editedClip(clip, 'right', 6, source).duration).toBe(10)
    expect(editedClip(clip, 'right', -10, source).duration).toBe(0.25)
    expect(editedClip(clip, 'left', 10, source)).toMatchObject({
      start: 5.75,
      offset: 0,
      duration: 0.25,
    })
    expect(editedClip(clip, 'left', -5, source)).toMatchObject({
      start: 0,
      offset: 0,
      duration: 6,
    })
  })
  it('still limits recorded clips by their source audio', () => {
    const clip: Clip = { id: 'take', assetId: 'take', name: '', start: 2, offset: 1, duration: 1 }
    const source = sourceDuration(clip, asset)
    expect(editedClip(clip, 'right', 6, source).duration).toBe(2)
    expect(editedClip(clip, 'left', -5, source)).toMatchObject({
      start: 1,
      offset: 0,
      duration: 2,
    })
  })
})
