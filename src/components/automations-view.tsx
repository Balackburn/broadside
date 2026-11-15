"use client";

import type { Feed } from "@/lib/feeds";
import type { OutgoingWebhook } from "@/lib/outgoing";
import { FeedsPanel } from "./feeds-panel";
import { OutgoingPanel } from "./outgoing-panel";
import { useToast } from "./ui";

type Account = { id: string; platform: string; handle: string };
type Group = { id: string; name: string; account_ids: string[] };

/** The two things Broadside does without being asked each time: post from feeds, and tell other services what happened. */
export function AutomationsView({ feeds, webhooks, accounts, groups }: { feeds: Feed[]; webhooks: OutgoingWebhook[]; accounts: Account[]; groups: Group[] }) {
  const { show, toast } = useToast();
  return (
    <div>
      <h1 className="heading text-4xl">Automations</h1>
      <p className="mt-3 max-w-2xl text-lg leading-snug text-ink-2">Post from an RSS or Atom feed when it has something new, and tell your other tools when a post goes out or fails.</p>
      <FeedsPanel feeds={feeds} accounts={accounts} groups={groups} show={show} />
      <OutgoingPanel webhooks={webhooks} show={show} />
      {toast}
    </div>
  );
}
