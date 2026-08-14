/**
 * Settings > Targets — CRUD for scp upload destinations.
 *
 * Lives in its own component so `Settings.tsx` only gains a tab id, a label, and
 * one render line; everything else this fork adds stays here.
 *
 * Edits are committed on blur (or immediately for toggles/selects) rather than
 * on every keystroke: each save round-trips through the main process, which also
 * re-registers global hotkeys.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store/appStore'
import { DEFAULT_SSH_PROFILE, type SshProfile, type SshUploadResult } from '../../shared/types'
import { playButtonClickSound, playToggleSound } from '../lib/soundEffects'
import { toAccelerator, isModifierOnly } from '../lib/accelerator'
import { useTranslation } from '../i18n'
import { PlusIcon } from './icons'
import '../styles/ssh.css'

/** Local, dependency-free id — profiles only need uniqueness within settings.json. */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function SshTargetsTab() {
  const { t } = useTranslation()
  const profiles = useStore((s) => s.settings.sshProfiles)
  const defaultId = useStore((s) => s.settings.defaultSshProfileId)
  const patch = useStore((s) => s.patchSettings)
  const [editingId, setEditingId] = useState<string | null>(null)

  const save = useCallback((next: SshProfile[], nextDefault?: string) => {
    void patch({
      sshProfiles: next,
      ...(nextDefault !== undefined ? { defaultSshProfileId: nextDefault } : {})
    })
  }, [patch])

  const updateOne = useCallback((id: string, changes: Partial<SshProfile>) => {
    save(profiles.map((p) => (p.id === id ? { ...p, ...changes } : p)))
  }, [profiles, save])

  const addTarget = useCallback(() => {
    playButtonClickSound()
    const created: SshProfile = { ...DEFAULT_SSH_PROFILE, id: newId() }
    save([...profiles, created], profiles.length === 0 ? created.id : undefined)
    setEditingId(created.id)
  }, [profiles, save])

  const removeTarget = useCallback((id: string) => {
    if (!window.confirm(t('ssh.removeConfirm'))) return
    playButtonClickSound()
    const next = profiles.filter((p) => p.id !== id)
    // Hand the default to whatever survives; main normalizes a stale pointer too,
    // but doing it here keeps the UI from flashing an unset default.
    save(next, id === defaultId ? next[0]?.id : undefined)
    if (editingId === id) setEditingId(null)
  }, [profiles, defaultId, editingId, save, t])

  return (
    <>
      <div className="setting-group-label">{t('ssh.sectionTitle')}</div>
      <div className="setting-desc" style={{ marginBottom: 10 }}>{t('ssh.sectionDesc')}</div>

      {profiles.length === 0 && <div className="ssh-empty">{t('ssh.empty')}</div>}

      <div className="ssh-list">
        {profiles.map((p) => (
          <TargetCard
            key={p.id}
            profile={p}
            isDefault={p.id === defaultId}
            expanded={editingId === p.id}
            onToggleExpand={() => setEditingId(editingId === p.id ? null : p.id)}
            onChange={(changes) => updateOne(p.id, changes)}
            onMakeDefault={() => save(profiles, p.id)}
            onRemove={() => removeTarget(p.id)}
          />
        ))}
      </div>

      <div className="ssh-row-actions">
        <button className="ssh-btn" onClick={addTarget}>
          <PlusIcon width={12} height={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {t('ssh.addTarget')}
        </button>
      </div>
    </>
  )
}

interface CardProps {
  profile: SshProfile
  isDefault: boolean
  expanded: boolean
  onToggleExpand: () => void
  onChange: (changes: Partial<SshProfile>) => void
  onMakeDefault: () => void
  onRemove: () => void
}

function TargetCard({ profile, isDefault, expanded, onToggleExpand, onChange, onMakeDefault, onRemove }: CardProps) {
  const { t } = useTranslation()
  const [testState, setTestState] = useState<'idle' | 'testing'>('idle')
  const [testResult, setTestResult] = useState<SshUploadResult | null>(null)

  const runTest = useCallback(async () => {
    playButtonClickSound()
    setTestState('testing')
    setTestResult(null)
    try {
      setTestResult(await window.edge.testSshProfile(profile))
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    } finally {
      setTestState('idle')
    }
  }, [profile])

  const target = `${profile.user || '?'}@${profile.host || '?'}:${profile.remoteDir}`

  return (
    <div className="ssh-card">
      <div className="ssh-card-head">
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="ssh-card-title">{profile.name}</div>
          <div className="ssh-card-sub">{target}</div>
        </div>
        {isDefault && <span className="ssh-badge is-default">{t('ssh.isDefault')}</span>}
        {profile.hotkey && <span className="ssh-badge">{profile.hotkey}</span>}
        <button className="ssh-btn" onClick={() => { playButtonClickSound(); onToggleExpand() }}>
          {expanded ? t('ssh.done') : t('ssh.edit')}
        </button>
      </div>

      {expanded && (
        <>
          <div className="ssh-fields">
            <TextField label={t('ssh.name')} value={profile.name} onCommit={(v) => onChange({ name: v })} />
            <TextField label={t('ssh.host')} value={profile.host} onCommit={(v) => onChange({ host: v })} />
            <TextField label={t('ssh.user')} value={profile.user} onCommit={(v) => onChange({ user: v })} />
            <TextField
              label={t('ssh.port')}
              value={String(profile.port)}
              inputMode="numeric"
              onCommit={(v) => {
                const n = Number(v)
                onChange({ port: Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : 22 })
              }}
            />
            <div className="ssh-field wide">
              <label>{t('ssh.remoteDir')}</label>
              <TextInput value={profile.remoteDir} onCommit={(v) => onChange({ remoteDir: v })} />
            </div>
            <div className="ssh-field wide">
              <label>{t('ssh.fileNamePattern')}</label>
              <TextInput value={profile.fileNamePattern} onCommit={(v) => onChange({ fileNamePattern: v })} />
            </div>
            <div className="ssh-field">
              <label>{t('ssh.imageFormat')}</label>
              <select
                value={profile.imageFormat}
                onChange={(e) => onChange({ imageFormat: e.target.value as SshProfile['imageFormat'] })}
              >
                <option value="original">{t('ssh.formatOriginal')}</option>
                <option value="png">{t('ssh.formatPng')}</option>
                <option value="jpeg">{t('ssh.formatJpeg')}</option>
              </select>
            </div>
            {profile.imageFormat === 'jpeg' && (
              <TextField
                label={t('ssh.jpgQuality')}
                value={String(profile.jpgQuality)}
                inputMode="numeric"
                onCommit={(v) => {
                  const n = Number(v)
                  onChange({ jpgQuality: Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 90 })
                }}
              />
            )}
            <div className="ssh-field wide">
              <label>{t('ssh.hotkey')}</label>
              <HotkeyPicker value={profile.hotkey} onChange={(v) => onChange({ hotkey: v })} />
            </div>
          </div>

          <div className="setting-row" style={{ marginTop: 10 }}>
            <div className="setting-info">
              <div className="setting-title">{t('ssh.replaceClipboard')}</div>
            </div>
            <MiniToggle
              checked={profile.replaceClipboard}
              onChange={(v) => onChange({ replaceClipboard: v })}
            />
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">{t('ssh.notify')}</div>
              <div className="setting-desc">{t('ssh.notifyDesc')}</div>
            </div>
            <MiniToggle checked={profile.notify} onChange={(v) => onChange({ notify: v })} />
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <div className="setting-title">{t('ssh.legacyScp')}</div>
              <div className="setting-desc">{t('ssh.legacyScpDesc')}</div>
            </div>
            <MiniToggle checked={profile.legacyScp} onChange={(v) => onChange({ legacyScp: v })} />
          </div>

          <div className="ssh-row-actions">
            <button className="ssh-btn" onClick={runTest} disabled={testState === 'testing'}>
              {testState === 'testing' ? t('ssh.testing') : t('ssh.test')}
            </button>
            {!isDefault && (
              <button className="ssh-btn" onClick={() => { playButtonClickSound(); onMakeDefault() }}>
                {t('ssh.makeDefault')}
              </button>
            )}
            <button className="ssh-btn danger" onClick={onRemove}>{t('ssh.remove')}</button>
          </div>

          {testResult && (
            <div className={`ssh-status ${testResult.ok ? 'ok' : 'err'}`}>
              {!testResult.ok
                ? testResult.error
                : testResult.remotePath
                  // remotePath present means the write probe actually confirmed it.
                  ? t('ssh.testOk').replace('{dir}', testResult.remotePath)
                  : t('ssh.testConnected')}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Field primitives                                                    */
/* ------------------------------------------------------------------ */

/**
 * Text input that keeps its own draft and reports on blur/Enter.
 *
 * Committing per keystroke would fire a settings write (and a hotkey rebind) for
 * every character typed.
 */
function TextInput({
  value,
  onCommit,
  inputMode
}: {
  value: string
  onCommit: (v: string) => void
  inputMode?: 'numeric' | 'text'
}) {
  const [draft, setDraft] = useState(value)
  const dirty = useRef(false)

  // Adopt external changes (e.g. main normalized the value) unless mid-edit.
  useEffect(() => {
    if (!dirty.current) setDraft(value)
  }, [value])

  const commit = (): void => {
    dirty.current = false
    if (draft !== value) onCommit(draft.trim())
  }

  return (
    <input
      value={draft}
      inputMode={inputMode}
      spellCheck={false}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value) }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { dirty.current = false; setDraft(value) }
      }}
    />
  )
}

function TextField({
  label,
  value,
  onCommit,
  inputMode
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  inputMode?: 'numeric' | 'text'
}) {
  return (
    <div className="ssh-field">
      <label>{label}</label>
      <TextInput value={value} onCommit={onCommit} inputMode={inputMode} />
    </div>
  )
}

/**
 * Click to arm, then press a chord. Backspace clears it.
 *
 * A chord with no modifier is rejected (the accelerator helper returns null),
 * because registering a bare key globally would swallow it system-wide.
 */
function HotkeyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  const [listening, setListening] = useState(false)

  useEffect(() => {
    if (!listening) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isModifierOnly(e.code)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') { setListening(false); return }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        onChange('')
        setListening(false)
        return
      }
      const accel = toAccelerator(e)
      if (!accel) return   // keep listening until a valid chord arrives
      onChange(accel)
      setListening(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [listening, onChange])

  return (
    <button
      className={`ssh-btn ssh-chord${listening ? ' listening' : ''}`}
      style={{ width: '100%' }}
      onClick={() => { playButtonClickSound(); setListening(!listening) }}
    >
      {listening ? t('ssh.hotkeyListening') : (value || t('ssh.hotkeyNone'))}
    </button>
  )
}

/** Compact switch matching the settings rows without importing Settings.tsx internals. */
function MiniToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => { playToggleSound(!checked); onChange(!checked) }}
      style={{
        position: 'relative',
        width: 38,
        height: 21,
        flex: '0 0 auto',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.16)',
        background: checked ? '#ffffff' : 'rgba(255,255,255,0.08)',
        transition: 'background 160ms ease',
        cursor: 'pointer'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 19 : 2,
          width: 15,
          height: 15,
          borderRadius: '50%',
          background: checked ? '#000000' : '#ffffff',
          transition: 'left 160ms cubic-bezier(0.22,1,0.36,1)'
        }}
      />
    </button>
  )
}
