// Minimal E.164 normalisation. Deliberately not a full libphonenumber: we need
// a stable dedup key, not perfect validation, and an unparseable number must
// never cost us the report.
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE ?? "57"; // Colombia

export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) d = d.slice(1);
  d = d.replace(/^00/, "");
  // Local mobile without country code (Colombia: 10 digits starting with 3).
  if (d.length === 10 && d.startsWith("3")) d = DEFAULT_CC + d;
  if (d.length < 8 || d.length > 15) return null;
  return "+" + d;
}
