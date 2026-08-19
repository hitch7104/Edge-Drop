import { describe, it, expect } from 'vitest'
import { isAbsoluteRemote, parseRemoteHome, remoteJoin, resolveUnderHome } from '../electron/main/remotePath'

describe('isAbsoluteRemote', () => {
  it('accepts POSIX absolute paths', () => {
    expect(isAbsoluteRemote('/tmp')).toBe(true)
    expect(isAbsoluteRemote('/home/hitch/drop')).toBe(true)
  })
  it('accepts ~-rooted paths — scp and every remote shell expand them', () => {
    expect(isAbsoluteRemote('~')).toBe(true)
    expect(isAbsoluteRemote('~/drop')).toBe(true)
  })
  it('accepts Windows drive paths with either separator', () => {
    expect(isAbsoluteRemote('C:/Users/JKKim')).toBe(true)
    expect(isAbsoluteRemote('C:\\Users\\hitch')).toBe(true)
  })
  it('rejects the relative forms that need resolving', () => {
    expect(isAbsoluteRemote('.')).toBe(false)
    expect(isAbsoluteRemote('./drop')).toBe(false)
    expect(isAbsoluteRemote('drop')).toBe(false)
    expect(isAbsoluteRemote('')).toBe(false)
  })
  it('ignores surrounding whitespace', () => {
    expect(isAbsoluteRemote('  /tmp  ')).toBe(true)
  })
})

describe('remoteJoin', () => {
  it('joins with a single separator', () => {
    expect(remoteJoin('/tmp', 'clip.png')).toBe('/tmp/clip.png')
    expect(remoteJoin('/tmp/', 'clip.png')).toBe('/tmp/clip.png')
    expect(remoteJoin('/tmp///', 'clip.png')).toBe('/tmp/clip.png')
  })
  it('falls back to /tmp for an empty dir', () => {
    expect(remoteJoin('', 'clip.png')).toBe('/tmp/clip.png')
  })
})

describe('resolveUnderHome', () => {
  it('collapses "." and "" to the home itself', () => {
    expect(resolveUnderHome('C:/Users/JKKim', '.')).toBe('C:/Users/JKKim')
    expect(resolveUnderHome('/home/hitch', '')).toBe('/home/hitch')
  })
  it('roots a relative subdirectory under the home', () => {
    expect(resolveUnderHome('/home/hitch', 'drop')).toBe('/home/hitch/drop')
    expect(resolveUnderHome('/home/hitch', './drop')).toBe('/home/hitch/drop')
  })
  it('normalises backslashes on both sides', () => {
    expect(resolveUnderHome('C:\\Users\\hitch', 'drop\\x')).toBe('C:/Users/hitch/drop/x')
  })
  it('trims trailing separators', () => {
    expect(resolveUnderHome('C:/Users/hitch/', 'drop/')).toBe('C:/Users/hitch/drop')
  })
  it('does not let a relative dir escape to the root', () => {
    expect(resolveUnderHome('/home/hitch', '/etc')).toBe('/home/hitch/etc')
  })
})

describe('parseRemoteHome', () => {
  it('reads POSIX pwd output', () => {
    expect(parseRemoteHome('/home/hitch\n')).toBe('/home/hitch')
  })
  it('reads cmd.exe echo %USERPROFILE% output and normalises separators', () => {
    expect(parseRemoteHome('C:\\Users\\JKKim\r\n')).toBe('C:/Users/JKKim')
  })
  it('reads the path off the end of a PowerShell pwd table', () => {
    expect(parseRemoteHome('Path\r\n----\r\nC:\\Users\\hitch\r\n\r\n')).toBe('C:/Users/hitch')
  })
  it('returns null when the shell echoed the probe back instead of expanding it', () => {
    expect(parseRemoteHome('%USERPROFILE%\n')).toBeNull()
  })
  it('returns null for empty output', () => {
    expect(parseRemoteHome('')).toBeNull()
    expect(parseRemoteHome('   \n\n')).toBeNull()
  })
  it('cannot tell a Cygwin pwd on Windows from a real POSIX home', () => {
    // Documents the limitation the probe order in ssh.ts exists to work around:
    // this path passes the POSIX test but no Windows sftp server accepts it.
    expect(parseRemoteHome('/cygdrive/c/Users/JKKim\n')).toBe('/cygdrive/c/Users/JKKim')
  })
})
