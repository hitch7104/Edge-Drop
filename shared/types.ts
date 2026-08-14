/**
 * Shared domain types used by both the Electron main process and the renderer.
 *
 * Items are serialized in two places:
 *   - the on-disk index (JSON in userData)
 *   - the IPC payloads sent to the renderer
 * Images are stored as separate PNG files referenced by `imageId`, while the
 * renderer receives the bytes inline as a data URL so the UI never blocks on disk I/O.
 */

/** Maximum number of sub-items that may live in a single stack/bundle. */
export const MAX_STACK = 10

/** Discriminated union describing the payload of a clipboard item. */
export type ItemData =
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean }
  | { kind: 'image'; imageId: string; width: number; height: number; bytes: number; ext?: string }
  | { kind: 'image-collection'; images: { imageId: string; width: number; height: number; bytes: number; ext?: string }[] }
  | { kind: 'files'; paths: string[] }

export type ItemKind = ItemData['kind']

export type TypeFilter = 'all' | 'text' | 'links' | 'images' | 'files'

/**
 * A single clipboard entry. `id` is stable across the lifetime of the entry;
 * it is used as the React key and the storage key for pinned/persisted items.
 */
export interface ClipboardItem {
  id: string
  data: ItemData
  /** Unix epoch ms of the moment the item was captured. */
  capturedAt: number
  /** Number of times this exact content has been captured. */
  hitCount: number
  /** Pinned items never scroll off and survive app restarts. */
  pinned: boolean
}

/**
 * Display metadata for a single file inside a `files` bundle.
 * Computed by main from the path/extension + a stat() call; the internal
 * `ItemData.files` model stays a plain path list so drag/merge/split logic
 * is untouched, while the renderer gets what it needs to render richly.
 */
export interface FileEntry {
  name: string
  ext: string
  size: number
  isImage: boolean
  preview?: string
}

/** Payload sent over IPC: same as ClipboardItem but with inline image previews. */
export interface ClipboardItemDto extends Omit<ClipboardItem, 'data'> {
  data:
  | { kind: 'text'; text: string; html?: string; isUrl: boolean; isColor?: boolean }
  | { kind: 'image'; imageId: string; width: number; height: number; bytes: number; preview: string; ext?: string }
  | { kind: 'image-collection'; images: { imageId: string; width: number; height: number; bytes: number; preview: string; ext?: string }[] }
  | { kind: 'files'; paths: string[]; previews?: string[]; entries?: FileEntry[] }
}

/** Section the renderer groups items into. */
export type ItemSection = 'pinned' | 'shelf'

export type StickPosition = 'left' | 'right'

export interface DisplayInfo {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  isPrimary: boolean
  isCurrent?: boolean
  label: string
  name: string
  resolution: string
}

/**
 * Request to begin a native OS drag-out of one item.
 *
 * `id` always identifies the source item. `paths` is an optional override that
 * narrows a `files` bundle to a single path (used when dragging one file out of
 * an expanded bundle). When omitted, main uses all of the item's content.
 */
export interface DragRequest {
  id: string
  paths?: string[]
  imageId?: string
  splitPlacement?: 'before' | 'after'
}

/**
 * Outcome of a merge attempt. `reason` tells the renderer *why* it failed so it
 * can show a precise message (e.g. "collection full" vs "can't mix types").
 */
export interface MergeResult {
  ok: boolean
  reason?: 'full' | 'incompatible' | 'notfound'
  message?: string
}

/**
 * One SSH upload target ("send this shelf item to that machine over scp").
 *
 * Ported from the standalone clip2ssh tray app, whose `Profile` this mirrors
 * field-for-field so an existing `%APPDATA%/clip2ssh/config.json` migrates
 * losslessly. Authentication is key-only by design: scp runs with
 * `BatchMode=yes`, so nothing here is ever a secret and the profile list lives
 * in plain settings.json alongside everything else.
 */
export interface SshProfile {
  id: string
  /** Display name, also the CLI/`--upload` selector. Usually the host alias. */
  name: string
  host: string
  user: string
  port: number
  /** Absolute remote directory. Trailing slashes are trimmed on use. */
  remoteDir: string
  /**
   * Electron accelerator (e.g. `Ctrl+Shift+Alt+V`), or '' for no hotkey.
   * Pressing it uploads the newest shelf item to this target.
   */
  hotkey: string
  /** Remote filename template. `{ts}` -> yyyyMMdd_HHmmss, `{name}` -> source basename. */
  fileNamePattern: string
  /**
   * Re-encode images before upload. 'original' ships the stored bytes as-is,
   * which is both fastest and lossless — clip2ssh had no such option because it
   * always re-encoded from a clipboard bitmap.
   */
  imageFormat: 'original' | 'png' | 'jpeg'
  /** JPEG quality 1-100, only consulted when imageFormat is 'jpeg'. */
  jpgQuality: number
  /** Replace the clipboard with the remote path after a successful upload. */
  replaceClipboard: boolean
  /**
   * Show an OS notification on a *successful* upload. Failures always notify —
   * a silent failure after a hotkey press is indistinguishable from the hotkey
   * not working at all.
   */
  notify: boolean
  /** `scp -O` — legacy SCP protocol, required by targets with no SFTP subsystem (Synology DSM). */
  legacyScp: boolean
}

export const DEFAULT_SSH_PROFILE: Omit<SshProfile, 'id'> = {
  name: 'new-target',
  host: '',
  user: '',
  port: 22,
  remoteDir: '/tmp',
  hotkey: '',
  fileNamePattern: 'clip_{ts}',
  imageFormat: 'original',
  jpgQuality: 90,
  replaceClipboard: true,
  notify: true,
  legacyScp: false
}

/**
 * Request to upload one item to one target.
 *
 * `paths` / `imageId` narrow a bundle or collection to a single sub-item, the
 * same addressing scheme `DragRequest` uses.
 */
export interface SshUploadRequest {
  id: string
  /** Target profile id. Omitted or 'default' resolves to the default target. */
  profileId?: string
  paths?: string[]
  imageId?: string
}

/** Outcome of an scp upload, surfaced to the renderer as a toast. */
export interface SshUploadResult {
  ok: boolean
  /** Remote path written, on success. */
  remotePath?: string
  /** scp exit code, when the process ran but failed. */
  exitCode?: number
  /** Human-readable failure reason (already truncated for display). */
  error?: string
}

export interface Settings {
  /** Fraction of the screen height the hot zone occupies (0.2 - 0.6). */
  hotZoneHeight: number
  /** Physical thickness (in pixels) of the screen edge hover trigger. */
  hotZoneWidth: number
  /** Maximum number of unpinned history items kept. */
  historyLimit: number
  /** Fraction of the screen height the panel occupies (0.4 - 1.0). */
  panelHeight: number
  /** When true, newly captured items are not recorded. */
  incognito: boolean
  /** Start minimized when the OS logs in. */
  launchAtLogin: boolean
  /** Reduce motion for the panel animations. */
  reduceMotion: boolean
  /** When true, automatically clears unpinned items on device/app restart. */
  /** When true, automatically clears unpinned items on device/app restart. */
  clearUnpinnedOnRestart: boolean
  /** Hours after which unpinned items are automatically purged (0 = Never). */
  autoDeleteHours: number
  /** UI visual style density ('modern' | 'compact'). */
  uiStyle: 'modern' | 'compact'
  /** Flag to track if the onboarding tutorial is completed. */
  tutorialCompleted: boolean
  stickPosition: StickPosition
  stickDisplayId?: number
  /**
   * Persisted workArea geometry of the display chosen by the user.
   * Used as a cross-reboot fuzzy-match fingerprint when the OS re-assigns
   * numeric display IDs after a restart (Windows behaviour).
   */
  stickDisplayWorkArea?: { x: number; y: number; width: number; height: number }
  /**
   * DPI scale factor of the chosen display — used as a secondary discriminator
   * when two displays share identical workArea geometry (e.g. dual same-res).
   */
  stickDisplayScaleFactor?: number
  /**
   * When true, restores the bouncy overshoot panel-open animation.
   * Off by default because it requires extra GPU compositing work.
   */
  bounceAnimation: boolean
  /**
   * When true, automatically suppresses edge hover when a fullscreen game or app is active.
   * On by default to prevent accidental opening during PC gameplay.
   */
  suppressInFullscreen: boolean
  /** When true, shows the visual edge morph indicator on copy actions. Default: true. */
  showCopyIndicator: boolean
  /** Style variant of the copy indicator icon ('logo' | 'check' | 'copy' | 'sparkle'). Default: 'logo'. */
  copyIndicatorStyle: 'logo' | 'check' | 'copy' | 'sparkle'
  /** Vertical offset fraction along screen edge (0 = top, 0.5 = center, 1 = bottom). Default: 0.5. */
  verticalOffset: number
  /** Vertical alignment of the hover trigger strip relative to shelf ('top' | 'center' | 'bottom'). Default: 'center'. */
  triggerAlignment?: 'top' | 'center' | 'bottom'
  /** When true, subtly illuminates a beacon hint on the screen edge when touching the edge at a different position. Default: true. */
  showEdgeLocationHint?: boolean
  /** When true, plays tactile audio sound effects for sliders, buttons, and switches. Default: true. */
  soundEffects?: boolean
  /** Last version for which the user opened/viewed the What's New changelog panel. */
  lastSeenChangelogVersion?: string
  /** When true, hovering cursor near edge activates the panel. When false, panel opens exclusively via Alt + C. Default: true. */
  hoverActivation?: boolean
  /** Font size scale multiplier (0.85 = Small, 1.00 = Normal, 1.15 = Large). Default: 1.0. */
  fontSizeScale?: number
  /** When true, automatically checks for and downloads app updates in background. Default: true. */
  autoUpdates?: boolean
  /** Active UI language code ('system' | 'en' | 'es' | 'fr' | 'de' | ...). Default: 'system'. */
  language?: string
  /** Configured scp upload targets. Empty (the default) keeps the feature dormant. */
  sshProfiles: SshProfile[]
  /** Profile used by the shelf's one-click upload button and the `default` selector. */
  defaultSshProfileId?: string
  /** Set once the one-time import from %APPDATA%/clip2ssh/config.json has run. */
  clip2sshImported?: boolean
  /**
   * Run at login via a delayed-logon Scheduled Task instead of the registry Run
   * key. The Run key's tail can be dropped when the shell has a rough logon, and
   * a 30s-delayed task trigger fires independently of the shell.
   */
  launchViaScheduledTask?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  hotZoneHeight: 0.25,
  hotZoneWidth: 3,
  historyLimit: 500,
  panelHeight: 0.5,
  incognito: false,
  launchAtLogin: true,
  reduceMotion: false,
  clearUnpinnedOnRestart: false,
  autoDeleteHours: 0,
  uiStyle: 'modern',
  tutorialCompleted: false,
  stickPosition: 'left',
  stickDisplayId: undefined,
  stickDisplayWorkArea: undefined,
  stickDisplayScaleFactor: undefined,
  bounceAnimation: false,
  suppressInFullscreen: true,
  showCopyIndicator: true,
  copyIndicatorStyle: 'logo',
  verticalOffset: 0.5,
  triggerAlignment: 'center',
  showEdgeLocationHint: true,
  soundEffects: true,
  lastSeenChangelogVersion: undefined,
  hoverActivation: true,
  fontSizeScale: 1.0,
  // Off by default: this fork has no update feed (see updater.ts).
  autoUpdates: false,
  language: 'system',
  sshProfiles: [],
  defaultSshProfileId: undefined,
  clip2sshImported: false,
  launchViaScheduledTask: true
}


