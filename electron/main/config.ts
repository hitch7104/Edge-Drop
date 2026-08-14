/** App-wide constants and environment flags for the main process. */

/** Mutable runtime flags (kept separate from the frozen config object). */
export const runtime = {
  /** Set true only while the app is genuinely quitting (tray -> Quit). */
  quitting: false,
  /**
   * Whether this process kept GPU compositing. Decided once before `ready` from
   * the docked edge (see index.ts) and fixed for the process lifetime, so
   * changing the edge across that boundary needs a relaunch.
   */
  gpuCompositing: false
}

export const APP_CONFIG = {
  appName: 'Clip2SSH Edge',
  /**
   * Custom protocol used to serve local image files to the renderer securely.
   * Deliberately left as the upstream scheme name — it appears in persisted
   * item previews, so renaming it would break existing history entries.
   */
  imageProtocol: 'edgelocal',
  is: {
    get dev(): boolean {
      return !!process.env.ELECTRON_RENDERER_URL || process.env.NODE_ENV === 'development'
    }
  }
} as const
