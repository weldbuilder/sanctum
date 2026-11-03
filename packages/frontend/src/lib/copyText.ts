// copyText.ts — copy text to the clipboard on secure AND non-secure pages.
// navigator.clipboard is undefined over plain http (e.g. the Tailscale IP on a
// phone), so fall back to a hidden textarea + document.execCommand('copy').
// Resolves true if the text was copied.
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;'; // 16px: no iOS zoom
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  if (prev && sel) { sel.removeAllRanges(); sel.addRange(prev); }
  return ok;
}
