/**
 * Settings persistence.
 *
 * Settings are small (a single flat object) so a plain JSON file is plenty.
 * The store guards against partial/corrupt files by deep-merging onto the
 * defaults so a bad field never takes the whole app down.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DEFAULT_SETTINGS, DEFAULT_SSH_PROFILE, type Settings, type SshProfile } from '../../shared/types'
import { PATHS } from './paths'
import { createId } from './ids'

let cache: Settings | null = null

/**
 * Backfill and clamp every SSH profile field.
 *
 * Profiles arrive from three places — the settings UI, a hand-edited
 * settings.json, and the one-time clip2ssh import — so no field can be trusted
 * to exist. A profile missing `remoteDir` would otherwise upload to the remote
 * home directory silently, which is the kind of surprise that loses files.
 */
function normalizeProfiles(raw: unknown): SshProfile[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SshProfile[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const p = entry as Partial<SshProfile>
    let id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : createId()
    // A duplicate id would make the UI edit two rows at once.
    while (seen.has(id)) id = createId()
    seen.add(id)

    const port = Number(p.port)
    const quality = Number(p.jpgQuality)
    const format = p.imageFormat
    out.push({
      id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : DEFAULT_SSH_PROFILE.name,
      host: typeof p.host === 'string' ? p.host.trim() : '',
      user: typeof p.user === 'string' ? p.user.trim() : '',
      port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : 22,
      remoteDir: typeof p.remoteDir === 'string' && p.remoteDir.trim() ? p.remoteDir.trim() : DEFAULT_SSH_PROFILE.remoteDir,
      hotkey: typeof p.hotkey === 'string' ? p.hotkey.trim() : '',
      fileNamePattern: typeof p.fileNamePattern === 'string' && p.fileNamePattern.trim()
        ? p.fileNamePattern.trim()
        : DEFAULT_SSH_PROFILE.fileNamePattern,
      imageFormat: format === 'png' || format === 'jpeg' ? format : 'original',
      jpgQuality: Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : 90,
      replaceClipboard: p.replaceClipboard !== false,
      notify: p.notify !== false,
      legacyScp: p.legacyScp === true
    })
  }
  return out
}

function merge(base: Settings, patch: Partial<Settings>): Settings {
  const out = { ...base, ...patch } as Settings
  // Clamp the numeric slider into its valid range.
  out.hotZoneHeight = Math.min(0.6, Math.max(0.2, out.hotZoneHeight))
  out.historyLimit = Math.min(2000, Math.max(50, Math.round(out.historyLimit)))
  out.autoDeleteHours = Math.max(0, Number(out.autoDeleteHours) || 0)
  out.verticalOffset = Math.min(1.0, Math.max(0.0, typeof out.verticalOffset === 'number' ? out.verticalOffset : 0.5))
  if (out.uiStyle !== 'modern' && out.uiStyle !== 'compact') {
    out.uiStyle = 'modern'
  }
  if (out.triggerAlignment !== 'top' && out.triggerAlignment !== 'center' && out.triggerAlignment !== 'bottom') {
    out.triggerAlignment = 'center'
  }
  if (typeof out.language !== 'string' || !out.language.trim()) {
    out.language = 'system'
  }
  out.sshProfiles = normalizeProfiles(out.sshProfiles)
  // Drop a stale default pointer (profile deleted) so callers fall back to the
  // first profile instead of resolving to nothing.
  if (!out.sshProfiles.some((p) => p.id === out.defaultSshProfileId)) {
    out.defaultSshProfileId = out.sshProfiles.length > 0 ? out.sshProfiles[0].id : undefined
  }
  return out
}

export function getSettings(): Settings {
  return loadSettings()
}

export function loadSettings(): Settings {
  if (cache) return cache
  let file: Partial<Settings> = {}
  try {
    if (existsSync(PATHS.settingsFile())) {
      file = JSON.parse(readFileSync(PATHS.settingsFile(), 'utf8')) as Partial<Settings>
    }
  } catch {
    file = {}
  }
  cache = merge({ ...DEFAULT_SETTINGS }, file)
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = merge(loadSettings(), patch)
  cache = next
  try {
    writeFileSync(PATHS.settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* non-fatal; settings stay in memory */
  }
  return next
}

export function resetSettingsCache(): void {
  cache = null
}
