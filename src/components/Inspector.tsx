import { localizedName, t } from '../i18n'
import EffectsPanel from '../EffectsPanel'
import FilesPanel from './FilesPanel'
import MixerPanel from './MixerPanel'
import ScriptPanel from './ScriptPanel'
import type { StudioController } from '../useStudio'

export default function Inspector(panel: StudioController) {
  const { tracks, selectedTrackId, setSelectedTrackId, tab, setTab, selectedTrack, updateTrack } =
    panel
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist" aria-label={t('inspector.panels')}>
        {[
          ['files', t('inspector.files')],
          ['mixer', t('inspector.mixer')],
          ['effects', t('inspector.effects')],
          ['script', t('inspector.script')],
        ].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === 'files' && <FilesPanel {...panel} />}
        {tab === 'mixer' && <MixerPanel {...panel} />}
        {tab === 'script' && <ScriptPanel {...panel} />}
        {tab === 'effects' && selectedTrack && (
          <>
            <div className="selected-track">
              <span className="eyebrow">{t('inspector.track')}</span>
              <select
                aria-label={t('inspector.effectsTrack')}
                value={selectedTrackId}
                onChange={(e) => setSelectedTrackId(e.target.value)}
              >
                {tracks.map((t) => (
                  <option value={t.id} key={t.id}>
                    {localizedName(t.name)}
                  </option>
                ))}
              </select>
              <span className="track-color" style={{ background: selectedTrack.color }} />
            </div>
            <EffectsPanel
              key={selectedTrack.id}
              track={selectedTrack}
              onChange={(patch) => updateTrack(selectedTrack.id, patch)}
              presets={panel.effectPresets}
              onSavePreset={panel.savePreset}
              operationPending={panel.operationPending}
            />
          </>
        )}
        {tab === 'effects' && !selectedTrack && (
          <p className="hint muted">{t('effects.noTrack')}</p>
        )}
      </div>
      <div className="inspector-foot">
        <span className="small-dot" />
        {t('inspector.footer')}{' '}
      </div>
    </aside>
  )
}
