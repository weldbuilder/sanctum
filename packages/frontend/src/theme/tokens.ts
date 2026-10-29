/**
 * The editable theme tokens and font stacks. Mirrored on the backend
 * (THEME_TOKEN_ALLOWLIST in packages/backend/src/routes/api.ts) — keep both
 * lists in sync if the editable set ever changes. Lives apart from the zustand
 * store so the pure appearance helpers (and their tests) can import it.
 */

export type ThemeTokenKind = 'color' | 'font';

export interface ThemeToken {
  key: string;
  label: string;
  hint?: string;
  kind: ThemeTokenKind;
  /** The value baked into index.css :root — what "reset" returns to. */
  fallback: string;
}

export const THEME_TOKENS: ThemeToken[] = [
  // ── Backgrounds ──
  { key: '--bg-primary', label: 'Hearth floor', hint: 'Primary background', kind: 'color', fallback: '#0c0b09' },
  { key: '--bg-secondary', label: 'Surface', hint: 'Panels, rail, cards', kind: 'color', fallback: '#131210' },
  { key: '--bg-input', label: 'Input fields', kind: 'color', fallback: '#0f0e0c' },
  // ── Text ──
  { key: '--text-primary', label: 'Text — primary', kind: 'color', fallback: '#e2dbd0' },
  { key: '--text-secondary', label: 'Text — secondary', kind: 'color', fallback: '#a09689' },
  { key: '--text-muted', label: 'Text — muted', kind: 'color', fallback: '#6a6258' },
  // ── Border ──
  { key: '--border', label: 'Border tint', kind: 'color', fallback: 'rgba(255, 255, 255, 0.06)' },
  // ── Companion accent (amber family) ──
  { key: '--amber', label: 'Companion accent', hint: 'The being’s colour', kind: 'color', fallback: '#c9a87c' },
  { key: '--amber-bright', label: 'Companion accent — bright', hint: 'Hover / emphasis', kind: 'color', fallback: '#e3c49a' },
  // ── User accent (lavender family) ──
  { key: '--lavender', label: 'Your accent', kind: 'color', fallback: '#a893c0' },
  { key: '--lavender-bright', label: 'Your accent — bright', hint: 'Hover / emphasis', kind: 'color', fallback: '#c4b5e3' },
  // ── Shared / status ──
  { key: '--gold', label: 'Shared — champagne gold', hint: 'Reserved, joint moments', kind: 'color', fallback: '#c4a872' },
  { key: '--status-active', label: 'Status — active', kind: 'color', fallback: '#6dba88' },
  // ── Fonts ──
  { key: '--font-serif', label: 'Serif', hint: 'Headings, wordmark, editorial voice', kind: 'font', fallback: "'Lora', Georgia, 'Times New Roman', serif" },
  { key: '--font-body', label: 'Body', hint: 'Everyday text', kind: 'font', fallback: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" },
  { key: '--font-mono', label: 'Monospace', hint: 'Code, meta, timestamps', kind: 'font', fallback: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace" },
];

export const TOKEN_KEYS = new Set(THEME_TOKENS.map(t => t.key));

// A few safe, hand-picked stacks per font role — kept small and deliberate
// rather than a free-text field, so a save can't wedge the UI in an unreadable
// font. Each entry's value is the full CSS font-family string to inject.
export const FONT_CHOICES: Record<'--font-serif' | '--font-body' | '--font-mono', Array<{ label: string; value: string }>> = {
  '--font-serif': [
    { label: 'Lora (default)', value: "'Lora', Georgia, 'Times New Roman', serif" },
    { label: 'Playfair Display', value: "'Playfair Display', Georgia, serif" },
    { label: 'Cormorant Garamond', value: "'Cormorant Garamond', Georgia, serif" },
    { label: 'Merriweather', value: "'Merriweather', Georgia, serif" },
    { label: 'Georgia (system)', value: "Georgia, 'Times New Roman', serif" },
  ],
  '--font-body': [
    { label: 'Lora (default)', value: "'Lora', Georgia, 'Times New Roman', serif" },
    { label: 'Inter', value: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" },
    { label: 'Source Sans 3', value: "'Source Sans 3', -apple-system, sans-serif" },
    { label: 'Nunito Sans', value: "'Nunito Sans', -apple-system, sans-serif" },
    { label: 'System UI', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" },
  ],
  '--font-mono': [
    { label: 'JetBrains Mono (default)', value: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace" },
    { label: 'Fira Code', value: "'Fira Code', ui-monospace, monospace" },
    { label: 'IBM Plex Mono', value: "'IBM Plex Mono', ui-monospace, monospace" },
    { label: 'System monospace', value: "ui-monospace, Menlo, Consolas, monospace" },
  ],
};

