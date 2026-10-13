import { describe, expect, it } from 'vitest'
import {
  displayedGenerations,
  estimatedProgress,
  estimatedSpeechSeconds,
  expectedGenerationSeconds,
  fillRatio,
  generationReducer,
  idleGenerationTracker,
  initialSpeedFactor,
  isGenerating,
  isSpeechUnavailable,
  pendingScriptClips,
  projectVoicePayload,
  scriptClipStatus,
  scriptDraftRange,
  scriptDrawTarget,
  scriptRowAction,
  scriptSaveRequests,
  singleLineText,
  updatedSpeedFactor,
  type ActiveGeneration,
  type GenerationTracker,
  type ScriptClip,
  type ScriptClipState,
  type ScriptRowAction,
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
  const apply = (tracker: GenerationTracker, value: GenerationEvent, at = 0, clip?: ScriptClip) =>
    generationReducer(tracker, { type: 'event', event: value, at, clip })
  it('tracks queued and generating clips until done, failed or cancelled', () => {
    let tracker = idleGenerationTracker
    tracker = apply(tracker, event('a', 'queued'))
    tracker = apply(tracker, event('b', 'queued'))
    tracker = apply(tracker, event('c', 'queued'))
    expect(isGenerating(tracker.active)).toBe(true)
    tracker = apply(tracker, event('a', 'generating', 0.3))
    expect(tracker.active.a).toMatchObject({ state: 'generating', progress: 0.3 })
    tracker = apply(tracker, event('a', 'generating', 0.6))
    expect(tracker.active.a).toMatchObject({ state: 'generating', progress: 0.6 })
    tracker = apply(tracker, event('a', 'done', 1))
    expect(Object.keys(tracker.active)).toEqual(['b', 'c'])
    tracker = apply(tracker, { ...event('b', 'failed'), error: 'boom' })
    expect(Object.keys(tracker.active)).toEqual(['c'])
    expect(isGenerating(tracker.active)).toBe(true)
    tracker = apply(tracker, event('c', 'cancelled'))
    expect(tracker.active).toEqual({})
    expect(isGenerating(tracker.active)).toBe(false)
  })
  it('keeps the same state for finished events of unknown clips', () => {
    const tracker = apply(idleGenerationTracker, event('a', 'queued'))
    expect(apply(tracker, event('z', 'cancelled'))).toBe(tracker)
  })
  it('records the start time and expected duration once, when a clip starts generating', () => {
    const tenWords = scriptClip({ script: { text: 'word '.repeat(10).trim() } })
    let tracker = apply(idleGenerationTracker, event('clip', 'queued'), 500, tenWords)
    tracker = apply(tracker, event('clip', 'generating'), 1000, tenWords)
    tracker = apply(tracker, event('clip', 'generating', 0.2), 3000, tenWords)
    expect(tracker.active.clip).toEqual({
      state: 'generating',
      progress: 0.2,
      startedAt: 1000,
      expectedSeconds: 8,
      previousAssetId: 'take',
    })
  })
  it('learns the speed factor from the finished take in a later snapshot', () => {
    const before = scriptClip({ script: { text: 'word '.repeat(10).trim() } })
    let tracker = apply(idleGenerationTracker, event('clip', 'generating'), 1000, before)
    tracker = apply(tracker, event('clip', 'done', 1), 15000, before)
    const snapshot = (clip: ScriptClip, duration: number) =>
      generationReducer(tracker, {
        type: 'snapshot',
        tracks: [track('voice', [clip])],
        assets: [{ id: clip.assetId ?? '', duration }],
      })
    expect(snapshot(before, 9)).toBe(tracker)
    const learned = snapshot({ ...before, assetId: 'new take' }, 3.5)
    expect(learned.speedFactor).toEqual({ value: 4, samples: 1 })
    expect(learned.finished).toEqual({})
    const next = apply(learned, event('other', 'generating'), 0, before)
    expect(next.active.other).toMatchObject({ expectedSeconds: 16 })
  })
  it('forgets finished clips that were removed before their take arrived', () => {
    let tracker = apply(idleGenerationTracker, event('clip', 'generating'), 0, scriptClip())
    tracker = apply(tracker, event('clip', 'done', 1), 2000)
    const forgotten = generationReducer(tracker, { type: 'snapshot', tracks: [], assets: [] })
    expect(forgotten.finished).toEqual({})
    expect(forgotten.speedFactor).toEqual(idleGenerationTracker.speedFactor)
  })
})

describe('generation progress estimate', () => {
  it('expects the speech estimate multiplied by the speed factor', () => {
    expect(initialSpeedFactor).toBe(2)
    expect(expectedGenerationSeconds('word '.repeat(10), initialSpeedFactor)).toBe(8)
    expect(expectedGenerationSeconds('word '.repeat(10), 3.5)).toBe(14)
  })
  it('grows with elapsed time and stops at 95 % until the engine finishes', () => {
    expect(estimatedProgress(0, 0, 8)).toBe(0)
    expect(estimatedProgress(0, 2, 8)).toBe(0.25)
    expect(estimatedProgress(0, 7.5, 8)).toBeCloseTo(0.9375)
    expect(estimatedProgress(0, 8, 8)).toBe(0.95)
    expect(estimatedProgress(0, 60, 8)).toBe(0.95)
    expect(estimatedProgress(0, -1, 8)).toBe(0)
  })
  it('never shows less than the engine reports', () => {
    expect(estimatedProgress(0.6, 2, 8)).toBe(0.6)
    expect(estimatedProgress(0.1, 4, 8)).toBe(0.5)
    expect(estimatedProgress(0.97, 60, 8)).toBe(0.97)
    expect(estimatedProgress(0.4, 3, 0)).toBe(0.4)
  })
  it('replaces the starting factor with the first measurement, then smooths', () => {
    const first = updatedSpeedFactor({ value: 2, samples: 0 }, 14, 3.5)
    expect(first).toEqual({ value: 4, samples: 1 })
    const second = updatedSpeedFactor(first, 12, 2)
    expect(second).toEqual({ value: 5, samples: 2 })
    const settled = updatedSpeedFactor({ value: 3, samples: 9 }, 10, 2)
    expect(settled.value).toBeCloseTo(3.6)
    expect(settled.samples).toBe(10)
  })
  it('ignores measurements without elapsed time or speech', () => {
    const current = { value: 3, samples: 2 }
    expect(updatedSpeedFactor(current, 0, 2)).toBe(current)
    expect(updatedSpeedFactor(current, 5, 0)).toBe(current)
    expect(updatedSpeedFactor(current, Number.NaN, 2)).toBe(current)
  })
  it('shows the time estimate for generating clips and leaves queued clips alone', () => {
    const queued: ActiveGeneration = { state: 'queued', progress: 0 }
    const active: GenerationTracker['active'] = {
      queued,
      running: {
        state: 'generating',
        progress: 0.1,
        startedAt: 1000,
        expectedSeconds: 8,
        previousAssetId: null,
      },
    }
    expect(displayedGenerations(active, 5000)).toEqual({
      queued,
      running: { state: 'generating', progress: 0.5 },
    })
    expect(displayedGenerations(active, 60000).running.progress).toBe(0.95)
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
  it('draws only on existing, unlocked voice tracks', () => {
    const voice = track('voice', [])
    const audio = { ...track('audio', []), kind: 'audio' as const }
    const video = { ...track('video', []), kind: 'video' as const }
    const tracks = [voice, audio, video, track('locked', [], true)]
    expect(scriptDrawTarget(tracks, 'voice')).toBe(voice)
    expect(scriptDrawTarget(tracks, 'audio')).toBeUndefined()
    expect(scriptDrawTarget(tracks, 'video')).toBeUndefined()
    expect(scriptDrawTarget(tracks, 'locked')).toBeUndefined()
    expect(scriptDrawTarget(tracks, 'removed')).toBeUndefined()
  })
})

describe('script list row action', () => {
  const cases: {
    state: ScriptClipState
    text: string
    locked: boolean
    expected: ScriptRowAction | null
  }[] = [
    { state: 'draft', text: 'Hello', locked: false, expected: 'generate' },
    { state: 'draft', text: '   ', locked: false, expected: null },
    { state: 'draft', text: 'Hello', locked: true, expected: null },
    { state: 'stale', text: 'Hello', locked: false, expected: 'regenerate' },
    { state: 'stale', text: '', locked: false, expected: null },
    { state: 'stale', text: 'Hello', locked: true, expected: null },
    { state: 'queued', text: 'Hello', locked: false, expected: 'stop' },
    { state: 'generating', text: 'Hello', locked: false, expected: 'stop' },
    { state: 'generating', text: 'Hello', locked: true, expected: 'stop' },
    { state: 'fits', text: 'Hello', locked: false, expected: null },
    { state: 'overflow', text: 'Hello', locked: false, expected: null },
  ]
  it.each(cases)(
    '$state with "$text", locked $locked: $expected',
    ({ state, text, locked, expected }) => {
      expect(scriptRowAction(state, text, locked)).toBe(expected)
    },
  )
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
