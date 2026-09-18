// bb-plugin-inbox — Inbox page: pick a message, review the AI draft in the
// save modal, then create the ticket. Nothing is created without the modal.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  DraftJob,
  InboxDraft,
  InboxMessage,
  InboxProject,
  TicketLink,
  rpcContract,
} from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type MailboxAccount = {
  id: string;
  kind: "gmail" | "imap";
  label: string;
  email: string | null;
  connected: boolean;
  error: string | null;
  host?: string;
  user?: string;
  mailbox?: string;
};

type Status = {
  accounts: MailboxAccount[];
  credentialsConfigured: boolean;
  aiReady: boolean;
  redirectUri: string;
  targets: { id: string; label: string }[];
  senders: string[];
  lastSyncedAt: string | null;
};

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*</.exec(from);
  return (match?.[1] ?? from).trim() || from;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** Everything the modal edits. Seeded from the AI draft, then fully the user's. */
type TicketForm = {
  target: string;
  projectId: string;
  destinationId: string;
  title: string;
  description: string;
  attachmentIds: string[];
};

function SaveTicketDialog({
  message,
  status,
  seed,
  onClose,
  onCreated,
}: {
  message: InboxMessage;
  status: Status;
  /** A draft the background queue already produced; skips the wait. */
  seed: InboxDraft | null;
  onClose: () => void;
  onCreated: (link: TicketLink) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<TicketForm>({
    target: status.targets[0]?.id ?? "productive",
    projectId: seed?.projectId ?? "",
    destinationId: "",
    title: seed?.title ?? message.subject,
    description: seed?.description ?? "",
    attachmentIds: message.attachments.map((file) => file.attachmentId),
  });
  const [draft, setDraft] = useState<InboxDraft | null>(seed);
  const [projects, setProjects] = useState<InboxProject[] | null>(null);
  const [destinations, setDestinations] = useState<
    { id: string; name: string; isDefault: boolean }[]
  >([]);
  const [destinationLabel, setDestinationLabel] = useState("Task list");
  const [drafting, setDrafting] = useState(seed === null && status.aiReady);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (next: Partial<TicketForm>) =>
    setForm((current) => ({ ...current, ...next }));

  useEffect(() => {
    let live = true;
    rpc.call("inbox_projects", { target: form.target }).then(
      (result) => live && setProjects(result.projects),
      (cause) => live && setError(String(cause)),
    );
    return () => {
      live = false;
    };
  }, [rpc, form.target]);

  useEffect(() => {
    let live = true;
    if (form.projectId === "") {
      setDestinations([]);
      return;
    }
    rpc
      .call("inbox_destinations", {
        target: form.target,
        projectId: form.projectId,
      })
      .then((result) => {
        if (!live) return;
        setDestinationLabel(result.label);
        setDestinations(result.destinations);
        // Preselect the tracker's own default so the field is never a blank
        // that the tracker then rejects.
        setForm((current) =>
          current.destinationId === ""
            ? {
                ...current,
                destinationId:
                  result.destinations.find((entry) => entry.isDefault)?.id ??
                  result.destinations[0]?.id ??
                  "",
              }
            : current,
        );
      }, () => live && setDestinations([]));
    return () => {
      live = false;
    };
  }, [rpc, form.target, form.projectId]);

  const runDraft = useCallback(
    (instruction?: string) => {
      if (!status.aiReady) return;
      setDrafting(true);
      setError(null);
      rpc
        // The key is omitted, never sent as undefined: the RPC client rejects
        // undefined as a non-JSON value before the request leaves the page.
        .call("inbox_draft", {
          messageId: message.id,
          ...(instruction === undefined || instruction.trim() === ""
            ? {}
            : { instruction }),
        })
        .then(
          (result) => {
            setDraft(result);
            patch({
              title: result.title,
              description: result.description,
              ...(result.projectId === "" ? {} : { projectId: result.projectId }),
            });
          },
          // String(): an Error object put straight into string state renders
          // as a React child and takes the whole panel down.
          (cause) => setError(String(cause)),
        )
        .finally(() => setDrafting(false));
    },
    [rpc, message.id, status.aiReady],
  );

  useEffect(() => {
    // A queued draft is already the answer — redrafting it would throw away
    // work the user waited for and make the modal slow for no reason.
    if (seed === null) runDraft();
  }, [runDraft, seed]);

  const save = () => {
    setSaving(true);
    setError(null);
    rpc
      .call("inbox_create", {
        messageId: message.id,
        target: form.target,
        projectId: form.projectId,
        title: form.title,
        description: form.description,
        destinationId: form.destinationId === "" ? null : form.destinationId,
        attachmentIds: form.attachmentIds,
      })
      .then(onCreated, (cause) => setError(String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create ticket from email</DialogTitle>
          <DialogDescription className="truncate">
            {senderName(message.from)} — {message.subject}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {draft === null ? null : (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              <Icon name="Bot" className="mr-1 inline size-3" />
              {draft.projectId === ""
                ? "No project matched — pick one below."
                : `Matched ${draft.confidence} confidence: ${draft.reasoning}`}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Tracker</span>
              <select
                className={fieldClass}
                value={form.target}
                onChange={(event) => patch({ target: event.target.value })}
              >
                {status.targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">Project</span>
              <select
                className={fieldClass}
                value={form.projectId}
                onChange={(event) => patch({ projectId: event.target.value })}
              >
                <option value="">Select a project…</option>
                {(projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {projects !== null && projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No project is linked to {form.target} yet. Run{" "}
              <code>bb {form.target} config --project &lt;proj_id&gt;</code>{" "}
              first — only linked projects are listed here.
            </p>
          ) : null}

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Title</span>
            <Input
              value={form.title}
              onChange={(event) => patch({ title: event.target.value })}
              disabled={drafting}
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Description</span>
            <textarea
              className={cn(fieldClass, "min-h-48 font-mono text-xs")}
              value={drafting ? "Drafting with Claude…" : form.description}
              onChange={(event) => patch({ description: event.target.value })}
              disabled={drafting}
            />
          </label>

          {destinations.length === 0 ? null : (
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">{destinationLabel}</span>
              <select
                className={fieldClass}
                value={form.destinationId}
                onChange={(event) =>
                  patch({ destinationId: event.target.value })
                }
              >
                {destinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                    {destination.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {message.attachments.length === 0 ? null : (
            <div className="space-y-2 text-sm">
              <span className="text-muted-foreground">Attachments</span>
              {message.attachments.map((file) => (
                <label
                  key={file.attachmentId}
                  className="flex items-center gap-2"
                >
                  <Checkbox
                    checked={form.attachmentIds.includes(file.attachmentId)}
                    onCheckedChange={(checked) =>
                      patch({
                        attachmentIds:
                          checked === true
                            ? [...form.attachmentIds, file.attachmentId]
                            : form.attachmentIds.filter(
                                (id) => id !== file.attachmentId,
                              ),
                      })
                    }
                  />
                  <span className="truncate">{file.filename}</span>
                  <span className="text-xs text-muted-foreground">
                    {Math.max(1, Math.round(file.size / 1024))} KB
                  </span>
                </label>
              ))}
            </div>
          )}

          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => runDraft()}
            disabled={drafting || !status.aiReady}
          >
            <Icon name="Loading" className="size-4" />
            Redraft
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || drafting || form.projectId === "" || form.title.trim() === ""}
            >
              {saving ? "Creating…" : "Create ticket"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function accountName(account: MailboxAccount): string {
  return account.label.trim() !== ""
    ? account.label
    : (account.email ?? account.user ?? account.id);
}

/** Google credentials: needed once, shared by every Gmail mailbox. */
function GoogleSetup({
  redirectUri,
  onSaved,
}: {
  redirectUri: string;
  onSaved: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const save = () => {
    setSaving(true);
    setError(null);
    rpc
      .call("inbox_configure", {
        googleClientId: clientId.trim(),
        googleClientSecret: clientSecret.trim(),
      })
      .then(onSaved, (cause) => setError(String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Google only lets an app read mail through an OAuth client you own. You
        do this once, then every Gmail mailbox uses it.
      </p>
      <ol className="space-y-3">
        <li>
          <span className="font-medium">1.</span> In{" "}
          <a
            className="underline"
            href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
            target="_blank"
            rel="noreferrer"
          >
            Google Cloud Console
          </a>
          , enable the <b>Gmail API</b>.
        </li>
        <li>
          <span className="font-medium">2.</span> Create an OAuth client of type{" "}
          <b>Desktop app</b> and add this redirect URI:
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {redirectUri}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(redirectUri);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </li>
        <li>
          <span className="font-medium">3.</span> Paste its credentials:
          <div className="mt-2 space-y-2">
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="Client ID (…apps.googleusercontent.com)"
              autoComplete="off"
            />
            <Input
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder="Client secret"
              type="password"
              autoComplete="off"
            />
          </div>
        </li>
      </ol>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        className="w-full"
        onClick={save}
        disabled={saving || clientId.trim() === "" || clientSecret.trim() === ""}
      >
        {saving ? "Saving…" : "Save Google credentials"}
      </Button>
    </div>
  );
}

function ImapForm({ onAdded }: { onAdded: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [fields, setFields] = useState({
    label: "",
    host: "",
    port: "993",
    secure: true,
    user: "",
    password: "",
    mailbox: "INBOX",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof fields>) =>
    setFields((current) => ({ ...current, ...patch }));

  const add = () => {
    setSaving(true);
    setError(null);
    rpc
      .call("inbox_add_imap", {
        label: fields.label,
        host: fields.host.trim(),
        port: Number(fields.port) || 993,
        secure: fields.secure,
        user: fields.user.trim(),
        password: fields.password,
        mailbox: fields.mailbox.trim() || "INBOX",
      })
      .then(onAdded, (cause) => setError(String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-2 text-sm">
      <Input
        value={fields.label}
        onChange={(event) => set({ label: event.target.value })}
        placeholder="Name (optional, e.g. Support)"
      />
      <div className="flex gap-2">
        <Input
          className="flex-1"
          value={fields.host}
          onChange={(event) => set({ host: event.target.value })}
          placeholder="imap.example.com"
        />
        <Input
          className="w-24"
          value={fields.port}
          onChange={(event) => set({ port: event.target.value })}
          placeholder="993"
          inputMode="numeric"
        />
      </div>
      <Input
        value={fields.user}
        onChange={(event) => set({ user: event.target.value })}
        placeholder="Username or email"
        autoComplete="off"
      />
      <Input
        value={fields.password}
        onChange={(event) => set({ password: event.target.value })}
        placeholder="Password or app password"
        type="password"
        autoComplete="off"
      />
      <div className="flex items-center gap-3">
        <Input
          className="flex-1"
          value={fields.mailbox}
          onChange={(event) => set({ mailbox: event.target.value })}
          placeholder="INBOX"
        />
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={fields.secure}
            onCheckedChange={(checked) => set({ secure: checked === true })}
          />
          TLS
        </label>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button
        className="w-full"
        onClick={add}
        disabled={
          saving ||
          fields.host.trim() === "" ||
          fields.user.trim() === "" ||
          fields.password === ""
        }
      >
        {saving ? "Connecting…" : "Add mailbox"}
      </Button>
      <p className="text-xs text-muted-foreground">
        The connection is tested before the mailbox is saved. Access is
        read-only; nothing is ever sent or deleted.
      </p>
    </div>
  );
}

/** Add, reconnect and remove mailboxes. Gmail and IMAP side by side. */
function MailboxesPanel({
  status,
  onChanged,
}: {
  status: Status;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [adding, setAdding] = useState<"none" | "imap" | "google">("none");
  const [error, setError] = useState<string | null>(null);

  const openPopup = (url: string) =>
    window.open(url, "_blank", "width=520,height=680");

  const addGmail = () => {
    setError(null);
    rpc
      .call("inbox_add_gmail", { label: "" })
      .then((result) => openPopup(result.authUrl), (cause) =>
        setError(String(cause)),
      );
  };

  const reconnect = (accountId: string) => {
    setError(null);
    rpc
      .call("inbox_auth_start", { accountId })
      .then((result) => openPopup(result.authUrl), (cause) =>
        setError(String(cause)),
      );
  };

  const remove = (account: MailboxAccount) => {
    if (
      !window.confirm(
        `Remove ${accountName(account)}? Its cached mail, drafts and discards go with it. The mailbox itself is untouched.`,
      )
    ) {
      return;
    }
    rpc
      .call("inbox_remove_account", { accountId: account.id })
      .then(onChanged, (cause) => setError(String(cause)));
  };

  return (
    <div className="space-y-4">
      {status.accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          No mailboxes yet.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {status.accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 px-3 py-2.5">
              <Icon
                name={account.kind === "gmail" ? "Mail" : "Folder"}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{accountName(account)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {account.kind === "gmail"
                    ? account.connected
                      ? "Gmail"
                      : "Gmail — sign-in not finished"
                    : `IMAP ${account.host}:${account.mailbox}`}
                  {account.error === null ? "" : ` — ${account.error}`}
                </div>
              </div>
              {account.kind === "gmail" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reconnect(account.id)}
                >
                  {account.connected ? "Reconnect" : "Sign in"}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${accountName(account)}`}
                onClick={() => remove(account)}
              >
                <Icon name="X" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {adding === "imap" ? (
        <ImapForm
          onAdded={() => {
            setAdding("none");
            onChanged();
          }}
        />
      ) : adding === "google" || !status.credentialsConfigured ? (
        <GoogleSetup redirectUri={status.redirectUri} onSaved={onChanged} />
      ) : (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={addGmail}>
            Add Gmail
          </Button>
          <Button
            className="flex-1"
            variant="outline"
            onClick={() => setAdding("imap")}
          >
            Add IMAP
          </Button>
        </div>
      )}
    </div>
  );
}

function MailboxesDialog({
  status,
  onClose,
  onChanged,
}: {
  status: Status;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Mailboxes</DialogTitle>
          <DialogDescription>
            Gmail and IMAP accounts feed one merged inbox.
          </DialogDescription>
        </DialogHeader>
        <MailboxesPanel status={status} onChanged={onChanged} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sender allowlist as a chip list. Empty means everything is allowed —
 * that is the stated rule, so the dialog says it out loud rather than leaving
 * an empty list looking like a mistake.
 */
function SendersDialog({
  senders,
  onClose,
  onSaved,
}: {
  senders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [list, setList] = useState<string[]>(senders);
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    // One field, several entries: pasting a column of addresses should work.
    const added = entry
      .split(/[,\n;\s]+/)
      .map((part) => part.trim().replace(/^@/, "").toLowerCase())
      .filter((part) => part !== "" && !list.includes(part));
    if (added.length === 0) return;
    setList([...list, ...added]);
    setEntry("");
  };

  const save = () => {
    setSaving(true);
    setError(null);
    rpc
      .call("inbox_set_senders", { senders: list })
      .then(onSaved, (cause) => setError(String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Senders</DialogTitle>
          <DialogDescription>
            {list.length === 0
              ? "The list is empty, so mail from everyone is shown."
              : "Only mail from these addresses and domains is shown, in every mailbox."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              placeholder="ann@client.be or acme.com"
              aria-label="Add a sender"
            />
            <Button variant="outline" onClick={add} disabled={entry.trim() === ""}>
              Add
            </Button>
          </div>

          {list.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              No filter — every sender is shown.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {list.map((sender) => (
                <li
                  key={sender}
                  className="flex items-center gap-1 rounded-full border border-border bg-muted/50 py-1 pl-3 pr-1 text-sm"
                >
                  <span className="max-w-56 truncate">{sender}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${sender}`}
                    onClick={() => setList(list.filter((item) => item !== sender))}
                  >
                    <Icon name="X" className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            A bare domain matches everyone at it.
          </p>

          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          {list.length === 0 ? null : (
            <Button variant="ghost" onClick={() => setList([])}>
              Clear all
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
  none: "no project matched",
};

/**
 * Drafts produced in the background, sitting above the inbox because they are
 * the only thing here that is waiting on the user rather than on a machine.
 */
function DraftQueue({
  jobs,
  onReview,
  onDrop,
  onRetry,
}: {
  jobs: DraftJob[];
  onReview: (job: DraftJob) => void;
  onDrop: (messageId: string) => void;
  onRetry: (messageId: string) => void;
}) {
  const ready = jobs.filter((job) => job.state === "ready");
  const pending = jobs.filter(
    (job) => job.state === "queued" || job.state === "drafting",
  );
  const failed = jobs.filter((job) => job.state === "failed");

  return (
    <section className="mt-4 rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-medium">
        <Icon name="Bot" className="size-4 text-muted-foreground" />
        Drafts
        <span className="font-normal text-muted-foreground">
          {ready.length} to approve
          {pending.length === 0 ? "" : `, ${pending.length} in progress`}
        </span>
      </header>

      <ul className="divide-y divide-border">
        {ready.map((job) => (
          <li key={job.messageId} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {job.draft?.title ?? job.subject}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {senderName(job.from)} —{" "}
                {CONFIDENCE_LABEL[job.draft?.confidence ?? "none"]}
              </div>
            </div>
            <Button size="sm" onClick={() => onReview(job)}>
              Review
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Drop draft for "${job.subject}"`}
              onClick={() => onDrop(job.messageId)}
            >
              <Icon name="X" className="size-4" />
            </Button>
          </li>
        ))}

        {pending.map((job) => (
          <li
            key={job.messageId}
            className="flex items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground"
          >
            <Icon
              name="Loading"
              className={cn("size-4", job.state === "drafting" && "animate-spin")}
            />
            <span className="min-w-0 flex-1 truncate">{job.subject}</span>
            <span className="shrink-0 text-xs">
              {job.state === "drafting" ? "drafting…" : "queued"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={`Cancel draft for "${job.subject}"`}
              onClick={() => onDrop(job.messageId)}
            >
              <Icon name="X" className="size-4" />
            </Button>
          </li>
        ))}

        {failed.map((job) => (
          <li key={job.messageId} className="px-4 py-2.5 text-sm">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {job.subject}
              </span>
              <Button size="sm" variant="outline" onClick={() => onRetry(job.messageId)}>
                Retry
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={`Dismiss failed draft for "${job.subject}"`}
                onClick={() => onDrop(job.messageId)}
              >
                <Icon name="X" className="size-4" />
              </Button>
            </div>
            <p className="mt-1 truncate text-xs text-destructive" title={job.error ?? ""}>
              {job.error}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One inbox row; clicking it opens the mail in place, before any ticket exists. */
function MessageRow({
  message,
  link,
  open,
  onToggle,
  onCreate,
  discarded,
  onDiscard,
  job,
  onQueueDraft,
  showAccount,
}: {
  message: InboxMessage;
  link: TicketLink | undefined;
  open: boolean;
  onToggle: () => void;
  onCreate: () => void;
  discarded: boolean;
  onDiscard: (next: boolean) => void;
  job: DraftJob | undefined;
  onQueueDraft: () => void;
  showAccount: boolean;
}) {
  return (
    <li className={cn("text-sm", discarded && "opacity-60")}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">
                {senderName(message.from)}
              </span>
              {showAccount ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {message.account}
                </span>
              ) : null}
              {message.attachments.length === 0 ? null : (
                <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                  <Icon name="Paperclip" className="size-3" />
                  {message.attachments.length}
                </span>
              )}
              {link === undefined ? null : (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {link.target} {link.ticketId}
                </span>
              )}
            </div>
            <div className="truncate text-muted-foreground">
              {open ? message.subject : `${message.subject} — ${message.snippet}`}
            </div>
          </div>
        </button>
        {discarded ? (
          <Button variant="outline" size="sm" onClick={() => onDiscard(false)}>
            Restore
          </Button>
        ) : (
          <>
            {job === undefined ? (
              <Button variant="outline" size="sm" onClick={onQueueDraft}>
                Draft
              </Button>
            ) : null}
            <Button
              variant={
                job?.state === "ready" || link === undefined
                  ? "default"
                  : "outline"
              }
              size="sm"
              onClick={onCreate}
            >
              {job?.state === "ready"
                ? "Review"
                : link === undefined
                  ? "Create ticket"
                  : "Create again"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={`Discard "${message.subject}"`}
              onClick={() => onDiscard(true)}
            >
              <Icon name="X" className="size-4" />
            </Button>
          </>
        )}
      </div>

      {!open ? null : (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>From</dt>
            <dd className="truncate text-foreground">{message.from}</dd>
            <dt>To</dt>
            <dd className="truncate">{message.to}</dd>
            <dt>Date</dt>
            <dd>{message.date}</dd>
            <dt>Mailbox</dt>
            <dd className="truncate">{message.account}</dd>
          </dl>

          {message.attachments.length === 0 ? null : (
            <ul className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((file) => (
                <li
                  key={file.attachmentId}
                  className="flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  <Icon name="Paperclip" className="size-3 text-muted-foreground" />
                  <span className="max-w-56 truncate">{file.filename}</span>
                  <span className="text-muted-foreground">
                    {Math.max(1, Math.round(file.size / 1024))} KB
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 text-xs leading-relaxed">
            {message.body.trim() === "" ? "(empty body)" : message.body}
          </div>

          {link?.url === undefined || link.url === null ? null : (
            <a
              className="mt-2 inline-block text-xs underline"
              href={link.url}
              target="_blank"
              rel="noreferrer"
            >
              Open {link.ticketId}
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function InboxPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<InboxMessage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingSenders, setEditingSenders] = useState(false);
  const [editingMailboxes, setEditingMailboxes] = useState(false);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [discardedCount, setDiscardedCount] = useState(0);
  const [jobs, setJobs] = useState<DraftJob[]>([]);

  const report = useCallback((cause: unknown) => setError(String(cause)), []);
  const load = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      Promise.all([
        rpc.call("inbox_status", null),
        rpc.call("inbox_list", { refresh, includeDismissed: showDiscarded }),
        rpc.call("inbox_jobs", null),
      ])
        .then(([nextStatus, list, queue]) => {
          setJobs(queue.jobs);
          setStatus(nextStatus);
          setMessages(list.messages);
          setLinks(list.links);
          setDismissed(list.dismissed);
          setDiscardedCount(list.dismissedCount);
          setError(null);
        }, report)
        .finally(() => setBusy(false));
    },
    [rpc, report, showDiscarded],
  );
  useEffect(() => load(false), [load]);
  useRealtime("inbox-changed", () => load(false));

  const discard = useCallback(
    (messageId: string, next: boolean) => {
      // Optimistic: the row disappears on click and comes back if the call
      // fails, so discarding a backlog never waits on a round trip.
      setDismissed((current) =>
        next
          ? [messageId, ...current]
          : current.filter((id) => id !== messageId),
      );
      if (!showDiscarded && next) {
        setMessages((current) =>
          current === null
            ? null
            : current.filter((message) => message.id !== messageId),
        );
        setDiscardedCount((count) => count + 1);
      }
      rpc
        .call("inbox_dismiss", { messageId, dismissed: next })
        .then(undefined, (cause) => {
          report(cause);
          load(false);
        });
    },
    [rpc, report, load, showDiscarded],
  );

  const queueDraft = useCallback(
    (messageIds: string[]) => {
      rpc
        .call("inbox_queue_draft", { messageIds })
        .then((result) => setJobs(result.jobs), report);
    },
    [rpc, report],
  );

  const dropJob = useCallback(
    (messageId: string) => {
      rpc
        .call("inbox_drop_job", { messageId })
        .then((result) => setJobs(result.jobs), report);
    },
    [rpc, report],
  );

  const jobByMessage = useMemo(
    () => new Map(jobs.map((job) => [job.messageId, job])),
    [jobs],
  );

  const linkByMessage = useMemo(
    () => new Map(links.map((link) => [link.messageId, link])),
    [links],
  );

  if (status !== null && status.accounts.length === 0) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 pt-10">
        <h2 className="text-base font-medium">Connect a mailbox</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">
          Add as many as you like — Gmail and IMAP land in one list.
        </p>
        <MailboxesPanel status={status} onChanged={() => load(false)} />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm text-muted-foreground">
            {status === null
              ? "Loading…"
              : status.accounts.map(accountName).join(", ")}
            {status?.lastSyncedAt === null || status?.lastSyncedAt === undefined
              ? ""
              : ` — synced ${new Date(status.lastSyncedAt).toLocaleString()}`}
          </p>
          {status === null ? null : (
            <Button
              variant="outline"
              onClick={() => setEditingMailboxes(true)}
              aria-label="Manage mailboxes"
            >
              <Icon name="Mail" className="size-4" />
              {status.accounts.length}
            </Button>
          )}
          {status === null ? null : (
            <Button
              variant="outline"
              onClick={() => setEditingSenders(true)}
              aria-label="Limit the inbox to specific senders"
            >
              <Icon name="SlidersHorizontal" className="size-4" />
              {status.senders.length === 0
                ? "All senders"
                : `${status.senders.length} sender${status.senders.length === 1 ? "" : "s"}`}
            </Button>
          )}
          {discardedCount === 0 && !showDiscarded ? null : (
            <Button
              variant={showDiscarded ? "default" : "outline"}
              onClick={() => setShowDiscarded((current) => !current)}
            >
              {showDiscarded ? "Hide discarded" : `${discardedCount} discarded`}
            </Button>
          )}
          {messages === null || messages.length === 0 ? null : (
            <Button
              variant="outline"
              onClick={() =>
                queueDraft(
                  messages
                    .filter((message) => !jobByMessage.has(message.id))
                    .map((message) => message.id),
                )
              }
              disabled={messages.every((message) =>
                jobByMessage.has(message.id),
              )}
            >
              Draft all
            </Button>
          )}
          <Button variant="outline" onClick={() => load(true)} disabled={busy}>
            <Icon name="Loading" className={cn("size-4", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>

        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {jobs.length === 0 ? null : (
          <DraftQueue
            jobs={jobs}
            onReview={(job) => {
              const message = (messages ?? []).find(
                (candidate) => candidate.id === job.messageId,
              );
              if (message !== undefined) setActive(message);
            }}
            onDrop={dropJob}
            onRetry={(messageId) => {
              dropJob(messageId);
              queueDraft([messageId]);
            }}
          />
        )}

        <div className="mt-4">
          {messages === null ? (
            <EmptyState>Loading inbox…</EmptyState>
          ) : messages.length === 0 ? (
            <EmptyState>
              {discardedCount > 0 && !showDiscarded
                ? `Inbox clear — ${discardedCount} discarded.`
                : "Nothing here. Hit Refresh to fetch from Gmail."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  link={linkByMessage.get(message.id)}
                  open={openId === message.id}
                  onToggle={() =>
                    setOpenId((current) =>
                      current === message.id ? null : message.id,
                    )
                  }
                  onCreate={() => setActive(message)}
                  discarded={dismissed.includes(message.id)}
                  onDiscard={(next) => discard(message.id, next)}
                  job={jobByMessage.get(message.id)}
                  onQueueDraft={() => queueDraft([message.id])}
                  showAccount={(status?.accounts.length ?? 0) > 1}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {!editingMailboxes || status === null ? null : (
        <MailboxesDialog
          status={status}
          onClose={() => setEditingMailboxes(false)}
          onChanged={() => load(false)}
        />
      )}

      {!editingSenders || status === null ? null : (
        <SendersDialog
          senders={status.senders}
          onClose={() => setEditingSenders(false)}
          onSaved={() => {
            setEditingSenders(false);
            load(false);
          }}
        />
      )}

      {active === null || status === null ? null : (
        <SaveTicketDialog
          message={active}
          status={status}
          seed={jobByMessage.get(active.id)?.draft ?? null}
          onClose={() => setActive(null)}
          onCreated={(link) => {
            setActive(null);
            setLinks((current) => [link, ...current]);
            load(false);
          }}
        />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: InboxPage,
  });
});
