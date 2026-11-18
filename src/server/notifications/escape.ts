const MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => MAP[c]);
}
/** Only allow http(s) URLs into href attributes. */
export function safeUrl(u: string | null | undefined): string {
  if (!u) return "";
  try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : ""; } catch { return ""; }
}
/**
 * {{var}} interpolation. With html=true the template AND the values are HTML-escaped
 * (newlines become <br>), so user supplied templates cannot inject markup.
 */
export function renderString(template: string, vars: Record<string, string | undefined>, html = false): string {
  const base = html ? escapeHtml(template) : template;
  const out = base.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k] ?? "";
    return html ? escapeHtml(v) : v;
  });
  return html ? out.replace(/\r?\n/g, "<br>") : out;
}
