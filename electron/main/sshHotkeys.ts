/**
 * Per-target global hotkeys for scp upload.
 *
 * Deliberately tracks its own accelerators and unregisters them individually:
 * `globalShortcut.unregisterAll()` would also drop the app's `Alt+C` panel
 * toggle, which is registered elsewhere and must survive a settings change.
 */
import { globalShortcut } from 'electron'
import { loadSettings } from './state'
import { uploadNewestTo } from './sshActions'
import { runtime } from './config'

/** Accelerators this module currently owns. */
let owned: string[] = []

/** Per-accelerator throttle — Windows can repeat a chord while it's held. */
const lastFired = new Map<string, number>()

export function unregisterSshHotkeys(): void {
  for (const accel of owned) {
    try {
      globalShortcut.unregister(accel)
    } catch { /* already gone */ }
  }
  owned = []
  lastFired.clear()
}

/**
 * (Re)register every configured target hotkey.
 *
 * Called at startup and after any settings change that touches the profile list.
 * A chord already taken by another app fails to register; that is logged and
 * skipped rather than treated as fatal, matching how the old tray app behaved.
 */
export function registerSshHotkeys(): void {
  unregisterSshHotkeys()
  const profiles = loadSettings().sshProfiles
  const claimed = new Set<string>()

  for (const profile of profiles) {
    const accel = profile.hotkey?.trim()
    if (!accel) continue
    // Two profiles sharing a chord would make which one wins arbitrary.
    if (claimed.has(accel)) {
      console.warn(`[ssh-hotkeys] duplicate chord ${accel} on "${profile.name}" — skipped`)
      continue
    }

    const profileId = profile.id
    const name = profile.name
    let ok = false
    try {
      ok = globalShortcut.register(accel, () => {
        if (runtime.quitting) return
        const now = Date.now()
        if (now - (lastFired.get(accel) ?? 0) < 700) return
        lastFired.set(accel, now)
        void uploadNewestTo(profileId)
      })
    } catch (err) {
      console.error(`[ssh-hotkeys] register threw for ${accel} ("${name}"):`, err)
      continue
    }

    if (ok) {
      claimed.add(accel)
      owned.push(accel)
      console.log(`[ssh-hotkeys] ${accel} -> ${name}`)
    } else {
      console.warn(`[ssh-hotkeys] ${accel} ("${name}") rejected — another app likely owns it`)
    }
  }
}
