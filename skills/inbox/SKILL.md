---
name: inbox
description: Read the user's mailboxes (Gmail and IMAP) and turn a message into a tracker ticket (Productive) with its attachments. Use when the user mentions their email, inbox, mailbox, "that mail from X", or asks to make a task/ticket out of an email.
---

# Inbox → ticket

`bb inbox` reads the user's mailboxes — any number of Gmail and IMAP accounts,
merged into one list — and creates tickets through the tracker plugin that owns
those credentials. Access is read-only; it never writes to a mailbox.

## Commands

```
bb inbox accounts [--json]                    List mailboxes
bb inbox status [--json]                      Connection + configuration state
bb inbox connect [--json]                     Print the Google sign-in URL
bb inbox list [--refresh] [--all] [--json]     List messages (* = ticketed, - = discarded, --all shows discarded)
bb inbox show <message-id> [--json]           Full body + attachment list
bb inbox discard <message-id> [--json]        Hide it from the list
bb inbox restore <message-id> [--json]        Put it back
bb inbox draft <message-id> [--instruction <text>] [--queue] [--json]
bb inbox drafts [--json]                      Background queue + what awaits approval
bb inbox create <message-id> --project <proj_id> [--target productive]
                [--title <text>] [--description <text>] [--list <id>]
                [--attach-all] [--json]
```

## How to use it

1. `bb inbox list --refresh --json` to find the message id.
2. `bb inbox draft <id> --json` — returns `projectId`, `confidence`,
   `reasoning`, `title`, `description`. It does not create anything. A draft
   takes ~20s; for several mails use `--queue` on each and then poll
   `bb inbox drafts`, which drafts them one at a time in the background.
3. **Show the draft to the user and get confirmation before creating.** The
   user's rule for this plugin is that a ticket is never created without a
   review step. In the BB Inbox page that review is the save modal; from the
   CLI, you are the review step.
4. `bb inbox create <id> --project <proj_id> --title "…" --description "…"`
   with whatever the user corrected. Add `--attach-all` to upload the email's
   attachments onto the ticket.

`draft` returns an empty `projectId` with confidence `none` when no project
clearly matches — ask the user which project rather than guessing.

Drafting spawns a short-lived hidden thread on this bb's configured provider
and deletes it afterwards, so it takes a few seconds and needs no API key.

## Notes

- Message ids are `<account-id>::<provider-id>`. Take them from `bb inbox list`;
  never build one by hand.
- The inbox may be limited to specific senders (the `senders` setting, applied
  as a Gmail `from:{…}` clause) and excludes calendar invites by default.
  `bb inbox status` prints the sender list and the invite setting, so a
  "missing" mail is usually filtered rather than absent. An empty `senders`
  list allows everyone. Both rules are applied locally, to every provider.
- `bb inbox show <message-id>` prints the full body — use it before drafting so
  you are not working from the snippet.
- Creating a ticket discards the mail automatically, so it leaves the list. Use
  `bb inbox discard` for mail that needs no ticket; both are BB-local and never
  change anything in Gmail.
- The save modal only offers projects already linked to the tracker.
- `create` fails if the bb project has no tracker linked. Check with
  `bb productive status --project <proj_id> --json` and link it with
  `bb productive config --project <proj_id> --productive-project <id>`.
- Message ids come from Gmail and stay stable; ticket links are remembered so
  `bb inbox list` can mark messages that already produced a ticket.
