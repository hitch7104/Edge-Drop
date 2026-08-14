/**
 * Upload orchestration shared by the IPC handler and the global hotkeys.
 *
 * Both entry points need the same three steps after scp returns — replace the
 * clipboard with the remote path, toast the outcome, log it — so they live here
 * rather than being duplicated in `ipc.ts` and `sshHotkeys.ts`.
 */
import { clipboard, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import type { ItemData, SshProfile, SshUploadRequest, SshUploadResult } from '../../shared/types'
import { getStore, getWatcher, loadSettings } from './state'
import { getMainWindow } from './window'
import { resolveDragData } from './drag'
import { findProfile, uploadToProfile } from './ssh'
import { PATHS } from '../store/paths'
import { APP_CONFIG } from './config'

/** Fire a transient toast to the renderer (best-effort; the panel may be closed). */
function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ui:toast', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      message,
      tone
    })
  }
}

/**
 * OS notification for the upload outcome.
 *
 * The in-panel toast alone is not enough: uploads are normally triggered by a
 * global hotkey while the panel is closed and click-through, so its toast is
 * drawn somewhere the user cannot see. The predecessor tray app used a balloon
 * tip for exactly this reason. Failures always notify; successes respect the
 * profile's `notify` flag so a frequently-used target can stay quiet.
 */
function notifyOs(profile: SshProfile, title: string, body: string, isFailure: boolean, thumb?: string): void {
  if (!isFailure && profile.notify === false) return
  showNotification(title, body, isFailure, thumb)
}

/** Failure notification for cases with no profile to consult (unconfigured, empty shelf). */
function notifyFailure(body: string): void {
  showNotification('업로드 실패', body, true)
}

function showNotification(title: string, body: string, isFailure: boolean, thumb?: string): void {
  try {
    if (!Notification.isSupported()) return
    new Notification({
      title: `${APP_CONFIG.appName} · ${title}`,
      body,
      // Windows renders this as the toast's app-logo override — i.e. a thumbnail
      // of what was just sent. Falls back to the app icon for text/non-image items.
      icon: thumb ?? PATHS.icon(),
      silent: !isFailure
    }).show()
  } catch (err) {
    console.error('[ssh] notification failed:', err)
  }
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|bmp|avif|ico|tiff?|jfif)$/i

/**
 * Local image file to show as the notification thumbnail, if the uploaded item
 * has one.
 *
 * Must be a real path on disk: the Windows toast pipeline reads the file itself,
 * so a data URL or an in-memory buffer would render nothing. Images are already
 * staged under userData, and `files` items point at the user's own files, so no
 * copy is needed either way.
 */
function thumbnailFor(data: ItemData): string | undefined {
  let path: string | undefined

  if (data.kind === 'image') {
    path = getStore().getImagePath(data.imageId, data.ext)
  } else if (data.kind === 'image-collection') {
    const first = data.images[0]
    if (first) path = getStore().getImagePath(first.imageId, first.ext)
  } else if (data.kind === 'files') {
    // Only the first file, and only when it is itself an image.
    const first = data.paths.find((p) => IMAGE_EXT.test(extname(p).slice(1)))
    if (first) path = first
  }

  if (!path) return undefined
  try {
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Put the remote path on the clipboard after a successful upload.
 *
 * The watcher is paused across the write so our own text doesn't come back as a
 * brand-new shelf item — the same self-copy guard `item:copy` uses.
 *
 * The write is verified and retried once. On Windows the clipboard is a single
 * global resource guarded by a lock, and `clipboard.writeText` fails *silently*
 * when another process is holding it — which is exactly what happens when the
 * upload was triggered right after a screenshot tool wrote the image. clip2ssh
 * papered over the same problem by writing twice with a gap; verifying is the
 * honest version of that trick.
 */
function writeRemotePath(remotePath: string): void {
  const watcher = getWatcher()
  watcher.setPaused(true)

  const attempt = (retriesLeft: number): void => {
    try {
      clipboard.writeText(remotePath)
    } catch (err) {
      console.error('[ssh] clipboard write threw:', err)
    }

    let landed = false
    try {
      landed = clipboard.readText() === remotePath
    } catch { /* read can fail under the same contention */ }

    if (landed) {
      setTimeout(() => watcher.setPaused(loadSettings().incognito), 200)
      return
    }

    if (retriesLeft > 0) {
      console.warn(`[ssh] clipboard write did not stick, retrying (${retriesLeft} left)`)
      setTimeout(() => attempt(retriesLeft - 1), 250)
      return
    }

    console.error('[ssh] clipboard write failed after retries; remote path not copied')
    setTimeout(() => watcher.setPaused(loadSettings().incognito), 200)
  }

  attempt(2)
}

/**
 * Report an upload result to the user and sync the clipboard.
 *
 * Both channels fire: the in-panel toast (immediate, when the shelf happens to
 * be open) and an OS notification (the one the user actually sees when the
 * upload came from a hotkey).
 */
function announce(profile: SshProfile, result: SshUploadResult, data?: ItemData): void {
  if (result.ok && result.remotePath) {
    if (profile.replaceClipboard) writeRemotePath(result.remotePath)
    toast(`${profile.name} → ${result.remotePath}`, 'info')
    notifyOs(profile, profile.name, result.remotePath, false, data && thumbnailFor(data))
  } else {
    const reason = result.error ?? '업로드 실패'
    toast(`${profile.name}: ${reason}`, 'error')
    notifyOs(profile, `${profile.name} 실패`, reason, true)
  }
}

/** Upload the item addressed by `req`. Resolves to the outcome. */
export async function uploadRequest(req: SshUploadRequest): Promise<SshUploadResult> {
  const profile = findProfile(req.profileId)
  if (!profile) {
    const result: SshUploadResult = { ok: false, error: 'SSH 타깃이 설정되지 않음' }
    toast(result.error as string, 'error')
    notifyFailure(result.error as string)
    return result
  }

  const data: ItemData | null = resolveDragData({
    id: req.id,
    paths: req.paths,
    imageId: req.imageId
  })
  if (!data) {
    const result: SshUploadResult = { ok: false, error: '업로드할 항목을 찾을 수 없음' }
    announce(profile, result)
    return result
  }

  const result = await uploadToProfile(data, profile)
  announce(profile, result, data)
  return result
}

/**
 * Upload the most recently captured item — the action bound to a profile hotkey.
 *
 * This is the direct successor to clip2ssh's `Ctrl+Shift+Alt+<key>`: copy
 * something, press the chord, get the remote path back on the clipboard. Unlike
 * clip2ssh it is not limited to images, and it reads the already-staged bytes
 * instead of re-grabbing the clipboard.
 */
export async function uploadNewestTo(profileId: string): Promise<SshUploadResult> {
  const newest = getStore().newest()
  if (!newest) {
    toast('업로드할 항목이 없음', 'error')
    notifyFailure('선반이 비어 있어 업로드할 항목이 없습니다')
    return { ok: false, error: '업로드할 항목이 없음' }
  }
  return uploadRequest({ id: newest.id, profileId })
}
