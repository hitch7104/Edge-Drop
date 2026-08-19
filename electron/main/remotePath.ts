/**
 * Remote path arithmetic for scp targets.
 *
 * Kept in its own module, free of electron and child_process imports, so the
 * rules below are unit-testable without a main process.
 *
 * Why this exists: a profile whose `remoteDir` is relative (`.`, `drop`) uploads
 * fine — scp lands in the remote home — but the path handed back to the
 * clipboard is then `./clip_20260101_120000.png`, which is useless once pasted
 * anywhere else. `ssh.ts` resolves the remote home for such profiles and joins
 * it here, so what gets copied is always a path the user can act on.
 */

/**
 * True when `remoteDir` can be used verbatim: POSIX absolute, `~`-rooted (both
 * scp and every remote shell expand it), or a Windows drive path. Everything
 * else is relative to the remote home and needs resolving.
 */
export function isAbsoluteRemote(dir: string): boolean {
  return /^(\/|~|[A-Za-z]:[/\\])/.test((dir || '').trim())
}

/** Join a remote directory and a filename. Trailing slashes on the dir are dropped. */
export function remoteJoin(remoteDir: string, name: string): string {
  const dir = (remoteDir || '/tmp').replace(/\/+$/, '')
  return `${dir}/${name}`
}

/**
 * Re-root a relative `remoteDir` on the resolved remote home.
 *
 * `.` and `''` collapse to the home itself; `./drop`, `drop` and `drop\x` all
 * land under it. Backslashes are normalised to `/` so a Windows home yields one
 * consistent separator.
 */
export function resolveUnderHome(home: string, relative: string): string {
  const base = home.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = (relative || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.(?=$|\/)/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return rel ? `${base}/${rel}` : base
}

/**
 * Pull a home directory out of a probe's stdout.
 *
 * Handles the three shells a target might answer with:
 *   - POSIX `pwd`            -> `/home/hitch`
 *   - PowerShell `pwd`       -> a formatted table whose last line is the path
 *   - cmd.exe `echo %USERPROFILE%` -> `C:\Users\JKKim`
 *
 * Returns null when the shell echoed the probe back instead of expanding it
 * (a POSIX shell handed `echo %USERPROFILE%`), so the caller can fall through
 * to the next probe rather than treating the literal as a path.
 *
 * This cannot tell a real POSIX home from a Unix-tool path on a Windows host —
 * Cygwin's `pwd` reports `/cygdrive/c/Users/me`, which passes the POSIX test but
 * is meaningless to that host's own sftp server. Probing `%USERPROFILE%` before
 * `pwd` is what keeps the two apart; see the caller in `ssh.ts`.
 */
export function parseRemoteHome(stdout: string): string | null {
  const line = (stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop()
  if (!line) return null
  if (line.startsWith('/')) return line
  if (/^[A-Za-z]:[\\/]/.test(line)) return line.replace(/\\/g, '/')
  return null
}
