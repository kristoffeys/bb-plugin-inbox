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
