/**
 * The four roles, lowest first. A higher role can do everything a lower one
 * can. No imports here: the screens use this in the browser too.
 *
 *   viewer  reads everything, changes nothing
 *   editor  writes, schedules and publishes posts; media, tags, groups, signatures
 *   admin   network accounts, API keys, feeds, outgoing webhooks, members below admin
 *   owner   everything, including admins and other owners
 */
export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

export const rank = (role: Role): number => ROLES.indexOf(role);

/** True when `have` is `need` or higher. */
export const atLeast = (have: Role, need: Role): boolean => rank(have) >= rank(need);

/** The lower of two roles: what a key may do is never more than its owner may. */
export const lower = (a: Role, b: Role): Role => (rank(a) <= rank(b) ? a : b);

/**
 * Whether someone with `actor` may disable, remove or change the role of a
 * member who has `target`. Owners manage anyone. Admins manage editors and
 * viewers only, so an admin can never touch an owner or another admin.
 */
export const manages = (actor: Role, target: Role): boolean => actor === "owner" || (actor === "admin" && rank(target) < rank("admin"));

/** Whether someone with `actor` may hand out `role`, by invite, by a role change or on an API key: never more than their own. */
export const grants = (actor: Role, role: Role): boolean => atLeast(actor, "admin") && rank(role) <= rank(actor);

export const ROLE_WORDS: Record<Role, string> = {
  viewer: "Reads everything, changes nothing.",
  editor: "Writes, schedules and publishes posts. Manages media, tags, groups and signatures.",
  admin: "Also connects accounts, and manages API keys, feeds, outgoing webhooks, and members below admin.",
  owner: "Everything, including admins and other owners.",
};
