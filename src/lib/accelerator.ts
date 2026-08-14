/**
 * Keyboard event -> Electron accelerator string.
 *
 * Used by the SSH target hotkey picker. Reads `event.code` (physical key) rather
 * than `event.key`, because `event.key` for Shift+2 is '@' on a US layout and
 * something else entirely on others — the accelerator must name the key, not the
 * character it produces.
 */

/** Keys that are only modifiers — pressing one alone is not a chord yet. */
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight',
  'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight'
])

const NAMED_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '~'
}

export function isModifierOnly(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

/**
 * Build an accelerator, or return null when the chord is unusable.
 *
 * At least one modifier is required: a bare global shortcut would swallow that
 * key in every application on the system.
 */
export function toAccelerator(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = e.code
  if (!code || isModifierOnly(code)) return null

  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  if (mods.length === 0) return null

  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  else key = NAMED_CODES[code] ?? null

  if (!key) return null
  return [...mods, key].join('+')
}
