import { useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import { CheckMenuItem, Menu, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import { ChevronDown } from 'lucide-react'
import { t } from '../i18n'
import { voiceMenu, type VoiceMenu, type VoiceMenuEntry } from '../voices'

interface Props {
  value: string
  voices: readonly string[]
  disabled?: boolean
  label: string
  defaultLabel?: string
  onChange: (voice: string) => void
}

interface NativeResource {
  close: () => Promise<void>
}

const closeAll = (resources: readonly NativeResource[]) =>
  Promise.all(resources.map((resource) => resource.close().catch(() => {})))

async function buildNativeMenu(
  menu: VoiceMenu,
  choose: (voice: string) => void,
  created: NativeResource[],
) {
  const keep = <T extends NativeResource>(resource: T) => {
    created.push(resource)
    return resource
  }
  const checkItem = (entry: VoiceMenuEntry) =>
    CheckMenuItem.new({
      text: entry.label,
      checked: entry.checked,
      action: () => choose(entry.id),
    }).then(keep)
  const top = await Promise.all(menu.top.map(checkItem))
  const others = await Promise.all(menu.others.map(checkItem))
  const separator =
    top.length && others.length ? [keep(await PredefinedMenuItem.new({ item: 'Separator' }))] : []
  const submenu = others.length
    ? [keep(await Submenu.new({ text: t('voice.otherVoices'), items: others }))]
    : []
  return keep(await Menu.new({ items: [...top, ...separator, ...submenu] }))
}

function NativeVoiceMenu({
  menu,
  disabled,
  label,
  onChange,
  onUnavailable,
}: {
  menu: VoiceMenu
  disabled?: boolean
  label: string
  onChange: (voice: string) => void
  onUnavailable: () => void
}) {
  const shown = useRef<NativeResource[]>([])
  const opening = useRef(false)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  })
  useEffect(
    () => () => {
      void closeAll(shown.current)
      shown.current = []
    },
    [],
  )
  const open = async (trigger: HTMLButtonElement) => {
    if (disabled || opening.current) return
    opening.current = true
    const created: NativeResource[] = []
    try {
      await closeAll(shown.current)
      shown.current = created
      const native = await buildNativeMenu(menu, (voice) => change.current(voice), created)
      const bounds = trigger.getBoundingClientRect()
      await native.popup(new LogicalPosition(bounds.left, bounds.bottom))
    } catch (reason) {
      await closeAll(created)
      throw reason
    } finally {
      opening.current = false
    }
  }
  return (
    <button
      type="button"
      className="voice-select"
      aria-haspopup="menu"
      aria-label={t('voice.picker', { field: label, voice: menu.current })}
      disabled={disabled}
      onClick={(event) => void open(event.currentTarget).catch(onUnavailable)}
    >
      <span>{menu.current}</span>
      <ChevronDown size={14} />
    </button>
  )
}

export default function VoiceSelect({
  value,
  voices,
  disabled,
  label,
  defaultLabel,
  onChange,
}: Props) {
  const [nativeMenuFailed, setNativeMenuFailed] = useState(false)
  const menu = voiceMenu(voices, value, defaultLabel)
  if (isTauri() && !nativeMenuFailed)
    return (
      <NativeVoiceMenu
        menu={menu}
        disabled={disabled}
        label={label}
        onChange={onChange}
        onUnavailable={() => setNativeMenuFailed(true)}
      />
    )
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {menu.top.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
      {menu.others.length > 0 && (
        <optgroup label={t('voice.otherVoices')}>
          {menu.others.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}
