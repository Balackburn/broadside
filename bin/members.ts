#!/usr/bin/env -S npx tsx
/**
 * Team recovery from the server: npm run members -- <command>
 *
 * It opens the data folder directly (BROADSIDE_DATA_DIR, default ./data), so
 * it works with the app stopped or running, and it asks for no password:
 * whoever can run this can already read and change everything in that folder.
 * It never takes a password on the command line. A reset prints a one-time
 * link, and the member chooses the password in their browser.
 */
import { InputError } from "../src/lib/accounts";
import { disableMemberByName, dissolveTeam, enableMemberByName, INVITE_DAYS, listInvites, listMembers, resetMember, teamMode } from "../src/lib/members";

const USAGE = `Usage: npm run members -- <command>

  list                 Every member with their role, and whether they are disabled
  reset <name>         Throw away a member's password and print a one-time link to choose a new one
  disable <name>       Sign a member out everywhere and stop their API keys
  enable <name>        Let a disabled member sign in again
  leave-team --yes     Remove every member and go back to one operator

The data folder is BROADSIDE_DATA_DIR, or ./data.`;

const base = (process.env.BROADSIDE_PUBLIC_URL || `http://localhost:${process.env.PORT || "3000"}`).replace(/\/+$/, "");
const [command, ...rest] = process.argv.slice(2);
const flags = rest.filter((arg) => arg.startsWith("--"));
const name = rest.filter((arg) => !arg.startsWith("--")).join(" ");

function needName(): string {
  if (!name) throw new InputError(`Say which member: npm run members -- ${command} <name>`);
  return name;
}

try {
  if (command === "list") {
    const members = listMembers();
    if (!members.length) {
      console.log("This Broadside has no team. It is in single-user mode: start a team from the Team screen in the app.");
    } else {
      const width = Math.max(...members.map((m) => m.name.length), 4);
      console.log(`${"Name".padEnd(width)}  Role    State`);
      for (const m of members) console.log(`${m.name.padEnd(width)}  ${m.role.padEnd(6)}  ${m.disabled_at ? `disabled ${m.disabled_at.slice(0, 10)}` : m.last_seen_at ? `last here ${m.last_seen_at.slice(0, 10)}` : "has not signed in"}`);
      const waiting = listInvites().length;
      if (waiting) console.log(`\n${waiting} invite${waiting === 1 ? " is" : "s are"} waiting to be used.`);
    }
  } else if (command === "reset") {
    const { member, token } = resetMember(needName());
    console.log(`${member.name} has no password now and is signed out everywhere.${member.disabled_at ? ` They are still disabled: run "npm run members -- enable ${member.name}" as well.` : ""}`);
    console.log(`Send them this link. It works once and runs out in ${INVITE_DAYS} days:\n\n  ${base}/join/${token}\n`);
    if (!process.env.BROADSIDE_PUBLIC_URL) console.log("The address above is a guess, because BROADSIDE_PUBLIC_URL is not set here. Keep the /join/... part and put this Broadside's real address in front.");
  } else if (command === "disable") {
    const member = disableMemberByName(needName());
    console.log(`${member.name} is disabled: signed out everywhere, and their API keys no longer work.`);
  } else if (command === "enable") {
    const member = enableMemberByName(needName());
    console.log(`${member.name} can sign in again.`);
  } else if (command === "leave-team") {
    if (!teamMode()) {
      console.log("This Broadside has no team. Nothing to do.");
    } else if (!flags.includes("--yes")) {
      console.error(
        `This removes all ${listMembers().length} members, every invite, and every API key that belongs to a member.\n` +
          "Posts, accounts, media and API keys from before the team stay. Afterwards anyone who can reach the app is the operator,\n" +
          "as before the team: behind BROADSIDE_PASSWORD if it is set, and open on this machine if it is not.\n\n" +
          "Run it again with --yes to go ahead: npm run members -- leave-team --yes",
      );
      process.exitCode = 1;
    } else {
      const gone = dissolveTeam();
      console.log(`Removed ${gone.members} member${gone.members === 1 ? "" : "s"}, ${gone.invites} invite${gone.invites === 1 ? "" : "s"} and ${gone.keys} member API key${gone.keys === 1 ? "" : "s"}. This Broadside is in single-user mode again.`);
    }
  } else {
    console.log(USAGE);
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof InputError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
