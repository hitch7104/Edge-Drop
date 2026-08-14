/**
 * One-time import of SSH targets from the standalone clip2ssh tray app.
 *
 * clip2ssh (`%APPDATA%/clip2ssh/config.json`) was the predecessor of this
 * feature: a WinForms tray utility that scp'd the clipboard image to one of
 * several hosts. Its profile schema maps 1:1 onto `SshProfile`, so rather than
 * make the user retype four targets and four hotkeys we read the old file once
 * and convert it.
 *
 * Kept in its own module so it can simply be deleted once no installs carry a
 * clip2ssh config, without touching any shared file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SSH_PROFILE, type Settings, type SshProfile } from '../../shared/types'
import { createId } from './ids'
import { loadSettings, saveSettings } from './settings'

/** Shape of one entry in clip2ssh's config.json (DataContract PascalCase). */
interface LegacyProfile {
  Id?: string
  Name?: string
  Host?: string
  User?: string
  Port?: number
  RemoteDir?: string
  Hotkey?: number
  FileNamePattern?: string
  ImageFormat?: string
  JpgQuality?: number
  ReplaceClipboard?: boolean
  Notify?: boolean
  LegacyScp?: boolean
}

interface LegacyConfig {
  Profiles?: LegacyProfile[]
  DefaultProfileId?: string
}

// System.Windows.Forms.Keys modifier bits. Note there is no Win-key bit —
// clip2ssh could not bind Win chords either, so nothing is lost here.
const KEYS_SHIFT = 0x00010000
const KEYS_CONTROL = 0x00020000
const KEYS_ALT = 0x00040000
const KEYS_KEYCODE = 0x0000ffff

/** Virtual-key codes that need an explicit Electron accelerator name. */
const VK_NAMES: Readonly<Record<number, string>> = {
  0x08: 'Backspace',
  0x09: 'Tab',
  0x0d: 'Return',
  0x1b: 'Escape',
  0x20: 'Space',
  0x21: 'PageUp',
  0x22: 'PageDown',
  0x23: 'End',
  0x24: 'Home',
  0x25: 'Left',
  0x26: 'Up',
  0x27: 'Right',
  0x28: 'Down',
  0x2d: 'Insert',
  0x2e: 'Delete',
  0xba: ';',
  0xbb: '=',
  0xbc: ',',
  0xbd: '-',
  0xbe: '.',
  0xbf: '/',
  0xc0: '~',
  0xdb: '[',
  0xdc: '\\',
  0xdd: ']',
  0xde: "'"
}

/**
 * Convert a packed `System.Windows.Forms.Keys` integer into an Electron
 * accelerator string. Returns '' for a chord Electron cannot express, which the
 * caller treats as "imported without a hotkey" rather than a hard failure.
 */
export function keysIntToAccelerator(packed: number): string {
  if (!Number.isFinite(packed) || packed <= 0) return ''
  const mods: string[] = []
  if (packed & KEYS_CONTROL) mods.push('Ctrl')
  if (packed & KEYS_ALT) mods.push('Alt')
  if (packed & KEYS_SHIFT) mods.push('Shift')

  const vk = packed & KEYS_KEYCODE
  let key = ''
  if (vk >= 0x41 && vk <= 0x5a) key = String.fromCharCode(vk)          // A-Z
  else if (vk >= 0x30 && vk <= 0x39) key = String.fromCharCode(vk)     // 0-9
  else if (vk >= 0x60 && vk <= 0x69) key = `num${vk - 0x60}`           // numpad 0-9
  else if (vk >= 0x70 && vk <= 0x87) key = `F${vk - 0x6f}`             // F1-F24
  else key = VK_NAMES[vk] ?? ''

  // Electron refuses a bare key as a global shortcut for good reason: it would
  // swallow that key everywhere. Require at least one modifier.
  if (!key || mods.length === 0) return ''
  return [...mods, key].join('+')
}

/** Path to the legacy config, or null when clip2ssh was never installed. */
function legacyConfigPath(): string | null {
  const appData = process.env.APPDATA
  if (!appData) return null
  const p = join(appData, 'clip2ssh', 'config.json')
  return existsSync(p) ? p : null
}

export interface ImportResult {
  profiles: SshProfile[]
  defaultProfileId?: string
  /** Names of profiles whose hotkey could not be represented. */
  droppedHotkeys: string[]
}

/**
 * Read and convert the legacy config. Returns null when there is nothing to
 * import (no file, unreadable, or no profiles inside).
 *
 * The legacy ids are preserved so a re-run is idempotent and so anyone
 * cross-referencing logs between the two apps sees the same identifiers.
 */
export function importClip2sshProfiles(): ImportResult | null {
  const path = legacyConfigPath()
  if (!path) return null

  let cfg: LegacyConfig
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as LegacyConfig
  } catch (err) {
    console.error('[clip2ssh-import] unreadable config:', err)
    return null
  }
  if (!Array.isArray(cfg.Profiles) || cfg.Profiles.length === 0) return null

  const droppedHotkeys: string[] = []
  const profiles: SshProfile[] = cfg.Profiles.map((lp) => {
    const name = typeof lp.Name === 'string' && lp.Name.trim() ? lp.Name.trim() : DEFAULT_SSH_PROFILE.name
    const hotkey = keysIntToAccelerator(Number(lp.Hotkey))
    if (!hotkey && Number(lp.Hotkey) > 0) droppedHotkeys.push(name)

    // The legacy pattern carried a hard-coded extension ("clip_{ts}.png") because
    // clip2ssh always re-encoded from a clipboard bitmap. Here the extension is
    // derived from the actual payload, so strip it off the template.
    const rawPattern = typeof lp.FileNamePattern === 'string' && lp.FileNamePattern.trim()
      ? lp.FileNamePattern.trim()
      : DEFAULT_SSH_PROFILE.fileNamePattern
    const fileNamePattern = rawPattern.replace(/\.(png|jpe?g)$/i, '')

    const legacyFormat = (lp.ImageFormat ?? '').toLowerCase()
    return {
      id: typeof lp.Id === 'string' && lp.Id.trim() ? lp.Id.trim() : createId(),
      name,
      host: typeof lp.Host === 'string' ? lp.Host.trim() : '',
      user: typeof lp.User === 'string' ? lp.User.trim() : '',
      port: Number(lp.Port) > 0 ? Math.round(Number(lp.Port)) : 22,
      remoteDir: typeof lp.RemoteDir === 'string' && lp.RemoteDir.trim() ? lp.RemoteDir.trim() : DEFAULT_SSH_PROFILE.remoteDir,
      hotkey,
      fileNamePattern,
      // 'Png' meant "re-encode the bitmap as PNG", which for an already-PNG
      // clipboard capture is a no-op — 'original' is the faithful translation.
      imageFormat: legacyFormat === 'jpeg' || legacyFormat === 'jpg' ? 'jpeg' : 'original',
      jpgQuality: Number(lp.JpgQuality) > 0 ? Math.round(Number(lp.JpgQuality)) : 90,
      replaceClipboard: lp.ReplaceClipboard !== false,
      notify: lp.Notify !== false,
      legacyScp: lp.LegacyScp === true
    }
  })

  const defaultProfileId = profiles.some((p) => p.id === cfg.DefaultProfileId)
    ? cfg.DefaultProfileId
    : profiles[0]?.id

  console.log(`[clip2ssh-import] converted ${profiles.length} profile(s) from ${path}`)
  return { profiles, defaultProfileId, droppedHotkeys }
}

/**
 * Run the import at most once per install, and never over existing targets.
 *
 * The `clip2sshImported` flag is set even when there was nothing to import, so
 * a user who later uninstalls clip2ssh (or deletes all their targets on purpose)
 * doesn't get the old profiles resurrected on the next launch.
 */
export function runClip2sshImportOnce(): Settings {
  const settings = loadSettings()
  if (settings.clip2sshImported) return settings

  if (settings.sshProfiles.length > 0) {
    console.log('[clip2ssh-import] targets already configured; marking as done')
    return saveSettings({ clip2sshImported: true })
  }

  const result = importClip2sshProfiles()
  if (!result) return saveSettings({ clip2sshImported: true })

  if (result.droppedHotkeys.length > 0) {
    console.warn(`[clip2ssh-import] hotkey not representable, imported without one: ${result.droppedHotkeys.join(', ')}`)
  }
  return saveSettings({
    sshProfiles: result.profiles,
    defaultSshProfileId: result.defaultProfileId,
    clip2sshImported: true
  })
}
