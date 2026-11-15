/** Pure rules for tag names, shared by the server and the browser: the composer refuses exactly what the server would. */

export const MAX_TAG_CHARS = 40;
export const MAX_TAGS_PER_POST = 20;

/** The form two spellings of one tag share, so "Launch" and "launch" are one tag. */
export const tagKey = (name: string): string => name.normalize("NFKC").toLowerCase();

/** A name as it is stored: trimmed, with runs of spaces closed up. */
export const tidyTagName = (value: string): string => value.trim().replace(/\s+/g, " ");

/** Why a tidied name cannot be a tag, in plain words, or null when it can. */
export function tagProblem(name: string): string | null {
  if (!name) return "A tag needs a name.";
  const length = [...name].length;
  if (length > MAX_TAG_CHARS) return `A tag can be ${MAX_TAG_CHARS} characters; "${[...name].slice(0, 20).join("")}…" is ${length}.`;
  // A comma separates tags where they are typed, and control characters have no place in a name.
  if (/[,\p{Cc}]/u.test(name)) return `A tag cannot contain a comma or a line break: "${name}".`;
  return null;
}
