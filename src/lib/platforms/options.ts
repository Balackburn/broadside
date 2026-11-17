import type { NoticeWhen, OptionSpec } from "./types";

/**
 * Pure rules about a target's options, shared by the server and the browser:
 * the composer, the dry run and the connectors read the same functions, so
 * each says the same thing in the same words.
 *
 * An option is identified by its key. A key the connector does not declare is
 * never an error here: it is left out of what is shown and passed on as it
 * came, which is how the webhook destination carries a caller's own settings.
 */

/** What these rules need to know about a network. */
export type OptionFits = { name: string; options: OptionSpec[]; needsTitle?: string; notice?: string; noticeWhen?: NoticeWhen[] };

export type OptionValues = Record<string, unknown>;

/** A target's options as they were stored, or none when what was stored is not a set of options at all. */
export const valuesOf = (values: unknown): OptionValues => (values && typeof values === "object" && !Array.isArray(values) ? (values as OptionValues) : {});

/** The first line of a post doubles as its title on networks that want one. */
export function titleAndBody(text: string, options: OptionValues, max: number): { title: string; body: string } {
  const given = typeof options.title === "string" && options.title.trim();
  if (given) return { title: given.slice(0, max), body: text };
  const [first, ...rest] = text.split("\n");
  return { title: first.trim().slice(0, max), body: rest.join("\n").trim() };
}

/** What one option holds, as text, or null when it holds nothing and the connector's default applies. */
export function optionValue(spec: OptionSpec, values: unknown): string | null {
  const raw = valuesOf(values)[spec.key];
  if (spec.kind === "boolean") return raw === true ? "on" : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** The declared options that hold a value, in the order the connector declares them. */
export function optionsSet(specs: OptionSpec[], values: unknown): { key: string; label: string; value: string }[] {
  return specs.flatMap((spec) => {
    const value = optionValue(spec, values);
    return value === null ? [] : [{ key: spec.key, label: spec.label, value }];
  });
}

/** One line saying what is set, such as "Title: Notes, Publish as: draft". Empty when every option is at its default. */
export const optionSummary = (specs: OptionSpec[], values: unknown): string => optionsSet(specs, values).map((o) => `${o.label}: ${o.value}`).join(", ");

/**
 * The options to store for a target. A declared option left empty is dropped,
 * so the connector's default applies and nothing is sent for it. Everything
 * else is kept as it is, undeclared keys included.
 */
export function optionsToSend(specs: OptionSpec[], values: unknown): OptionValues {
  const out: OptionValues = { ...valuesOf(values) };
  for (const spec of specs) if (spec.key in out && optionValue(spec, out) === null) delete out[spec.key];
  return out;
}

/** Why a post has no title for a destination that must have one, in the words the destination's connector fails with. Null when it has one or needs none. */
export function missingTitle(c: Pick<OptionFits, "name" | "needsTitle">, text: string, values: unknown): string | null {
  const what = c.needsTitle;
  if (!what || titleAndBody(text, valuesOf(values), Infinity).title) return null;
  return `${c.name} needs a ${what}. Write it as the first line of the post, or set the ${what[0].toUpperCase()}${what.slice(1)} option for this account.`;
}

/** Reasons this text cannot go to this network with these options. */
export function optionProblems(c: Pick<OptionFits, "name" | "needsTitle">, text: string, values: unknown): string[] {
  const title = missingTitle(c, text, values);
  return title ? [title] : [];
}

/** What to say beside an account on this network before a post goes to it, given the options now set. Null when the network has nothing to say. */
export function noticeFor(c: Pick<OptionFits, "notice" | "noticeWhen">, values: unknown): string | null {
  const held = valuesOf(values);
  return c.noticeWhen?.find((when) => held[when.option] === when.is)?.notice ?? c.notice ?? null;
}
