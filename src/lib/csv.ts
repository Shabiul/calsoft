/** CSV with spreadsheet-formula protection: cells starting with = + - @ (or tab/CR) are prefixed so Excel never evaluates them. */
export function csvCell(v: unknown): string {
  let s = v instanceof Date ? v.toISOString() : v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header: string[], rows: unknown[][]): string => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
