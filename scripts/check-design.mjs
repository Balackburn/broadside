#!/usr/bin/env node
/**
 * The design floor as a check that fails: colours and fonts only through
 * tokens, no blanket transitions, reduced motion honoured, no sideways scroll.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = [];
const vendored = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    // Vendored blocks keep their authors' styling; they must say where they came from instead.
    else if (/\.(tsx|css)$/.test(name)) (full.includes(`${path.sep}vendor${path.sep}`) ? vendored : files).push(full);
  }
})(root);

const failures = [];
const fail = (file, line, message) => failures.push(`${path.relative(root, file)}:${line} ${message}`);

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const isTokens = file.endsWith("globals.css");
  const lines = text.split("\n");
  // In the stylesheet, literal colours belong to the token blocks at the top only.
  const tokensEnd = isTokens ? lines.findIndex((l) => l.startsWith("@theme")) : -1;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/transition:\s*all|transition-all/.test(line)) fail(file, n, "blanket transition; name the properties");
    if (/\bease-in\b(?!-out)/.test(line)) fail(file, n, "ease-in makes an interface feel slow; use an ease-out token");
    if (/scale\(0\)/.test(line)) fail(file, n, "nothing enters from scale(0)");
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|rgb|rgba|hsl|hsla)\(/.test(line);
    const exempt = file.endsWith("layout.tsx") || file.endsWith("opengraph-image.tsx") || (isTokens && i < tokensEnd);
    if (literal && !exempt && !/&#\d+;|href="#|href=\{`#/.test(line)) fail(file, n, "colour literal; use a token from globals.css");
    if (/font-family:\s*(?!var\()/.test(line) && !isTokens) fail(file, n, "font named outside the tokens");
    if (/tracking-(wide|wider|widest)|uppercase/.test(line)) fail(file, n, "no tracked capitals for labels");
    // Dates formatted in render differ between server and browser and break hydration.
    if (/\{when\(/.test(line) && !/composer\.tsx$/.test(file)) fail(file, n, "format dates with <Time>, not when(), so server and browser agree");
  });
  if (isTokens) {
    if (!/prefers-reduced-motion: reduce/.test(text)) fail(file, 1, "missing the reduced-motion guard");
    if (!/overflow-x: clip/.test(text)) fail(file, 1, "html and body must clip sideways overflow");
    if (!/:focus-visible/.test(text)) fail(file, 1, "missing a visible focus style");
  }
}

for (const file of vendored) {
  if (!/MIT licensed/.test(readFileSync(file, "utf8").slice(0, 600))) failures.push(`${path.relative(root, file)}:1 vendored file must name its source and licence in its header`);
}

if (failures.length) {
  console.error(`design check: ${failures.length} problem${failures.length === 1 ? "" : "s"}\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`design check: clean across ${files.length} files`);
