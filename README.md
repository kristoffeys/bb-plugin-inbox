# bb-plugin-inbox

Read your mailboxes inside BB, let Claude draft a ticket from a message, review it
in a modal, then create it in Productive or Trello — attachments included.

Nothing is ever created without the save modal. The AI only drafts.

## Setup

Open the BB **Inbox** page. With no mailboxes it opens straight on the mailbox
panel; afterwards the mail-count button in the header reopens it.

**Gmail** — one-time Google setup, then one click per mailbox:

1. In Google Cloud Console, enable the **Gmail API** and create an OAuth client
   of type **Desktop app**. The panel shows the redirect URI to register, with
   a copy button.
2. Paste the client id and secret once. Every Gmail mailbox reuses them.
3. **Add Gmail** → sign in. Repeat for as many Google accounts as you like.

**IMAP** — **Add IMAP** and fill in host, port, user and password (an app
password where the provider requires one). The connection is tested before the
mailbox is saved, so a typo never becomes a permanently broken row. There is no
SMTP: the plugin only ever reads.

**Filters** apply to every mailbox at once:

- **Senders** — the header button opens a chip list. Empty means everyone.
  Addresses match exactly; a bare domain matches everyone at it.
- **Calendar invites** are hidden by default (`excludeInvites`), matched on
  subject and on `text/calendar` attachments.
- `query` is a Gmail-only *fetch* hint. The rules above run locally so Gmail
  and IMAP behave identically.

**Link a project** — only projects already linked to a tracker appear in the
save modal's picker, because an unlinked one can only fail:
`bb productive config --project <proj_id> --productive-project <id>` or
`bb trello config --project <proj_id> --board <id>`.

## Learning who works on what

Every created ticket records the sender it came from. When mail arrives from an
address that has produced tickets before, the plugin votes on that sender's past
projects and preselects the winner, with the count as the reason ("3 earlier
tickets from this sender went to Spardex"). The model gets the same history as a
hint, but the preselection does not depend on it taking the hint — those past
tickets were approved by hand, so they win unless the mail names another project
outright.

History is per tracker and starts empty; the first ticket from a new sender is
still a plain guess.

## How it works

The plugin never touches the Productive/Jira/Trello APIs. It calls the tracker
plugin's own CLI over the server's loopback endpoint, so credentials and field
mapping stay in the plugin that owns them. Adding a tracker is one entry in
`targets.ts`. A tracker whose `create` takes `--attach` gets the mail's files;
one that does not sets `supportsAttachments: false` and the modal hides the
picker rather than dropping files silently.

Mail access is **read-only** everywhere: the Gmail scope is `gmail.readonly`
and every IMAP mailbox is opened with `readOnly`. Attachments are staged in the
server's tmpdir only for the length of one upload and deleted afterwards.

Why you still need your own Google client: Google will not grant Gmail scopes
to an app it has not registered, and a client id cannot be shipped in a plugin
without tying every user's quota and consent screen to one project. A *Desktop
app* client's secret is not a real secret by Google's own design — it is only
an identifier.

## Commands

See `skills/inbox/SKILL.md` — the same reference agents get.

## Develop

```
npm run check     # typecheck + tests + build
bb plugin dev .   # rebuild and reload on save
```
