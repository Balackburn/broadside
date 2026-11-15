import { InputError } from "./accounts";
import { newId } from "./crypto";
import { all, get, now, run } from "./db";
import { MAX_TAGS_PER_POST, tagKey, tagProblem, tidyTagName } from "./tag-rules";

export { tagKey } from "./tag-rules";

/**
 * Tags are short names a post carries, for finding it again. A tag exists once
 * however it is capitalised, is created the first time a post uses it, and
 * outlives the posts that carry it until someone deletes it.
 */

export type Tag = { id: string; name: string; posts: number; created_at: string };

type TagRow = { id: string; name: string; name_key: string; created_at: string };

/** A name as it is stored. Refuses anything that is not a short single-line name. */
export function cleanTagName(value: unknown): string {
  if (typeof value !== "string") throw new InputError("A tag is a short name, sent as a string.");
  const name = tidyTagName(value);
  const problem = tagProblem(name);
  if (problem) throw new InputError(problem);
  return name;
}

/** The tags of one post as sent by a caller: cleaned, and listed once each whatever their case. */
export function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError("tags must be a list of names.");
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    const name = cleanTagName(item);
    if (seen.has(tagKey(name))) continue;
    seen.add(tagKey(name));
    names.push(name);
  }
  if (names.length > MAX_TAGS_PER_POST) throw new InputError(`A post can carry ${MAX_TAGS_PER_POST} tags; this has ${names.length}.`);
  return names;
}

const withCount = "SELECT t.id, t.name, t.created_at, (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS posts FROM tags t";

export function listTags(): Tag[] {
  return all<Tag>(`${withCount} ORDER BY t.name_key`);
}

export function getTag(id: string): Tag | undefined {
  return get<Tag>(`${withCount} WHERE t.id = ?`, id);
}

/** The tag with this name, made if it does not exist yet. The first spelling is the one kept. */
function ensure(name: string): string {
  const key = tagKey(name);
  const existing = get<TagRow>("SELECT * FROM tags WHERE name_key = ?", key);
  if (existing) return existing.id;
  const id = newId("tag");
  run("INSERT INTO tags (id, name, name_key, created_at) VALUES (?, ?, ?, ?)", id, name, key, now());
  return id;
}

/** Creates a tag, or returns the one that already has this name. */
export function createTag(value: unknown): Tag {
  return getTag(ensure(cleanTagName(value)))!;
}

/** Renames a tag everywhere at once: posts point at the tag, not at its name. */
export function renameTag(id: string, value: unknown): Tag {
  const name = cleanTagName(value);
  if (!get("SELECT 1 AS found FROM tags WHERE id = ?", id)) throw new InputError(`No tag with id ${id}.`);
  const taken = get<TagRow>("SELECT * FROM tags WHERE name_key = ? AND id <> ?", tagKey(name), id);
  if (taken) throw new InputError(`A tag called "${taken.name}" already exists.`);
  run("UPDATE tags SET name = ?, name_key = ? WHERE id = ?", name, tagKey(name), id);
  return getTag(id)!;
}

/** Deletes a tag and takes it off every post. The posts themselves are untouched. */
export function deleteTag(id: string): boolean {
  run("DELETE FROM post_tags WHERE tag_id = ?", id);
  return run("DELETE FROM tags WHERE id = ?", id) > 0;
}

/** The names of a post's tags, in alphabetical order. */
export function tagsOf(postId: string): string[] {
  return all<{ name: string }>("SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.name_key", postId).map((row) => row.name);
}

/** Replaces a post's tags with these names, creating any that are new. Call inside the post's own transaction. */
export function setPostTags(postId: string, names: string[]): void {
  run("DELETE FROM post_tags WHERE post_id = ?", postId);
  for (const name of names) run("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)", postId, ensure(name));
}

/** Gives one post the tags of another, as the next occurrence of a repeating post takes after the last. */
export function copyPostTags(fromPostId: string, toPostId: string): void {
  run("INSERT OR IGNORE INTO post_tags (post_id, tag_id) SELECT ?, tag_id FROM post_tags WHERE post_id = ?", toPostId, fromPostId);
}
