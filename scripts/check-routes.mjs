#!/usr/bin/env node
/**
 * Every route says who may call it, and this fails for one that does not.
 *
 * A route file under src/app passes when each HTTP method it exports is
 * either `route({ role: "…" }, …)`, which checks the caller against that
 * role (src/lib/http.ts), or `open("why", …)`, which marks a route meant for
 * anyone and makes it say why. A bare `export function GET` passes neither,
 * so a new route cannot go out having forgotten to ask.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ROLES = ["viewer", "editor", "admin", "owner"];

/** What one route file declares, method by method: a role, "open", or null when it declares nothing. */
export function inspect(text) {
  const found = {};
  const problems = [];
  // `const handle = route({ role … })` then `export const GET = handle` is one declaration shared by several methods.
  const named = {};
  for (const m of text.matchAll(/^(?:export )?const (\w+) = (route(?:<[^=]*?>)?\(\s*\{\s*role: "(\w+)"|open\(\s*"([^"]+)")/gm)) {
    named[m[1]] = m[3] !== undefined ? m[3] : "open";
  }
  for (const method of METHODS) {
    if (new RegExp(`export (?:async )?function ${method}\\b`).test(text) || new RegExp(`export \\{[^}]*\\b${method}\\b`).test(text)) {
      problems.push(`${method} is exported without route({ role }) or open("why")`);
      continue;
    }
    const direct = text.match(new RegExp(`^export const ${method} = (.*)$`, "m"));
    if (!direct) continue;
    const alias = direct[1].match(/^(\w+);?$/);
    const declared = alias ? named[alias[1]] : named[method];
    if (!declared) problems.push(`${method} does not declare a role: wrap it in route({ role: "…" }, …) or open("why", …)`);
    else if (declared !== "open" && !ROLES.includes(declared)) problems.push(`${method} declares the role "${declared}", which is not one of ${ROLES.join(", ")}`);
    else found[method] = declared;
  }
  if (!Object.keys(found).length && !problems.length) problems.push("exports no HTTP method this check can read");
  return { found, problems };
}

export function routeFiles(dir = root) {
  const files = [];
  (function walk(at) {
    for (const name of readdirSync(at)) {
      const full = path.join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/^route\.tsx?$/.test(name)) files.push(full);
    }
  })(dir);
  return files.sort();
}

/** Every route with the access each method declares, keyed by its address: "/api/v1/posts/[id]". */
export function declared() {
  const table = {};
  const failures = [];
  for (const file of routeFiles()) {
    const address = `/${path.relative(root, path.dirname(file)).split(path.sep).join("/")}`;
    const { found, problems } = inspect(readFileSync(file, "utf8"));
    table[address] = found;
    for (const problem of problems) failures.push(`${address}: ${problem}`);
  }
  return { table, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { table, failures } = declared();
  if (failures.length) {
    console.error(`route check: ${failures.length} problem${failures.length === 1 ? "" : "s"}\n${failures.join("\n")}`);
    process.exit(1);
  }
  const methods = Object.values(table).reduce((n, found) => n + Object.keys(found).length, 0);
  console.log(`route check: ${methods} methods across ${Object.keys(table).length} routes each declare who may call them`);
}
