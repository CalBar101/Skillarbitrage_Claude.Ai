/** Digits-only phone normalisation. 10-digit numbers are assumed Indian and get the 91 prefix. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

/** E.164 form (+91XXXXXXXXXX) that Zipteams prefers. */
export function toE164(raw: string): string {
  const d = normalisePhone(raw);
  return d ? `+${d}` : "";
}
