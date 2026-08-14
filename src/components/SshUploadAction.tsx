/**
 * Per-item "send to SSH target" action.
 *
 * With a single target configured this is a one-click button. With several it
 * opens a small target menu — rendered through a portal because `.item` sets
 * `overflow: hidden` *and* a hover transform, which together clip both absolutely
 * and fixed-positioned descendants. The menu is positioned from the button's
 * viewport rect and clamped to stay inside the 384px panel.
 *
 * Renders nothing when no targets exist, so the feature stays invisible until
 * the user configures one.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/appStore'
import { playButtonClickSound } from '../lib/soundEffects'
import { ServerIcon, SpinnerIcon } from './icons'
import { t } from '../i18n'
import '../styles/ssh.css'

interface Props {
  itemId: string
  /** Narrow the upload to one file of a bundle. */
  paths?: string[]
  /** Narrow the upload to one image of a collection. */
  imageId?: string
}

const MENU_WIDTH = 168
const MENU_MARGIN = 8

export function SshUploadAction({ itemId, paths, imageId }: Props) {
  const profiles = useStore((s) => s.settings.sshProfiles)
  const defaultId = useStore((s) => s.settings.defaultSshProfileId)
  const uploading = useStore((s) => s.uploadingIds.includes(itemId))
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const upload = useCallback((profileId: string) => {
    playButtonClickSound()
    setMenuAt(null)
    void useStore.getState().uploadToSsh({ id: itemId, profileId, paths, imageId })
  }, [itemId, paths, imageId])

  const openMenu = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    playButtonClickSound()
    setMenuAt({
      top: rect.bottom + 6,
      left: Math.max(MENU_MARGIN, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - MENU_MARGIN))
    })
  }, [])

  // Dismiss on any outside interaction, scroll, or Escape.
  useEffect(() => {
    if (!menuAt) return
    const close = (e: Event): void => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      setMenuAt(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuAt(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuAt])

  // Keep the menu on screen when it would run past the bottom edge.
  useLayoutEffect(() => {
    if (!menuAt || !menuRef.current) return
    const h = menuRef.current.offsetHeight
    const maxTop = window.innerHeight - h - MENU_MARGIN
    if (menuAt.top > maxTop) setMenuAt({ ...menuAt, top: Math.max(MENU_MARGIN, maxTop) })
  }, [menuAt])

  // Closing the panel leaves an orphaned portal otherwise.
  const panelOpen = useStore((s) => s.open)
  useEffect(() => {
    if (!panelOpen) setMenuAt(null)
  }, [panelOpen])

  if (profiles.length === 0) return null

  const only = profiles.length === 1 ? profiles[0] : null
  const fallback = profiles.find((p) => p.id === defaultId) ?? profiles[0]
  const title = only
    ? t('ssh.uploadTo').replace('{name}', only.name)
    : t('ssh.chooseTarget')

  return (
    <>
      <button
        ref={btnRef}
        className={`act${menuAt ? ' active' : ''}`}
        title={title}
        disabled={uploading}
        onClick={(e) => {
          e.stopPropagation()
          e.currentTarget.blur()
          if (only) upload(only.id)
          else if (menuAt) setMenuAt(null)
          else openMenu()
        }}
        // Shift-click skips the menu and uses the default target.
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.stopPropagation()
          upload(fallback.id)
        }}
      >
        {uploading ? <SpinnerIcon className="ssh-spin" /> : <ServerIcon />}
      </button>

      {menuAt && createPortal(
        <div
          ref={menuRef}
          className="ssh-target-menu"
          style={{ top: menuAt.top, left: menuAt.left, width: MENU_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ssh-target-menu-head">{t('ssh.chooseTarget')}</div>
          {profiles.map((p) => (
            <button
              key={p.id}
              className="ssh-target-menu-row"
              onClick={(e) => {
                e.stopPropagation()
                upload(p.id)
              }}
            >
              <span className="ssh-target-name">{p.name}</span>
              {p.hotkey && <span className="ssh-target-chord">{p.hotkey}</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
