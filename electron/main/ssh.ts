/**
 * scp upload of shelf items to configured SSH targets.
 *
 * Ported from the standalone clip2ssh tray app (`Uploader.cs`), with three
 * changes the Edge-Drop architecture makes possible:
 *
 *   1. No temp round-trip for images. clip2ssh had to re-encode a clipboard
 *      bitmap to a temp PNG on every upload; here the bytes are already staged
 *      in userData/images, so the staged file is sent directly.
 *   2. Any item kind uploads, not just images — file bundles keep their real
 *      names, text items are written out as .txt.
 *   3. Keepalive options so a dead route fails in ~15s instead of hanging. The
 *      old app showed a tray balloon on failure and could afford to wait; a
 *      silent stalled upload is worse.
 *
 * Authentication is key-only (`BatchMode=yes`): scp never prompts, so a missing
 * key surfaces as a normal failure instead of an invisible blocked process.
 */
import { execFile } from 'node:child_process'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { nativeImage } from 'electron'
import type { ItemData, SshProfile, SshUploadResult } from '../../shared/types'
import { PATHS } from '../store/paths'
import { getStore, loadSettings } from './state'
import { isValidFilePath } from './pathValidation'
import { isAbsoluteRemote, parseRemoteHome, remoteJoin, resolveUnderHome } from './remotePath'

/**
 * Absolute path to the bundled OpenSSH client, falling back to PATH lookup.
 *
 * Resolving absolutely matters: a user PATH that shadows a system tool is a real
 * failure mode (the same machine has had a third-party `python.exe` shadow the
 * real one), and this process spawns with the user's environment.
 */
function opensshBinary(tool: 'scp' | 'ssh'): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const bundled = join(systemRoot, 'System32', 'OpenSSH', `${tool}.exe`)
    if (existsSync(bundled)) return bundled
  }
  return tool
}

/** yyyyMMdd_HHmmss in local time — matches clip2ssh's `{ts}` exactly. */
function timestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Strip anything that would change the meaning of a remote path.
 *
 * The name is interpolated into an `scp` destination argument, so a `/` in it
 * would silently redirect the upload into a different directory and `..` would
 * escape the target dir entirely.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[/\\]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/["'`$\r\n\t]/g, '_')
    .trim() || `clip_${timestamp()}`
}

/** Apply a profile's filename template. */
function renderName(pattern: string, sourceName: string, ext: string): string {
  const stem = pattern
    .replace(/\{ts\}/g, timestamp())
    .replace(/\{name\}/g, sourceName)
  const cleanExt = ext.replace(/^\./, '')
  return sanitizeName(cleanExt ? `${stem}.${cleanExt}` : stem)
}

/** One local file queued for upload. */
interface UploadUnit {
  localPath: string
  remoteName: string
  /** Scratch file we created and must delete once scp is done. */
  temporary: boolean
}

/**
 * Re-encode a staged image when the profile asks for a format it isn't already
 * in. Returns null to mean "send the original file untouched", which is both
 * the fast path and the lossless one.
 */
function reencodeImage(srcPath: string, profile: SshProfile): { path: string; ext: string } | null {
  const currentExt = extname(srcPath).slice(1).toLowerCase()
  const want = profile.imageFormat
  if (want === 'original') return null
  if (want === 'png' && currentExt === 'png') return null
  if (want === 'jpeg' && (currentExt === 'jpg' || currentExt === 'jpeg')) return null

  try {
    const img = nativeImage.createFromPath(srcPath)
    if (img.isEmpty()) return null
    const buf = want === 'jpeg' ? img.toJPEG(profile.jpgQuality) : img.toPNG()
    if (!buf || buf.length === 0) return null
    const ext = want === 'jpeg' ? 'jpg' : 'png'
    const out = join(PATHS.tempDir(), `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`)
    writeFileSync(out, buf)
    return { path: out, ext }
  } catch (err) {
    console.error('[ssh] re-encode failed, sending original:', err)
    return null
  }
}

/**
 * Turn an item into the list of local files to send.
 *
 * File bundles keep their original basenames unless the profile's pattern
 * explicitly asks for `{name}` — renaming someone's `report.pdf` to
 * `clip_20260813_101500.pdf` would be the wrong kind of clever.
 */
function resolveUnits(data: ItemData, profile: SshProfile): { units: UploadUnit[]; error?: string } {
  const units: UploadUnit[] = []
  const store = getStore()

  if (data.kind === 'image' || data.kind === 'image-collection') {
    const images = data.kind === 'image'
      ? [{ imageId: data.imageId, ext: data.ext }]
      : data.images.map((i) => ({ imageId: i.imageId, ext: i.ext }))

    for (const img of images) {
      const staged = store.getImagePath(img.imageId, img.ext)
      if (!existsSync(staged)) {
        console.error('[ssh] staged image missing:', staged)
        continue
      }
      const re = reencodeImage(staged, profile)
      const localPath = re?.path ?? staged
      const ext = re?.ext ?? (extname(staged).slice(1) || 'png')
      units.push({
        localPath,
        remoteName: renderName(profile.fileNamePattern, img.imageId, ext),
        temporary: re !== null
      })
    }
    if (units.length === 0) return { units, error: '업로드할 이미지 파일을 찾을 수 없음' }
    return { units }
  }

  if (data.kind === 'files') {
    for (const p of data.paths) {
      if (!isValidFilePath(p) || !existsSync(p)) {
        console.error('[ssh] source file missing:', p)
        continue
      }
      const ext = extname(p).slice(1)
      const stem = basename(p, extname(p))
      const remoteName = profile.fileNamePattern.includes('{name}')
        ? renderName(profile.fileNamePattern, stem, ext)
        : sanitizeName(basename(p))
      units.push({ localPath: p, remoteName, temporary: false })
    }
    if (units.length === 0) return { units, error: '원본 파일이 존재하지 않음' }
    return { units }
  }

  // text — write it out so the remote gets a real file rather than a shell echo.
  try {
    const out = join(PATHS.tempDir(), `ssh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`)
    writeFileSync(out, data.text, 'utf8')
    units.push({
      localPath: out,
      remoteName: renderName(profile.fileNamePattern, 'clip', 'txt'),
      temporary: true
    })
    return { units }
  } catch (err) {
    return { units, error: `텍스트 임시파일 생성 실패: ${String(err)}` }
  }
}

/**
 * Resolved remote home per target, keyed `user@host:port`.
 *
 * A home directory does not move while the app runs, and the probe costs a full
 * ssh round-trip, so one lookup per target per session is enough.
 */
const remoteHomeCache = new Map<string, string>()

/**
 * Absolute remote directory for a profile.
 *
 * A relative `remoteDir` uploads correctly on its own — scp starts in the remote
 * home — but the resulting path is worthless on the clipboard, so it is resolved
 * against the remote home first. The probes cover the three shells a target may
 * answer with (see `parseRemoteHome`); if none does, the relative dir is used
 * unchanged, which is exactly the previous behaviour. An upload must never fail
 * because a cosmetic path lookup did.
 */
async function resolveRemoteDir(profile: SshProfile): Promise<string> {
  const dir = (profile.remoteDir || '/tmp').trim()
  if (isAbsoluteRemote(dir)) return dir.replace(/\/+$/, '') || '/'

  const key = `${profile.user}@${profile.host}:${profile.port}`
  const cached = remoteHomeCache.get(key)
  if (cached) return resolveUnderHome(cached, dir)

  // Order matters, and not the way round you would guess. A Windows target with
  // Unix tools on PATH answers `pwd` with a shell-private path — m2n has Cygwin
  // and reports `/cygdrive/c/Users/JKKim`, which looks POSIX-absolute but is not
  // a path its own sftp server can write to, so the upload fails. `echo
  // %USERPROFILE%` is the safe first probe: a POSIX shell echoes it back
  // unexpanded, which `parseRemoteHome` rejects, and `pwd` then answers.
  for (const probe of ['echo %USERPROFILE%', 'pwd']) {
    const res = await runSsh(profile, probe)
    if (!res.ok) continue
    const home = parseRemoteHome(res.out)
    if (!home) continue
    remoteHomeCache.set(key, home)
    console.log(`[ssh] remote home [${profile.name}] ${home}`)
    return resolveUnderHome(home, dir)
  }

  console.warn(`[ssh] could not resolve remote home [${profile.name}], using "${dir}" as-is`)
  return dir
}

function truncate(s: string, n = 160): string {
  const flat = (s || '').replace(/[\r\n]+/g, ' ').trim()
  return flat.length <= n ? flat : `${flat.slice(0, n)}...`
}

/** Run one scp invocation. Never throws — failures come back as a result. */
function runScp(profile: SshProfile, localPath: string, remotePath: string): Promise<{ ok: boolean; code: number; err: string }> {
  const args = [
    '-q',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    // Fail a dead route in ~15s instead of blocking on a half-open socket.
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3'
  ]
  // Legacy SCP protocol: required by targets with no SFTP subsystem (Synology DSM).
  if (profile.legacyScp) args.push('-O')
  if (profile.port > 0 && profile.port !== 22) args.push('-P', String(profile.port))
  args.push(localPath, `${profile.user}@${profile.host}:${remotePath}`)

  return new Promise((resolve) => {
    execFile(opensshBinary('scp'), args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, code: 0, err: '' })
        return
      }
      const code = typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code as number : -1
      resolve({ ok: false, code, err: stderr || err.message })
    })
  })
}

/**
 * Upload one item to one target.
 *
 * Every unit of a multi-file item must succeed for the result to be ok; the
 * first failure stops the run so a broken target doesn't retry nine more times.
 */
export async function uploadToProfile(data: ItemData, profile: SshProfile): Promise<SshUploadResult> {
  if (!profile.host || !profile.user) {
    return { ok: false, error: `프로필 "${profile.name}"에 host/user가 비어 있음` }
  }

  const { units, error } = resolveUnits(data, profile)
  if (error) return { ok: false, error }

  const remoteDir = await resolveRemoteDir(profile)

  const uploaded: string[] = []
  try {
    for (const unit of units) {
      const remotePath = remoteJoin(remoteDir, unit.remoteName)
      const res = await runScp(profile, unit.localPath, remotePath)
      if (!res.ok) {
        console.error(`[ssh] upload FAIL [${profile.name}] exit=${res.code} ${truncate(res.err)}`)
        return { ok: false, exitCode: res.code, error: truncate(res.err) || `scp exit=${res.code}` }
      }
      uploaded.push(remotePath)
      console.log(`[ssh] upload OK [${profile.name}] ${remotePath}`)
    }
  } finally {
    for (const unit of units) {
      if (!unit.temporary) continue
      try { unlinkSync(unit.localPath) } catch { /* best-effort */ }
    }
  }

  // For a multi-file upload the last path is the useful one to put on the
  // clipboard; the full list is already in the log.
  return { ok: true, remotePath: uploaded[uploaded.length - 1] }
}

/** Resolve `default`, a profile id, or a profile name (case-insensitive). */
export function findProfile(nameOrId?: string): SshProfile | null {
  const settings = loadSettings()
  const profiles = settings.sshProfiles
  if (profiles.length === 0) return null
  if (!nameOrId || nameOrId === 'default') {
    return profiles.find((p) => p.id === settings.defaultSshProfileId) ?? profiles[0]
  }
  return profiles.find((p) => p.id === nameOrId)
    ?? profiles.find((p) => p.name.toLowerCase() === nameOrId.toLowerCase())
    ?? null
}

/** Run one ssh command against a target. Never throws. */
function runSsh(profile: SshProfile, remoteCommand: string): Promise<{ ok: boolean; code: number; out: string; err: string }> {
  const args = [
    '-n',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10'
  ]
  if (profile.port > 0 && profile.port !== 22) args.push('-p', String(profile.port))
  args.push(`${profile.user}@${profile.host}`, remoteCommand)

  return new Promise((resolve) => {
    execFile(opensshBinary('ssh'), args, { windowsHide: true, maxBuffer: 1 << 16 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, code: 0, out: stdout ?? '', err: '' })
        return
      }
      const code = typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code as number : -1
      resolve({ ok: false, code, out: stdout ?? '', err: stderr || err.message })
    })
  })
}

/**
 * Connectivity check for the settings UI. Writes nothing to the remote host.
 *
 * Reports three distinct outcomes, because "it connected" and "it can write
 * there" are different problems:
 *
 *   - writable      -> `remotePath` is set
 *   - connected     -> ok, but `remotePath` absent (write state unknown)
 *   - failed        -> `error` explains why
 *
 * The write probe is `test -w`, which only exists on a POSIX remote shell. A
 * Windows target answers with cmd.exe's "not recognized" on stderr, so an
 * errored probe falls back to a plain auth check rather than being reported as a
 * failure — a Windows host whose scp works must not read as broken here.
 */
export async function testProfile(profile: SshProfile): Promise<SshUploadResult> {
  if (!profile.host || !profile.user) {
    return { ok: false, error: 'host/user가 비어 있음' }
  }
  // Resolved, so a relative profile reports the real directory it writes to.
  const dir = await resolveRemoteDir(profile)
  const probe = await runSsh(profile, `test -w '${dir.replace(/'/g, "'\\''")}'`)
  if (probe.ok) return { ok: true, remotePath: dir }

  // Exit 1 with nothing on stderr is `test` itself saying "no".
  if (probe.code === 1 && !probe.err.trim()) {
    return { ok: false, exitCode: probe.code, error: `연결은 되지만 ${dir} 에 쓸 수 없음` }
  }

  // Anything else: was it the connection, or just a shell without `test`?
  const auth = await runSsh(profile, 'exit')
  if (auth.ok) return { ok: true }
  return { ok: false, exitCode: auth.code, error: truncate(auth.err || probe.err) }
}
