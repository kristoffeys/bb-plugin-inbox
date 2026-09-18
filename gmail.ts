// Gmail API client: OAuth token handling, message listing, parsing, attachments.
// No SDK dependency here on purpose — everything is plain fetch, so this file
// is testable without a running BB server.

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Read-only is enough to list, read and download attachments. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type StoredTokens = {
  refreshToken: string;
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
  email: string | null;
};

export type Attachment = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type ParsedMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  /** Plain-text body, HTML stripped when that is all Gmail returned. */
  body: string;
  attachments: Attachment[];
  labelIds: string[];
};

export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(OAUTH_AUTH);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", args.state);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const response = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token endpoint ${response.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

export async function exchangeCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const result = await tokenRequest({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
  if (result.refresh_token === undefined) {
    throw new Error(
      "Google returned no refresh token. Revoke the app at myaccount.google.com/permissions and connect again.",
    );
  }
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

export async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const result = await tokenRequest({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  });
  return {
    accessToken: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

async function api<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gmail ${path} ${response.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export async function getProfile(accessToken: string): Promise<string | null> {
  const profile = await api<{ emailAddress?: string }>(accessToken, "/profile");
  return profile.emailAddress ?? null;
}

export async function listMessageIds(
  accessToken: string,
  query: string,
  max: number,
): Promise<string[]> {
  const search = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(max, 100)),
  });
  const page = await api<{ messages?: { id: string }[] }>(
    accessToken,
    `/messages?${search.toString()}`,
  );
  return (page.messages ?? []).map((message) => message.id);
}

type RawPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: RawPart[];
};
type RawMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: RawPart;
};

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Good enough for turning a marketing-grade HTML mail into readable text. */
export function htmlToText(html: string): string {
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
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function header(payload: RawPart | undefined, name: string): string {
  const match = payload?.headers?.find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase(),
  );
  return match?.value ?? "";
}

function walk(
  part: RawPart | undefined,
  found: { text: string[]; html: string[]; attachments: Attachment[] },
): void {
  if (part === undefined) return;
  const mime = part.mimeType ?? "";
  const attachmentId = part.body?.attachmentId;
  const filename = part.filename ?? "";
  if (attachmentId !== undefined && filename !== "") {
    found.attachments.push({
      attachmentId,
      filename,
      mimeType: mime || "application/octet-stream",
      size: part.body?.size ?? 0,
    });
  } else if (part.body?.data !== undefined) {
    const decoded = decodeBase64Url(part.body.data).toString("utf8");
    if (mime === "text/plain") found.text.push(decoded);
    else if (mime === "text/html") found.html.push(decoded);
  }
  for (const child of part.parts ?? []) walk(child, found);
}

export function parseMessage(raw: RawMessage, bodyLimit = 20_000): ParsedMessage {
  const found = { text: [] as string[], html: [] as string[], attachments: [] as Attachment[] };
  walk(raw.payload, found);
  const body =
    found.text.length > 0
      ? found.text.join("\n").trim()
      : htmlToText(found.html.join("\n"));
  const internal = raw.internalDate;
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: header(raw.payload, "From"),
    to: header(raw.payload, "To"),
    subject: header(raw.payload, "Subject") || "(no subject)",
    date:
      header(raw.payload, "Date") ||
      (internal === undefined ? "" : new Date(Number(internal)).toISOString()),
    snippet: raw.snippet ?? "",
    body: body.slice(0, bodyLimit),
    attachments: found.attachments,
    labelIds: raw.labelIds ?? [],
  };
}

export async function getMessage(
  accessToken: string,
  id: string,
): Promise<ParsedMessage> {
  const raw = await api<RawMessage>(accessToken, `/messages/${id}?format=full`);
  return parseMessage(raw);
}

export async function getAttachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const part = await api<{ data?: string }>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  if (part.data === undefined) throw new Error("Attachment had no data");
  return decodeBase64Url(part.data);
}
