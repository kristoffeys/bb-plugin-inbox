// bb-plugin-inbox — read Gmail, draft a ticket with Claude, let the user edit
// it in a modal, then create it through the tracker plugin that already owns
// those credentials (see targets.ts).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildAuthUrl,
  exchangeCode,
  getAttachmentBytes,
  getMessage,
  getProfile,
  listMessageIds,
  refreshAccessToken,
  type ParsedMessage,
  type StoredTokens,
} from "./gmail";
import * as imap from "./imap";
import {
  accountLabel,
  accountSchema,
  composeMessageId,
  newAccountId,
  splitMessageId,
  type Account,
  type AccountSecrets,
  type ImapAccount,
} from "./accounts";
import { keepMessage, parseSenders } from "./filters";
import { draftTicket, type ProjectHint } from "./ai";
import {
  TARGETS,
  createTicket,
  listDestinations,
  targetOrThrow,
} from "./targets";

const INBOX_CHANGED = "inbox-changed";
const KV_TOKENS = "gmail-tokens";
const KV_PENDING_AUTH = "oauth-pending";
const KV_MESSAGES = "messages";
const KV_LINKS = "ticket-links";
const KV_DISMISSED = "dismissed";
const KV_JOBS = "draft-jobs";
const KV_ACCOUNTS = "accounts";
const secretsKey = (accountId: string) => `secrets:${accountId}`;

const attachmentSchema = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});
const messageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  account: z.string(),
  threadId: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
  body: z.string(),
  attachments: z.array(attachmentSchema),
  labelIds: z.array(z.string()),
});
const linkSchema = z.object({
  messageId: z.string(),
  target: z.string(),
  projectId: z.string(),
  ticketId: z.string(),
  url: z.string().nullable(),
  createdAt: z.string(),
});
export type TicketLink = z.infer<typeof linkSchema>;

const draftJobSchema = z.object({
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  state: z.enum(["queued", "drafting", "ready", "failed"]),
  draft: z
    .object({
      projectId: z.string(),
      confidence: z.enum(["high", "medium", "low", "none"]),
      reasoning: z.string(),
      title: z.string(),
      description: z.string(),
    })
    .nullable(),
  error: z.string().nullable(),
  queuedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DraftJob = z.infer<typeof draftJobSchema>;

const draftOutputSchema = z.object({
  projectId: z.string(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  reasoning: z.string(),
  title: z.string(),
  description: z.string(),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  configured: z.boolean(),
});

export const rpcContract = defineRpcContract({
  inbox_status: {
    input: z.null(),
    output: z.object({
      accounts: z.array(
        accountSchema.and(
          z.object({ connected: z.boolean(), error: z.string().nullable() }),
        ),
      ),
      credentialsConfigured: z.boolean(),
      aiReady: z.boolean(),
      redirectUri: z.string(),
      targets: z.array(z.object({ id: z.string(), label: z.string() })),
      senders: z.array(z.string()),
      lastSyncedAt: z.string().nullable(),
    }),
  },
  inbox_add_gmail: {
    input: z.object({ label: z.string().trim().default("") }),
    output: z.object({ accountId: z.string(), authUrl: z.string() }),
  },
  inbox_add_imap: {
    input: z.object({
      label: z.string().trim().default(""),
      host: z.string().trim().min(1),
      port: z.number().int().min(1).max(65535).default(993),
      secure: z.boolean().default(true),
      user: z.string().trim().min(1),
      password: z.string().min(1),
      mailbox: z.string().trim().default("INBOX"),
    }),
    output: z.object({ accountId: z.string(), messageCount: z.number() }),
  },
  inbox_remove_account: {
    input: z.object({ accountId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  inbox_auth_start: {
    input: z.object({ accountId: z.string() }),
    output: z.object({ authUrl: z.string() }),
  },
  inbox_set_senders: {
    input: z.object({ senders: z.array(z.string()) }),
    output: z.object({ senders: z.array(z.string()) }),
  },
  inbox_configure: {
    input: z.object({
      googleClientId: z.string().trim().min(1),
      googleClientSecret: z.string().trim().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  inbox_list: {
    input: z.object({
      refresh: z.boolean().default(false),
      includeDismissed: z.boolean().default(false),
    }),
    output: z.object({
      messages: z.array(messageSchema),
      links: z.array(linkSchema),
      dismissed: z.array(z.string()),
      dismissedCount: z.number(),
    }),
  },
  inbox_dismiss: {
    input: z.object({ messageId: z.string(), dismissed: z.boolean() }),
    output: z.object({ dismissed: z.array(z.string()) }),
  },
  inbox_projects: {
    input: z.object({ target: z.string() }),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  inbox_jobs: {
    input: z.null(),
    output: z.object({ jobs: z.array(draftJobSchema) }),
  },
  inbox_queue_draft: {
    input: z.object({ messageIds: z.array(z.string()).min(1) }),
    output: z.object({ jobs: z.array(draftJobSchema) }),
  },
  inbox_drop_job: {
    input: z.object({ messageId: z.string() }),
    output: z.object({ jobs: z.array(draftJobSchema) }),
  },
  inbox_destinations: {
    input: z.object({ target: z.string(), projectId: z.string() }),
    output: z.object({
      label: z.string(),
      destinations: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  },
  inbox_draft: {
    input: z.object({
      messageId: z.string(),
      instruction: z.string().optional(),
    }),
    output: draftOutputSchema,
  },
  inbox_create: {
    input: z.object({
      messageId: z.string(),
      target: z.string(),
      projectId: z.string().min(1),
      title: z.string().trim().min(1).max(300),
      description: z.string(),
      destinationId: z.string().nullable().default(null),
      attachmentIds: z.array(z.string()).default([]),
    }),
    output: linkSchema,
  },
});

export type InboxMessage = z.infer<typeof messageSchema>;
export type InboxDraft = z.infer<typeof draftOutputSchema>;
export type InboxProject = z.infer<typeof projectSchema>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    googleClientId: {
      type: "string",
      label: "Google OAuth client ID",
      description:
        "From a Google Cloud OAuth client (Desktop app). Register the redirect URI shown by `bb inbox connect`.",
      default: "",
    },
    googleClientSecret: {
      type: "string",
      label: "Google OAuth client secret",
      secret: true,
      default: "",
    },
    query: {
      type: "string",
      label: "Gmail fetch query",
      description:
        "Coarse server-side filter for Gmail mailboxes. Sender and invite rules are applied locally for every provider.",
      default: "in:inbox -category:promotions -category:social",
    },
    senders: {
      type: "string",
      label: "Only show mail from",
      description:
        "Comma-separated addresses or domains, e.g. ann@client.be, acme.com. Empty means everyone.",
      default: "",
    },
    excludeInvites: {
      type: "boolean",
      label: "Hide calendar invites",
      default: true,
    },
    maxMessages: {
      type: "number",
      label: "Messages to fetch",
      default: 25,
    },
    defaultTarget: {
      type: "string",
      label: "Default ticket target",
      description: Object.keys(TARGETS).join(", "),
      default: "productive",
    },
  });
  let config = await settings.get();
  settings.onChange((next, previous) => {
    config = next;
    // A narrower allowlist must not leave already-cached senders on screen.
    if (next.query !== previous.query || next.senders !== previous.senders) {
      void bb.storage.kv.delete(KV_MESSAGES).then(() => {
        bb.realtime.publish(INBOX_CHANGED, { reason: "query-changed" });
      });
    }
  });

  const redirectPath = `/api/v1/plugins/${bb.pluginId}/http/oauth/callback`;
  const redirectUri = () => `${bb.server.loopbackBaseUrl}${redirectPath}`;

  // ------------------------------------------------------------- accounts

  async function accounts(): Promise<Account[]> {
    return (await bb.storage.kv.get<Account[]>(KV_ACCOUNTS)) ?? [];
  }

  async function writeAccounts(next: Account[]): Promise<Account[]> {
    await bb.storage.kv.set(KV_ACCOUNTS, next);
    bb.realtime.publish(INBOX_CHANGED, { reason: "accounts" });
    return next;
  }

  async function accountOrThrow(accountId: string): Promise<Account> {
    const found = (await accounts()).find(
      (account) => account.id === accountId,
    );
    if (found === undefined) {
      throw new Error(`No mailbox with id ${accountId}.`);
    }
    return found;
  }

  async function secrets(accountId: string): Promise<AccountSecrets> {
    return (
      (await bb.storage.kv.get<AccountSecrets>(secretsKey(accountId))) ?? {}
    );
  }

  async function patchSecrets(
    accountId: string,
    patch: AccountSecrets,
  ): Promise<void> {
    await bb.storage.kv.set(secretsKey(accountId), {
      ...(await secrets(accountId)),
      ...patch,
    });
  }

  async function patchAccount(
    accountId: string,
    patch: Partial<Account>,
  ): Promise<void> {
    const current = await accounts();
    const index = current.findIndex((account) => account.id === accountId);
    if (index === -1) return;
    current[index] = { ...current[index]!, ...patch } as Account;
    await writeAccounts(current);
  }

  async function imapConnection(
    account: ImapAccount,
  ): Promise<imap.ImapConnection> {
    const { password } = await secrets(account.id);
    if (password === undefined) {
      throw new Error(
        `${accountLabel(account)} has no stored password. Remove and re-add the mailbox.`,
      );
    }
    return {
      host: account.host,
      port: account.port,
      secure: account.secure,
      user: account.user,
      password,
      mailbox: account.mailbox,
    };
  }

  /**
   * The single-mailbox layout stored one token blob at `gmail-tokens` and
   * un-namespaced message ids. Lift it into the first account so an existing
   * install keeps its Gmail connection without signing in again.
   */
  async function migrateSingleAccount(): Promise<void> {
    if ((await accounts()).length > 0) return;
    const legacy = await bb.storage.kv.get<StoredTokens>(KV_TOKENS);
    if (legacy === undefined || legacy === null) return;
    const account: Account = {
      id: newAccountId(),
      kind: "gmail",
      label: "",
      email: legacy.email,
    };
    await writeAccounts([account]);
    await patchSecrets(account.id, { tokens: legacy });
    await bb.storage.kv.delete(KV_TOKENS);
    // Cached mail and jobs carry old ids that no longer resolve to an account.
    await bb.storage.kv.delete(KV_MESSAGES);
    await bb.storage.kv.set(KV_JOBS, []);
    bb.log.info(`migrated legacy gmail mailbox to ${account.id}`);
  }

  await migrateSingleAccount();

  // ---------------------------------------------------------- gmail oauth

  function credentialsConfigured(): boolean {
    return config.googleClientId !== "" && config.googleClientSecret !== "";
  }

  /** A live access token for one Gmail account, refreshed when near expiry. */
  async function accessToken(accountId: string): Promise<string> {
    const { tokens } = await secrets(accountId);
    if (tokens === undefined) {
      throw new Error(
        "This Gmail mailbox is not connected yet. Finish the Google sign-in first.",
      );
    }
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    const refreshed = await refreshAccessToken({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      refreshToken: tokens.refreshToken,
    });
    await patchSecrets(accountId, { tokens: { ...tokens, ...refreshed } });
    return refreshed.accessToken;
  }

  const AUTH_STATE_TTL_MS = 10 * 60_000;

  /**
   * Idempotent per account: a live pending state is reused rather than
   * rotated, so a status refetch cannot invalidate a URL the user is already
   * looking at.
   */
  async function startAuth(accountId: string): Promise<string> {
    if (!credentialsConfigured()) {
      throw new Error(
        "Set the Google client id and secret first, on the Inbox page or with `bb plugin config inbox`.",
      );
    }
    const pending = await bb.storage.kv.get<{
      state: string;
      accountId: string;
      createdAt: number;
    }>(KV_PENDING_AUTH);
    const live =
      pending !== undefined &&
      pending !== null &&
      pending.accountId === accountId &&
      Date.now() - pending.createdAt < AUTH_STATE_TTL_MS;
    const state = live ? pending.state : randomUUID();
    if (!live) {
      await bb.storage.kv.set(KV_PENDING_AUTH, {
        state,
        accountId,
        createdAt: Date.now(),
      });
    }
    return buildAuthUrl({
      clientId: config.googleClientId,
      redirectUri: redirectUri(),
      state,
    });
  }

  async function addGmailAccount(label: string): Promise<{
    accountId: string;
    authUrl: string;
  }> {
    const account: Account = {
      id: newAccountId(),
      kind: "gmail",
      label,
      email: null,
    };
    await writeAccounts([...(await accounts()), account]);
    return { accountId: account.id, authUrl: await startAuth(account.id) };
  }

  async function addImapAccount(input: {
    label: string;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    mailbox: string;
  }): Promise<{ accountId: string; messageCount: number }> {
    // Verify before storing: a mailbox that never connected is worse than no
    // mailbox, because it shows up as a permanent error row.
    const messageCount = await imap.verify({
      host: input.host,
      port: input.port,
      secure: input.secure,
      user: input.user,
      password: input.password,
      mailbox: input.mailbox,
    });
    const account: Account = {
      id: newAccountId(),
      kind: "imap",
      label: input.label,
      email: input.user.includes("@") ? input.user : null,
      host: input.host,
      port: input.port,
      secure: input.secure,
      user: input.user,
      mailbox: input.mailbox,
    };
    await writeAccounts([...(await accounts()), account]);
    await patchSecrets(account.id, { password: input.password });
    return { accountId: account.id, messageCount };
  }

  async function removeAccount(accountId: string): Promise<boolean> {
    const current = await accounts();
    const next = current.filter((account) => account.id !== accountId);
    if (next.length === current.length) return false;
    await writeAccounts(next);
    await bb.storage.kv.delete(secretsKey(accountId));
    // Its cached mail, drafts and discards go with it; keeping them would
    // leave rows nothing can fetch.
    await bb.storage.kv.set(
      KV_MESSAGES,
      (await cachedMessages()).filter(
        (message) => message.accountId !== accountId,
      ),
    );
    await writeJobs(
      (await jobs()).filter(
        (job) => splitMessageId(job.messageId).accountId !== accountId,
      ),
    );
    bb.realtime.publish(INBOX_CHANGED, { reason: "account-removed" });
    return true;
  }

  async function isConnected(account: Account): Promise<boolean> {
    const stored = await secrets(account.id);
    return account.kind === "gmail"
      ? stored.tokens !== undefined
      : stored.password !== undefined;
  }

  // Google redirects the browser here; `auth: "none"` because the request
  // carries no BB origin. The `state` nonce is what authenticates it, and it
  // also says which mailbox the tokens belong to.
  bb.http.route(
    "GET",
    "/oauth/callback",
    async (context) => {
      const url = new URL(context.req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const pending = await bb.storage.kv.get<{
        state: string;
        accountId: string;
        createdAt: number;
      }>(KV_PENDING_AUTH);
      const page = (text: string, status: number) =>
        new Response(
          `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:2rem">${text}</body>`,
          { status, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (pending === undefined || pending === null || state !== pending.state) {
        return page("Unexpected OAuth state. Start again from BB.", 400);
      }
      if (Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
        return page("That sign-in link expired. Start again from BB.", 400);
      }
      if (code === null) {
        const error = url.searchParams.get("error") ?? "no code";
        return page(`Google refused the sign-in: ${error}`, 400);
      }
      try {
        const exchanged = await exchangeCode({
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          code,
          redirectUri: redirectUri(),
        });
        const email = await getProfile(exchanged.accessToken);
        await patchSecrets(pending.accountId, {
          tokens: { ...exchanged, email },
        });
        await patchAccount(pending.accountId, { email });
        await bb.storage.kv.delete(KV_PENDING_AUTH);
        bb.realtime.publish(INBOX_CHANGED, { reason: "connected" });
        bb.log.info(`gmail connected as ${email ?? "unknown"}`);
        return page(
          `Connected as <b>${email ?? "unknown"}</b>. You can close this tab.` +
            "<script>setTimeout(function(){window.close()},1200)</script>",
          200,
        );
      } catch (cause) {
        bb.log.error(`oauth exchange failed: ${String(cause)}`);
        return page(`Sign-in failed: ${String(cause)}`, 500);
      }
    },
    { auth: "none" },
  );

  // ---------------------------------------------------------------- inbox

  async function cachedMessages(): Promise<InboxMessage[]> {
    return (await bb.storage.kv.get<InboxMessage[]>(KV_MESSAGES)) ?? [];
  }
  async function links(): Promise<TicketLink[]> {
    return (await bb.storage.kv.get<TicketLink[]>(KV_LINKS)) ?? [];
  }

  /**
   * Discarded message ids. BB-local only: the Gmail scope is read-only, so a
   * discard hides the mail here and leaves the actual inbox untouched.
   */
  async function dismissed(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>(KV_DISMISSED)) ?? [];
  }

  async function setDismissed(
    messageId: string,
    isDismissed: boolean,
  ): Promise<string[]> {
    const current = await dismissed();
    const next = isDismissed
      ? [messageId, ...current.filter((id) => id !== messageId)].slice(0, 2000)
      : current.filter((id) => id !== messageId);
    await bb.storage.kv.set(KV_DISMISSED, next);
    bb.realtime.publish(INBOX_CHANGED, { reason: "dismissed" });
    return next;
  }

  async function visibleMessages(
    includeDismissed: boolean,
    refresh: boolean,
  ): Promise<{ messages: InboxMessage[]; dismissed: string[] }> {
    const all = refresh ? await syncInbox() : await cachedMessages();
    const hidden = await dismissed();
    return {
      messages: includeDismissed
        ? all
        : all.filter((message) => !hidden.includes(message.id)),
      dismissed: hidden,
    };
  }

  function decorate(
    account: Account,
    message: ParsedMessage,
  ): InboxMessage {
    return {
      ...message,
      id: composeMessageId(account.id, message.id),
      accountId: account.id,
      account: accountLabel(account),
    };
  }

  /** Every message one account currently offers, already provider-normalised. */
  async function fetchAccount(account: Account): Promise<ParsedMessage[]> {
    if (account.kind === "imap") {
      return await imap.listMessages(
        await imapConnection(account),
        config.maxMessages,
      );
    }
    const token = await accessToken(account.id);
    // Gmail's own query is a coarse fetch filter only; the allowlist and the
    // invite rule run locally in filters.ts for every provider.
    const ids = await listMessageIds(token, config.query, config.maxMessages);
    const messages: ParsedMessage[] = [];
    for (const id of ids) messages.push(await getMessage(token, id));
    return messages;
  }

  async function syncInbox(): Promise<InboxMessage[]> {
    const options = {
      senders: parseSenders(config.senders),
      excludeInvites: config.excludeInvites,
    };
    const collected: InboxMessage[] = [];
    const failures: string[] = [];
    for (const account of await accounts()) {
      if (!(await isConnected(account))) continue;
      try {
        for (const message of await fetchAccount(account)) {
          if (keepMessage(message, options)) {
            collected.push(decorate(account, message));
          }
        }
      } catch (cause) {
        // One unreachable mailbox must not blank the others.
        failures.push(`${accountLabel(account)}: ${String(cause)}`);
        bb.log.warn(`sync failed for ${account.id}: ${String(cause)}`);
        collected.push(
          ...(await cachedMessages()).filter(
            (message) => message.accountId === account.id,
          ),
        );
      }
    }
    collected.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    await bb.storage.kv.set(KV_MESSAGES, collected);
    await bb.storage.kv.set("last-synced-at", new Date().toISOString());
    await bb.storage.kv.set("last-sync-errors", failures);
    bb.realtime.publish(INBOX_CHANGED, { count: collected.length });
    return collected;
  }

  async function messageOrThrow(messageId: string): Promise<InboxMessage> {
    const found = (await cachedMessages()).find(
      (message) => message.id === messageId,
    );
    if (found !== undefined) return found;
    const { accountId, nativeId } = splitMessageId(messageId);
    const account = await accountOrThrow(accountId);
    const fresh =
      account.kind === "imap"
        ? await imap.getMessage(await imapConnection(account), nativeId)
        : await getMessage(await accessToken(account.id), nativeId);
    return decorate(account, fresh);
  }

  async function attachmentBytes(
    message: InboxMessage,
    attachmentId: string,
  ): Promise<Buffer> {
    const { nativeId } = splitMessageId(message.id);
    const account = await accountOrThrow(message.accountId);
    return account.kind === "imap"
      ? await imap.getAttachmentBytes(
          await imapConnection(account),
          nativeId,
          attachmentId,
        )
      : await getAttachmentBytes(
          await accessToken(account.id),
          nativeId,
          attachmentId,
        );
  }

  async function projectHints(): Promise<ProjectHint[]> {
    const projects = await bb.sdk.projects.list();
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      hints: [
        project.gitRemoteUrl ?? "",
        ...("sources" in project && Array.isArray(project.sources)
          ? project.sources.map((source) =>
              typeof source === "object" && source !== null && "path" in source
                ? String((source as { path?: unknown }).path ?? "")
                : "",
            )
          : []),
      ].filter((hint) => hint !== ""),
    }));
  }

  /**
   * Where the throwaway drafting thread runs. Any project works — the draft
   * never touches a workspace — so prefer the personal one and fall back to
   * whatever exists.
   */
  async function draftHostProject(): Promise<string> {
    const projects = await bb.sdk.projects.list();
    const personal =
      projects.find((project) => project.kind === "personal") ?? projects[0];
    if (personal === undefined) {
      throw new Error("Drafting needs at least one bb project to run in.");
    }
    return personal.id;
  }

  async function draft(
    messageId: string,
    instruction?: string,
  ): Promise<InboxDraft> {
    return await draftTicket({
      bb,
      projectId: await draftHostProject(),
      message: await messageOrThrow(messageId),
      projects: await projectHints(),
      instruction,
    });
  }

  // ------------------------------------------------------- draft queue

  async function jobs(): Promise<DraftJob[]> {
    return (await bb.storage.kv.get<DraftJob[]>(KV_JOBS)) ?? [];
  }

  async function writeJobs(next: DraftJob[]): Promise<DraftJob[]> {
    const capped = next.slice(0, 200);
    await bb.storage.kv.set(KV_JOBS, capped);
    bb.realtime.publish(INBOX_CHANGED, { reason: "jobs" });
    return capped;
  }

  async function patchJob(
    messageId: string,
    patch: Partial<DraftJob>,
  ): Promise<void> {
    const current = await jobs();
    const index = current.findIndex((job) => job.messageId === messageId);
    if (index === -1) return;
    current[index] = { ...current[index]!, ...patch };
    await writeJobs(current);
  }

  async function queueDrafts(messageIds: string[]): Promise<DraftJob[]> {
    const current = await jobs();
    const queued = new Set(current.map((job) => job.messageId));
    const added: DraftJob[] = [];
    for (const messageId of messageIds) {
      if (queued.has(messageId)) continue;
      const message = await messageOrThrow(messageId);
      added.push({
        messageId,
        subject: message.subject,
        from: message.from,
        state: "queued",
        draft: null,
        error: null,
        queuedAt: new Date().toISOString(),
        finishedAt: null,
      });
    }
    return await writeJobs([...current, ...added]);
  }

  /** Sleep that wakes on shutdown; a plain timer would stall a reload. */
  function nap(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  // One draft at a time: each one spawns a real agent thread, and running the
  // whole inbox in parallel would flood the provider for no gain in wall time.
  bb.background.service("draft-queue", {
    async start(signal) {
      // A job left mid-flight by a reload or crash is owned by nobody.
      const stranded = await jobs();
      if (stranded.some((job) => job.state === "drafting")) {
        await writeJobs(
          stranded.map((job) =>
            job.state === "drafting" ? { ...job, state: "queued" } : job,
          ),
        );
      }

      while (!signal.aborted) {
        const next = (await jobs()).find((job) => job.state === "queued");
        if (next === undefined) {
          await nap(3_000, signal);
          continue;
        }
        await patchJob(next.messageId, { state: "drafting" });
        try {
          const drafted = await draft(next.messageId);
          if (signal.aborted) return;
          await patchJob(next.messageId, {
            state: "ready",
            draft: drafted,
            error: null,
            finishedAt: new Date().toISOString(),
          });
        } catch (cause) {
          if (signal.aborted) return;
          bb.log.warn(`draft failed for ${next.messageId}: ${String(cause)}`);
          await patchJob(next.messageId, {
            state: "failed",
            error: String(cause),
            finishedAt: new Date().toISOString(),
          });
        }
      }
    },
  });

  /**
   * Stage the chosen attachments as real files so the tracker plugin's CLI can
   * upload them, then delete them whatever happens.
   */
  async function withStagedAttachments<T>(
    message: InboxMessage,
    attachmentIds: string[],
    body: (paths: string[]) => Promise<T>,
  ): Promise<T> {
    const wanted = message.attachments.filter((file) =>
      attachmentIds.includes(file.attachmentId),
    );
    if (wanted.length === 0) return await body([]);
    const directory = await mkdtemp(join(tmpdir(), "bb-inbox-"));
    try {
      const paths: string[] = [];
      for (const file of wanted) {
        const bytes = await attachmentBytes(message, file.attachmentId);
        // Basename only: a Gmail filename is remote input, never a path.
        const safe =
          file.filename.replace(/[/\\]/g, "_").replace(/^\.+/, "") ||
          `attachment-${paths.length + 1}`;
        const path = join(directory, safe);
        await writeFile(path, bytes);
        paths.push(path);
      }
      return await body(paths);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function create(
    input: z.infer<(typeof rpcContract)["inbox_create"]["input"]>,
  ): Promise<TicketLink> {
    const target = targetOrThrow(input.target);
    const message = await messageOrThrow(input.messageId);
    const created = await withStagedAttachments(
      message,
      input.attachmentIds,
      (paths) =>
        createTicket(bb.server.loopbackBaseUrl, target, {
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          destinationId: input.destinationId,
          attachments: paths,
        }),
    );
    const link: TicketLink = {
      messageId: input.messageId,
      target: target.id,
      projectId: input.projectId,
      ticketId: created.id,
      url: created.url,
      createdAt: new Date().toISOString(),
    };
    const existing = (await links()).filter(
      (entry) =>
        !(entry.messageId === link.messageId && entry.target === link.target),
    );
    await bb.storage.kv.set(KV_LINKS, [link, ...existing].slice(0, 500));
    // A ticketed mail is handled: drop it from the list the same way a manual
    // discard would, so the inbox only ever shows what still needs a decision.
    await setDismissed(input.messageId, true);
    await writeJobs(
      (await jobs()).filter((job) => job.messageId !== input.messageId),
    );
    bb.realtime.publish(INBOX_CHANGED, { reason: "created" });
    bb.log.info(`ticket created: ${target.id} ${link.ticketId}`);
    return link;
  }

  /**
   * Only projects this tracker is actually linked to. An unlinked project can
   * never receive a ticket, so offering it is offering a guaranteed failure.
   */
  async function projectsFor(targetId: string): Promise<InboxProject[]> {
    const target = targetOrThrow(targetId);
    const projects = await bb.sdk.projects.list();
    const { configuredProjects } = await import("./targets");
    const checked = await configuredProjects(
      bb.server.loopbackBaseUrl,
      target,
      projects.map((project) => ({ id: project.id, name: project.name })),
    );
    return checked.filter((project) => project.configured);
  }

  // ------------------------------------------------------------------ rpc

  bb.rpc.register(rpcContract, {
    inbox_status: async () => {
      const list = await accounts();
      const errors =
        (await bb.storage.kv.get<string[]>("last-sync-errors")) ?? [];
      return {
        accounts: await Promise.all(
          list.map(async (account) => ({
            ...account,
            connected: await isConnected(account),
            error:
              errors.find((entry) =>
                entry.startsWith(`${accountLabel(account)}: `),
              ) ?? null,
          })),
        ),
        credentialsConfigured: credentialsConfigured(),
        aiReady: (await bb.sdk.projects.list()).length > 0,
        redirectUri: redirectUri(),
        targets: Object.values(TARGETS).map((target) => ({
          id: target.id,
          label: target.label,
        })),
        senders: parseSenders(config.senders),
        lastSyncedAt:
          (await bb.storage.kv.get<string>("last-synced-at")) ?? null,
      };
    },
    inbox_add_gmail: ({ label }) => addGmailAccount(label),
    inbox_add_imap: (input) => addImapAccount(input),
    inbox_remove_account: async ({ accountId }) => ({
      removed: await removeAccount(accountId),
    }),
    inbox_auth_start: async ({ accountId }) => ({
      authUrl: await startAuth(accountId),
    }),
    inbox_set_senders: async ({ senders }) => {
      // Normalise on the way in so the stored value and what the UI shows can
      // never disagree.
      const cleaned = parseSenders(senders.join(","));
      await settings.experimental_set({ senders: cleaned.join(", ") });
      config = await settings.get();
      await bb.storage.kv.delete(KV_MESSAGES);
      bb.realtime.publish(INBOX_CHANGED, { reason: "senders-changed" });
      return { senders: cleaned };
    },
    inbox_configure: async ({ googleClientId, googleClientSecret }) => {
      await settings.experimental_set({ googleClientId, googleClientSecret });
      config = await settings.get();
      return { ok: true };
    },
    inbox_list: async ({ refresh, includeDismissed }) => {
      const visible = await visibleMessages(includeDismissed, refresh);
      return {
        messages: visible.messages,
        links: await links(),
        dismissed: visible.dismissed,
        dismissedCount: (await cachedMessages()).filter((message) =>
          visible.dismissed.includes(message.id),
        ).length,
      };
    },
    inbox_dismiss: async ({ messageId, dismissed: isDismissed }) => ({
      dismissed: await setDismissed(messageId, isDismissed),
    }),
    inbox_projects: async ({ target }) => ({
      projects: await projectsFor(target),
    }),
    inbox_destinations: async ({ target, projectId }) => {
      const definition = targetOrThrow(target);
      return {
        label: definition.destinationLabel,
        destinations:
          projectId === ""
            ? []
            : await listDestinations(
                bb.server.loopbackBaseUrl,
                definition,
                projectId,
              ),
      };
    },
    inbox_jobs: async () => ({ jobs: await jobs() }),
    inbox_queue_draft: async ({ messageIds }) => ({
      jobs: await queueDrafts(messageIds),
    }),
    inbox_drop_job: async ({ messageId }) => ({
      jobs: await writeJobs(
        (await jobs()).filter((job) => job.messageId !== messageId),
      ),
    }),
    inbox_draft: ({ messageId, instruction }) => draft(messageId, instruction),
    inbox_create: (input) => create(input),
  });

  // ------------------------------------------------------------------ cli

  const usage = [
    "Usage:",
    "  bb inbox accounts [--json]                  List mailboxes",
    "  bb inbox connect [--label <text>] [--account <id>] [--json]",
    "                                              Add/reconnect a Gmail mailbox",
    "  bb inbox add-imap --host <h> --user <u> --password <p>",
    "                    [--port 993] [--insecure] [--mailbox INBOX] [--label <text>] [--json]",
    "  bb inbox remove-account <account-id> [--json]",
    "  bb inbox status [--json]               Mailboxes and configuration state",
    "  bb inbox list [--refresh] [--all] [--json]   List messages from every mailbox",
    "  bb inbox discard <message-id> [--json]      Hide a message from the list",
    "  bb inbox restore <message-id> [--json]      Put a discarded message back",
    "  bb inbox show <message-id> [--json]    Full message body and attachments",
    "  bb inbox draft <message-id> [--instruction <text>] [--queue] [--json]",
    "  bb inbox drafts [--json]                    Show the background draft queue",
    "  bb inbox create <message-id> --project <proj_id> [--target <id>]",
    "                  [--title <text>] [--description <text>] [--list <id>]",
    "                  [--attach-all] [--json]",
    "",
    "Message ids are <account-id>::<provider-id>, so they stay unique across",
    "mailboxes. `create` without --title drafts one first. The BB Inbox page",
    "shows the same draft in an editable modal before anything is created.",
  ].join("\n");

  function flag(argv: string[], name: string): string | null {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return null;
    return argv[index + 1] ?? null;
  }

  bb.cli.register({
    name: "inbox",
    summary: "Read Gmail and turn a message into a tracker ticket",
    commands: [
      {
        name: "accounts",
        summary: "List connected mailboxes",
        usage: "bb inbox accounts [--json]",
      },
      {
        name: "connect",
        summary: "Add a Gmail mailbox, or reconnect one, via Google sign-in",
        usage: "bb inbox connect [--label <text>] [--account <id>] [--json]",
      },
      {
        name: "add-imap",
        summary: "Add an IMAP mailbox",
        usage:
          "bb inbox add-imap --host <h> --user <u> --password <p> [--port 993] [--insecure] [--mailbox INBOX] [--label <text>] [--json]",
      },
      {
        name: "remove-account",
        summary: "Remove a mailbox and everything cached for it",
        usage: "bb inbox remove-account <account-id> [--json]",
      },
      {
        name: "status",
        summary: "Mailboxes and configuration state",
        usage: "bb inbox status [--json]",
      },
      {
        name: "list",
        summary: "List inbox messages",
        usage: "bb inbox list [--refresh] [--all] [--json]",
      },
      {
        name: "discard",
        summary: "Hide a message from the inbox list (BB-local, Gmail untouched)",
        usage: "bb inbox discard <message-id> [--json]",
      },
      {
        name: "restore",
        summary: "Put a discarded message back in the list",
        usage: "bb inbox restore <message-id> [--json]",
      },
      {
        name: "show",
        summary: "Show one message in full",
        usage: "bb inbox show <message-id> [--json]",
      },
      {
        name: "draft",
        summary: "AI-draft a ticket from a message without creating it",
        usage:
          "bb inbox draft <message-id> [--instruction <text>] [--queue] [--json]",
      },
      {
        name: "drafts",
        summary: "Show the background draft queue and what is waiting for approval",
        usage: "bb inbox drafts [--json]",
      },
      {
        name: "create",
        summary: "Create a ticket from a message",
        usage:
          "bb inbox create <message-id> --project <proj_id> [--target <id>] [--title <text>] [--description <text>] [--list <id>] [--attach-all] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const [command, ...args] = argv;
      const messageId = args[0];
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "accounts": {
            const list = await accounts();
            const rows = await Promise.all(
              list.map(async (account) => ({
                ...account,
                connected: await isConnected(account),
              })),
            );
            return reply(
              rows,
              rows.length === 0
                ? "No mailboxes. Add one with `bb inbox connect` or `bb inbox add-imap`."
                : rows
                    .map(
                      (row) =>
                        `${row.connected ? "*" : " "} ${row.id}  ${row.kind.padEnd(5)}  ${accountLabel(row)}`,
                    )
                    .join("\n"),
            );
          }

          case "connect": {
            const existing = flag(args, "account");
            const target =
              existing === null
                ? await addGmailAccount(flag(args, "label") ?? "")
                : {
                    accountId: existing,
                    authUrl: await startAuth(existing),
                  };
            return reply(
              { ...target, redirectUri: redirectUri() },
              [
                "1. Register this redirect URI on your Google OAuth client:",
                `   ${redirectUri()}`,
                `2. Open this URL and grant access (mailbox ${target.accountId}):`,
                `   ${target.authUrl}`,
              ].join("\n"),
            );
          }

          case "add-imap": {
            const host = flag(args, "host");
            const user = flag(args, "user");
            const password = flag(args, "password");
            if (host === null || user === null || password === null) {
              return {
                exitCode: 1,
                stderr:
                  "add-imap needs --host, --user and --password (use an app password where the provider requires one).",
              };
            }
            const port = Number(flag(args, "port") ?? "993");
            const added = await addImapAccount({
              label: flag(args, "label") ?? "",
              host,
              port: Number.isFinite(port) ? port : 993,
              secure: flag(args, "insecure") === null,
              user,
              password,
              mailbox: flag(args, "mailbox") ?? "INBOX",
            });
            return reply(
              added,
              `Added ${added.accountId} (${added.messageCount} messages in the mailbox).`,
            );
          }

          case "remove-account": {
            const accountId = args[0];
            if (accountId === undefined) break;
            const removed = await removeAccount(accountId);
            return removed
              ? reply({ removed, accountId }, `Removed ${accountId}.`)
              : { exitCode: 1, stderr: `No mailbox with id ${accountId}.` };
          }

          case "status": {
            const list = await accounts();
            const rows = await Promise.all(
              list.map(async (account) => ({
                id: account.id,
                kind: account.kind,
                label: accountLabel(account),
                connected: await isConnected(account),
              })),
            );
            const state = {
              accounts: rows,
              credentialsConfigured: credentialsConfigured(),
              aiReady: true,
              gmailQuery: config.query,
              senders: parseSenders(config.senders),
              excludeInvites: config.excludeInvites,
              defaultTarget: config.defaultTarget,
            };
            return reply(
              state,
              [
                rows.length === 0
                  ? "Mailboxes: none"
                  : `Mailboxes: ${rows
                      .map(
                        (row) =>
                          `${row.label} (${row.kind}${row.connected ? "" : ", not connected"})`,
                      )
                      .join(", ")}`,
                `OAuth:     ${state.credentialsConfigured ? "configured" : "missing client id/secret"}`,
                "Drafting:  uses this bb's configured provider",
                `Gmail q:   ${state.gmailQuery}`,
                `Senders:   ${state.senders.join(", ") || "(everyone)"}`,
                `Invites:   ${state.excludeInvites ? "hidden" : "shown"}`,
                `Target:    ${state.defaultTarget}`,
              ].join("\n"),
            );
          }

          case "list": {
            const visible = await visibleMessages(
              argv.includes("--all"),
              argv.includes("--refresh"),
            );
            const linked = new Set((await links()).map((l) => l.messageId));
            const mark = (message: InboxMessage) =>
              visible.dismissed.includes(message.id)
                ? "-"
                : linked.has(message.id)
                  ? "*"
                  : " ";
            return reply(
              visible.messages,
              visible.messages.length === 0
                ? "No messages. Run `bb inbox list --refresh`."
                : visible.messages
                    .map(
                      (message) =>
                        `${mark(message)} ${message.id}  ${message.from.slice(0, 32).padEnd(32)}  ${message.subject}`,
                    )
                    .join("\n"),
            );
          }

          case "discard":
          case "restore": {
            if (messageId === undefined) break;
            const isDiscard = command === "discard";
            const next = await setDismissed(messageId, isDiscard);
            return reply(
              { messageId, dismissed: isDiscard, count: next.length },
              `${isDiscard ? "Discarded" : "Restored"} ${messageId}.`,
            );
          }
          case "show": {
            if (messageId === undefined) break;
            const message = await messageOrThrow(messageId);
            return reply(
              message,
              [
                `From:    ${message.from}`,
                `Subject: ${message.subject}`,
                `Date:    ${message.date}`,
                `Files:   ${message.attachments.map((f) => f.filename).join(", ") || "(none)"}`,
                "",
                message.body,
              ].join("\n"),
            );
          }
          case "drafts": {
            const all = await jobs();
            return reply(
              all,
              all.length === 0
                ? "Nothing queued. Queue one with `bb inbox draft <id> --queue`."
                : all
                    .map(
                      (job) =>
                        `${job.state.padEnd(8)} ${job.messageId}  ${job.draft?.title ?? job.error ?? job.subject}`,
                    )
                    .join("\n"),
            );
          }

          case "draft": {
            if (messageId === undefined) break;
            if (argv.includes("--queue")) {
              const queued = await queueDrafts([messageId]);
              return reply(
                queued,
                `Queued ${messageId}. Watch it with \`bb inbox drafts\`.`,
              );
            }
            const drafted = await draft(
              messageId,
              flag(args, "instruction") ?? undefined,
            );
            return reply(
              drafted,
              [
                `Project:    ${drafted.projectId || "(no match)"} (${drafted.confidence}) — ${drafted.reasoning}`,
                `Title:      ${drafted.title}`,
                "",
                drafted.description,
              ].join("\n"),
            );
          }
          case "create": {
            if (messageId === undefined) break;
            const projectFlag = flag(args, "project");
            const titleFlag = flag(args, "title");
            const drafted =
              titleFlag === null
                ? await draft(messageId, flag(args, "instruction") ?? undefined)
                : null;
            const projectId = projectFlag ?? drafted?.projectId ?? "";
            if (projectId === "") {
              return {
                exitCode: 1,
                stderr:
                  "No project. Pass --project <proj_id>; the draft could not match one.",
              };
            }
            const message = await messageOrThrow(messageId);
            const link = await create({
              messageId,
              target: flag(args, "target") ?? config.defaultTarget,
              projectId,
              title: titleFlag ?? drafted?.title ?? message.subject,
              description: flag(args, "description") ?? drafted?.description ?? "",
              destinationId: flag(args, "list"),
              attachmentIds: argv.includes("--attach-all")
                ? message.attachments.map((file) => file.attachmentId)
                : [],
            });
            return reply(
              link,
              `Created ${link.target} ${link.ticketId}${link.url === null ? "" : ` — ${link.url}`}`,
            );
          }
        }
        return { exitCode: 1, stderr: usage };
      } catch (cause) {
        return { exitCode: 1, stderr: String(cause) };
      }
    },
  });

  bb.agents.registerTool({
    name: "inbox_draft_ticket",
    description:
      "Draft a tracker ticket from a Gmail message in the user's BB inbox, including the best-matching bb project. Does not create anything.",
    instructions:
      "Use inbox_draft_ticket when the user wants a ticket made from an email. Show the draft and let them confirm before running `bb inbox create`.",
    parameters: z.object({
      messageId: z
        .string()
        .min(1)
        .describe("Gmail message id, from `bb inbox list`"),
      instruction: z
        .string()
        .optional()
        .describe("extra steer for the draft, e.g. 'file this as a bug'"),
    }),
    async execute({ messageId, instruction }) {
      const drafted = await draft(messageId, instruction);
      return JSON.stringify(drafted, null, 2);
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
