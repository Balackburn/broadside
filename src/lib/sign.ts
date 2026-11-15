/**
 * Adding a signature to a post is plain text editing: the signature goes on
 * the end, a blank line after what is already there. It is then part of the
 * post like any other text, measured against every network's limit.
 * No database here: the composer runs this in the browser.
 */
export function appendSignature(text: string, signature: string): string {
  const body = text.replace(/\s+$/, "");
  const sign = signature.trim();
  if (!sign) return text;
  return body ? `${body}\n\n${sign}` : sign;
}

/** Whether the text already ends with this signature, so it is not offered twice. */
export function endsWithSignature(text: string, signature: string): boolean {
  const sign = signature.trim();
  return Boolean(sign) && text.replace(/\s+$/, "").endsWith(sign);
}
