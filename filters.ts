// The rules that decide what reaches the inbox list. They run locally for
// every provider: Gmail could enforce them server-side but IMAP cannot, and
// one rule implemented twice is one rule that will drift.
import type { ParsedMessage } from "./gmail";

/**
 * The sender allowlist, as typed by the user, turned into match terms.
 *
 * A term with an `@` matches the full address; a bare domain matches everyone
 * at it. A leading `@` is stripped so `@acme.com` and `acme.com` behave the
 * same, which is what people expect from typing either.
 */
export function parseSenders(raw: string | readonly string[]): string[] {
  const text = typeof raw === "string" ? raw : raw.join(",");
  const seen = new Set<string>();
  for (const part of text.split(/[,\n;]/)) {
    const term = part.trim().replace(/^@/, "").toLowerCase();
    if (term === "" || /[\s{}()"]/.test(term)) continue;
    seen.add(term);
  }
  return [...seen];
}

/** The bare address out of `Name <a@b.c>`, or the whole string if unadorned. */
export function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from);
  return (angled?.[1] ?? from).trim().toLowerCase();
}

/**
 * The project this sender's mail has ended up in before, if any.
 *
 * A plain majority over past tickets for the same tracker. Every one of those
 * was approved by hand in the save modal, so the user's own history is better
 * evidence than a fresh guess at the same mail. Ties go to the most recent:
 * `history` is newest-first, and a client that moved to a follow-up project
 * keeps mailing from the same address.
 *
 * `from` is optional because it is: links are read back from key-value storage
 * with a cast and no schema parse, so every link written before this shipped
 * has no sender key at all. Those simply never match.
 */
export function learnedProject(
  history: readonly { from?: string; target: string; projectId: string }[],
  from: string,
  target: string,
): { projectId: string; count: number } | null {
  const address = addressOf(from);
  if (address === "") return null;
  const mine = history.filter(
    (link) =>
      link.target === target &&
      link.projectId !== "" &&
      typeof link.from === "string" &&
      addressOf(link.from) === address,
  );
  const counts = new Map<string, number>();
  for (const link of mine) {
    counts.set(link.projectId, (counts.get(link.projectId) ?? 0) + 1);
  }
  let best: { projectId: string; count: number } | null = null;
  for (const link of mine) {
    const count = counts.get(link.projectId) ?? 0;
    if (best === null || count > best.count) {
      best = { projectId: link.projectId, count };
    }
  }
  return best;
}

export function matchesSenders(from: string, senders: string[]): boolean {
  if (senders.length === 0) return true;
  const address = addressOf(from);
  const domain = address.split("@")[1] ?? "";
  return senders.some(
    (term) => term === address || term === domain || domain.endsWith(`.${term}`),
  );
}

const INVITE_SUBJECT =
  /^\s*(invitation|updated invitation|invitation from|accepted|declined|tentative|canceled event|cancelled event|uitnodiging|bijgewerkte uitnodiging)\b[:.]?/i;

/** Calendar invites are mail a tracker never wants, in any mailbox. */
export function isMeetingInvite(message: ParsedMessage): boolean {
  if (INVITE_SUBJECT.test(message.subject)) return true;
  return message.attachments.some(
    (file) =>
      file.mimeType.toLowerCase().startsWith("text/calendar") ||
      file.filename.toLowerCase().endsWith(".ics"),
  );
}

export function keepMessage(
  message: ParsedMessage,
  options: { senders: string[]; excludeInvites: boolean },
): boolean {
  if (options.excludeInvites && isMeetingInvite(message)) return false;
  return matchesSenders(message.from, options.senders);
}
