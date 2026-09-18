// Mailbox accounts. Gmail (OAuth) and plain IMAP live behind one model so the
// rest of the plugin never branches on provider except when actually fetching.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoredTokens } from "./gmail";

export const gmailAccountSchema = z.object({
  id: z.string(),
  kind: z.literal("gmail"),
  label: z.string(),
  email: z.string().nullable(),
});

export const imapAccountSchema = z.object({
  id: z.string(),
  kind: z.literal("imap"),
  label: z.string(),
  email: z.string().nullable(),
  host: z.string(),
  port: z.number(),
  secure: z.boolean(),
  user: z.string(),
  mailbox: z.string(),
});

export const accountSchema = z.discriminatedUnion("kind", [
  gmailAccountSchema,
  imapAccountSchema,
]);
export type Account = z.infer<typeof accountSchema>;
export type GmailAccount = z.infer<typeof gmailAccountSchema>;
export type ImapAccount = z.infer<typeof imapAccountSchema>;

/**
 * Secrets are kept out of the account record so every list/status path can
 * hand an account straight to the frontend without a scrubbing step.
 */
export type AccountSecrets = {
  /** Gmail OAuth tokens. */
  tokens?: StoredTokens;
  /** IMAP password or app password. */
  password?: string;
};

export function newAccountId(): string {
  return `acc_${randomUUID().slice(0, 8)}`;
}

/**
 * Message ids are namespaced by account: Gmail ids are globally unique but
 * IMAP UIDs are per-mailbox, so two accounts would otherwise collide.
 */
export function composeMessageId(accountId: string, nativeId: string): string {
  return `${accountId}::${nativeId}`;
}

export function splitMessageId(messageId: string): {
  accountId: string;
  nativeId: string;
} {
  const index = messageId.indexOf("::");
  if (index === -1) {
    // Pre-multi-account ids belong to whatever the single Gmail account was;
    // the caller resolves that.
    return { accountId: "", nativeId: messageId };
  }
  return {
    accountId: messageId.slice(0, index),
    nativeId: messageId.slice(index + 2),
  };
}

export function accountLabel(account: Account): string {
  return account.label.trim() !== ""
    ? account.label
    : (account.email ?? account.id);
}
