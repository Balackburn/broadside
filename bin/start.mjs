#!/usr/bin/env node
/**
 * Starts the built app. It listens on this machine only unless you ask for
 * more, and it refuses to listen on a network without a password: an open
 * Broadside lets anyone who can reach it post as you.
 */
import { spawn } from "node:child_process";

const host = process.env.BROADSIDE_HOST || "127.0.0.1";
const port = process.env.PORT || "3000";
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);

if (!loopback && !process.env.BROADSIDE_PASSWORD) {
  console.error(
    `Broadside will not listen on ${host} without a password.\n` +
      `Set BROADSIDE_PASSWORD (and BROADSIDE_PUBLIC_URL to the address people will use), or leave BROADSIDE_HOST unset to stay on this machine.`,
  );
  process.exit(1);
}

const extra = process.argv.slice(2);
if (extra.some((arg) => /^(-H|--hostname)(=|$)/.test(arg) || /^-H./.test(arg))) {
  console.error("Set BROADSIDE_HOST instead of passing -H, so the password check above applies.");
  process.exit(1);
}

const child = spawn("npx", ["next", "start", "-H", host, "-p", port, ...extra], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
