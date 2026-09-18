// IMAP mailbox reader. Same shape as gmail.ts so server.ts can treat both the
// same: list recent messages, parse them, pull one attachment's bytes.
//
// Read-only throughout: every connection opens the mailbox with `readOnly`, so
// nothing here can mark, move or delete mail.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment, ParsedMessage } from "./gmail";

export type ImapConnection = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
};

async function withClient<T>(
  connection: ImapConnection,
  body: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: connection.host,
    port: connection.port,
    secure: connection.secure,
    auth: { user: connection.user, pass: connection.password },
    logger: false,
  });
  await client.connect();
  try {
    return await body(client);
  } finally {
    // logout() can reject on a half-dead socket; the work is already done.
    await client.logout().catch(() => client.close());
  }
}

async function parseSource(
  uid: number,
  source: Buffer,
  bodyLimit: number,
): Promise<ParsedMessage> {
  const mail = await simpleParser(source);
  const attachments: Attachment[] = mail.attachments.map((file, index) => ({
    // IMAP has no attachment id, so the part index is the handle. Stable for
    // as long as the message is, which is all this needs to be.
    attachmentId: String(index),
    filename: file.filename ?? `attachment-${index + 1}`,
    mimeType: file.contentType || "application/octet-stream",
    size: file.size ?? file.content.length,
  }));
  const text =
    mail.text ?? (mail.html === false ? "" : stripHtml(mail.html ?? ""));
  return {
    id: String(uid),
    threadId: mail.messageId ?? String(uid),
    from: mail.from?.text ?? "",
    to: Array.isArray(mail.to)
      ? mail.to.map((entry) => entry.text).join(", ")
      : (mail.to?.text ?? ""),
    subject: mail.subject ?? "(no subject)",
    date: (mail.date ?? new Date()).toISOString(),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    body: text.slice(0, bodyLimit),
    attachments,
    labelIds: [],
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The newest `limit` messages in the mailbox, newest first. */
export async function listMessages(
  connection: ImapConnection,
  limit: number,
  bodyLimit = 20_000,
): Promise<ParsedMessage[]> {
  return await withClient(connection, async (client) => {
    const lock = await client.getMailboxLock(connection.mailbox, {
      readOnly: true,
    });
    try {
      const total =
        typeof client.mailbox === "object" ? client.mailbox.exists : 0;
      if (total === 0) return [];
      const first = Math.max(1, total - limit + 1);
      const messages: ParsedMessage[] = [];
      for await (const message of client.fetch(
        `${first}:${total}`,
        { uid: true, source: true },
        { uid: false },
      )) {
        if (message.source === undefined) continue;
        messages.push(await parseSource(message.uid, message.source, bodyLimit));
      }
      return messages.reverse();
    } finally {
      lock.release();
    }
  });
}

export async function getMessage(
  connection: ImapConnection,
  uid: string,
  bodyLimit = 20_000,
): Promise<ParsedMessage> {
  return await withClient(connection, async (client) => {
    const lock = await client.getMailboxLock(connection.mailbox, {
      readOnly: true,
    });
    try {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      const source = message === false ? undefined : message?.source;
      if (source === undefined) {
        throw new Error(`No message with uid ${uid} in ${connection.mailbox}`);
      }
      return await parseSource(Number(uid), source, bodyLimit);
    } finally {
      lock.release();
    }
  });
}

export async function getAttachmentBytes(
  connection: ImapConnection,
  uid: string,
  attachmentIndex: string,
): Promise<Buffer> {
  return await withClient(connection, async (client) => {
    const lock = await client.getMailboxLock(connection.mailbox, {
      readOnly: true,
    });
    try {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      const source = message === false ? undefined : message?.source;
      if (source === undefined) {
        throw new Error(`No message with uid ${uid}`);
      }
      const mail = await simpleParser(source);
      const file = mail.attachments[Number(attachmentIndex)];
      if (file === undefined) {
        throw new Error(`No attachment ${attachmentIndex} on uid ${uid}`);
      }
      return file.content;
    } finally {
      lock.release();
    }
  });
}

/** Connect, open the mailbox, disconnect — used to validate new credentials. */
export async function verify(connection: ImapConnection): Promise<number> {
  return await withClient(connection, async (client) => {
    const lock = await client.getMailboxLock(connection.mailbox, {
      readOnly: true,
    });
    try {
      return typeof client.mailbox === "object" ? client.mailbox.exists : 0;
    } finally {
      lock.release();
    }
  });
}
