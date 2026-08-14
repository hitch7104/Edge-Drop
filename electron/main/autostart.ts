/**
 * Run-at-login via a delayed-logon Scheduled Task, with the registry Run key as
 * the fallback.
 *
 * WHY NOT THE RUN KEY: on a rough logon — a shell or DWM hiccup, e.g. a
 * WindowManager.exe crash mid-logon — Windows can silently drop the tail of the
 * `HKCU\...\Run` list, and the app simply never starts. The predecessor tray app
 * (clip2ssh) hit exactly this: no crash, no WER entry, no log line, just absent.
 * A Task Scheduler logon trigger fires independently of the shell, and a 30s
 * delay steps past the boot storm.
 *
 * `InteractiveToken` + `LeastPrivilege` means it runs on the user's desktop at
 * normal integrity: the panel and tray icon appear, no stored password, no UAC.
 */
import { execFile } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { Settings } from '../../shared/types'

// Hyphenated, not the display name: schtasks task names are path-like and a
// space works but quotes badly in every follow-up command a human might type.
// Distinct from the predecessor's `\Clip2SSH` task so both can coexist during
// the transition instead of one silently overwriting the other.
const TASK_NAME = 'Clip2SSH-Edge'

function schtasksPath(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'schtasks.exe')
}

/** Run schtasks and resolve its exit code. Never rejects. */
function runSchtasks(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(schtasksPath(), args, { windowsHide: true, maxBuffer: 1 << 16 }, (err) => {
      if (!err) {
        resolve(0)
        return
      }
      const code = typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code as number : -1
      resolve(code)
    })
  })
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Task Scheduler 1.2 definition.
 *
 * `ExecutionTimeLimit` PT0S = unlimited, required for a long-lived tray app.
 * `IgnoreNew` means a second logon trigger can't spawn a duplicate process
 * (the app's own single-instance lock would reject it anyway, but this avoids
 * the wasted launch).
 */
function taskXml(exePath: string): string {
  const user = `${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? '.'}\\${process.env.USERNAME ?? ''}`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Clip2SSH Edge autostart (delayed logon).</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '      <Delay>PT30S</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>false</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(exePath)}</Command>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join('\r\n')
}

/** True when the logon task exists. */
export async function isScheduledTaskEnabled(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await runSchtasks(['/Query', '/TN', TASK_NAME])) === 0
}

async function createTask(exePath: string): Promise<boolean> {
  // schtasks /XML honors the declared encoding, so the file must really be
  // UTF-16LE with a BOM — a UTF-8 write here fails with a parse error.
  const xmlPath = join(tmpdir(), 'clip2ssh-edge-autostart.xml')
  try {
    writeFileSync(xmlPath, `\ufeff${taskXml(exePath)}`, 'utf16le')
    const code = await runSchtasks(['/Create', '/F', '/TN', TASK_NAME, '/XML', xmlPath])
    if (code !== 0) {
      console.error(`[autostart] schtasks /Create exited ${code}`)
      return false
    }
    return true
  } catch (err) {
    console.error('[autostart] failed to write task XML:', err)
    return false
  } finally {
    try { unlinkSync(xmlPath) } catch { /* best-effort */ }
  }
}

async function deleteTask(): Promise<void> {
  await runSchtasks(['/Delete', '/F', '/TN', TASK_NAME])
}

/**
 * Bring the OS autostart state in line with settings.
 *
 * Only one mechanism is ever active: turning the task on clears the Run key and
 * vice versa, so the app can never be launched twice at logon. Falls back to the
 * Run key when task creation fails (a locked-down machine or Group Policy),
 * because no autostart at all is the worse outcome.
 */
export async function syncScheduledTaskAutostart(settings: Settings): Promise<void> {
  // In development `app.getPath('exe')` is electron.exe — registering that would
  // launch a bare Electron shell at logon.
  if (!app.isPackaged) return

  const setRunKey = (openAtLogin: boolean): void => {
    try {
      app.setLoginItemSettings({ openAtLogin, path: app.getPath('exe') })
    } catch { /* sandboxed or unsupported */ }
  }

  if (process.platform !== 'win32' || settings.launchViaScheduledTask === false) {
    if (process.platform === 'win32') await deleteTask()
    setRunKey(settings.launchAtLogin)
    return
  }

  if (!settings.launchAtLogin) {
    await deleteTask()
    setRunKey(false)
    return
  }

  // Always re-create: the exe path changes after an update to a new versioned
  // install directory, which would leave the task pointing at a deleted binary.
  const ok = await createTask(app.getPath('exe'))
  setRunKey(!ok)
  if (!ok) console.warn('[autostart] scheduled task unavailable — fell back to Run key')
}
