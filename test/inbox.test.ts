import { describe, expect, it } from "vitest";
import { htmlToText, parseMessage } from "../gmail";
import { TARGETS } from "../targets";
import { parseDraft } from "../ai";
import {
  isMeetingInvite,
  learnedProject,
  matchesSenders,
  parseSenders,
} from "../filters";

const b64 = (text: string) =>
  Buffer.from(text, "utf8").toString("base64url");

describe("parseMessage", () => {
  it("prefers the plain-text part and collects attachments", () => {
    const parsed = parseMessage({
      id: "m1",
      threadId: "t1",
      snippet: "hi",
      internalDate: "1700000000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Ann <ann@client.be>" },
          { name: "Subject", value: "Broken checkout" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64("Cart 500s on pay.") } },
          { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
          {
            mimeType: "application/pdf",
            filename: "trace.pdf",
            body: { attachmentId: "a1", size: 12 },
          },
        ],
      },
    });
    expect(parsed.subject).toBe("Broken checkout");
    expect(parsed.from).toBe("Ann <ann@client.be>");
    expect(parsed.body).toBe("Cart 500s on pay.");
    expect(parsed.attachments).toEqual([
      { attachmentId: "a1", filename: "trace.pdf", mimeType: "application/pdf", size: 12 },
    ]);
  });

  it("falls back to stripped HTML when there is no text part", () => {
    const parsed = parseMessage({
      id: "m2",
      threadId: "t2",
      payload: {
        mimeType: "text/html",
        headers: [],
        body: { data: b64("<style>x{}</style><p>Hello&nbsp;there</p><br>Bye") },
      },
    });
    expect(parsed.body).toBe("Hello there\n\nBye");
    expect(parsed.subject).toBe("(no subject)");
  });
});

describe("htmlToText", () => {
  it("drops scripts and decodes entities", () => {
    expect(htmlToText("<script>evil()</script><div>a &amp; b</div>")).toBe("a & b");
  });
});

describe("productive target", () => {
  it("passes one --attach per file and omits an unset list", () => {
    const argv = TARGETS.productive!.createArgv({
      projectId: "proj_1",
      title: "Fix checkout",
      description: "body",
      destinationId: null,
      attachments: ["/tmp/a.pdf", "/tmp/b.png"],
    });
    expect(argv).toEqual([
      "create", "--title", "Fix checkout", "--description", "body",
      "--project", "proj_1",
      "--attach", "/tmp/a.pdf", "--attach", "/tmp/b.png",
      "--json",
    ]);
  });

  it("reads the created key and url out of `bb productive create --json`", () => {
    expect(
      TARGETS.productive!.reference({
        item: { locator: "99", key: "PRJ-12", url: "https://app.productive.io/1/task/99" },
        warnings: [],
      }),
    ).toEqual({ id: "PRJ-12", url: "https://app.productive.io/1/task/99" });
  });
});

describe("trello target", () => {
  it("passes the chosen list and one --attach per file", () => {
    const argv = TARGETS.trello!.createArgv({
      projectId: "proj_1",
      title: "Fix checkout",
      description: "body",
      destinationId: "5f0a",
      attachments: ["/tmp/a.pdf", "/tmp/b.png"],
    });
    expect(argv).toEqual([
      "create", "--title", "Fix checkout", "--description", "body",
      "--project", "proj_1",
      "--list", "5f0a",
      "--attach", "/tmp/a.pdf", "--attach", "/tmp/b.png",
      "--json",
    ]);
    expect(TARGETS.trello!.supportsAttachments).toBe(true);
  });

  it("reads the created key and url out of `bb trello create --json`", () => {
    expect(
      TARGETS.trello!.reference({
        item: { key: "42", title: "Fix checkout", url: "https://trello.com/c/abc" },
        warnings: [],
      }),
    ).toEqual({ id: "42", url: "https://trello.com/c/abc" });
  });
});

describe("parseDraft", () => {
  const body = {
    projectId: "proj_1",
    confidence: "high",
    reasoning: "sender domain matches",
    title: "Fix checkout",
    description: "body",
  };

  it("accepts a bare JSON reply", () => {
    expect(parseDraft(JSON.stringify(body))).toEqual(body);
  });

  it("digs the object out of a fenced, chatty reply", () => {
    const reply = "Sure, here you go:\n```json\n" + JSON.stringify(body) + "\n```\nHope that helps.";
    expect(parseDraft(reply)).toEqual(body);
  });

  it("survives a code fence inside the drafted description", () => {
    const withFence = {
      ...body,
      description: "Fails with:\n\n```\nNot allowed to upload\n```\n\nNext step.",
    };
    expect(parseDraft("Here you go:\n```json\n" + JSON.stringify(withFence) + "\n```"))
      .toEqual(withFence);
  });

  it("rejects a reply with no JSON rather than inventing a draft", () => {
    expect(() => parseDraft("I could not determine a project.")).toThrow(/no JSON/);
  });

  it("rejects a JSON reply that breaks the schema", () => {
    expect(() => parseDraft(JSON.stringify({ ...body, confidence: "certain" }))).toThrow();
  });
});

describe("parseSenders", () => {
  it("normalises addresses and domains into match terms", () => {
    expect(parseSenders("ann@client.be, @acme.com\nBob@Example.org;")).toEqual([
      "ann@client.be",
      "acme.com",
      "bob@example.org",
    ]);
  });

  it("drops entries with characters an address cannot contain", () => {
    expect(parseSenders('ok@x.be, has space, br{ace, quo"te, ()')).toEqual([
      "ok@x.be",
    ]);
  });

  it("is empty for an empty setting, so no clause is added", () => {
    expect(parseSenders("   ")).toEqual([]);
  });
});

describe("matchesSenders", () => {
  const list = ["ann@client.be", "acme.com"];

  it("matches a full address and a whole domain", () => {
    expect(matchesSenders("Ann <ann@client.be>", list)).toBe(true);
    expect(matchesSenders("Bob <bob@acme.com>", list)).toBe(true);
    expect(matchesSenders("Sub <x@mail.acme.com>", list)).toBe(true);
  });

  it("rejects a sender on neither list", () => {
    expect(matchesSenders("Eve <eve@other.be>", list)).toBe(false);
    // Not a suffix match on the raw string: notacme.com must not pass.
    expect(matchesSenders("Eve <eve@notacme.com>", list)).toBe(false);
  });

  it("allows everyone when the list is empty", () => {
    expect(matchesSenders("anyone@anywhere.io", [])).toBe(true);
  });
});

describe("isMeetingInvite", () => {
  const base = {
    id: "1", threadId: "1", from: "a@b.c", to: "d@e.f", date: "", snippet: "",
    body: "", attachments: [], labelIds: [],
  };

  it("catches invite subjects in English and Dutch", () => {
    expect(isMeetingInvite({ ...base, subject: "Invitation: Standup @ Mon" })).toBe(true);
    expect(isMeetingInvite({ ...base, subject: "Updated invitation: Standup" })).toBe(true);
    expect(isMeetingInvite({ ...base, subject: "Uitnodiging: Standup" })).toBe(true);
  });

  it("catches a calendar attachment whatever the subject says", () => {
    expect(
      isMeetingInvite({
        ...base,
        subject: "Quick sync",
        attachments: [
          { attachmentId: "0", filename: "invite.ics", mimeType: "text/calendar", size: 10 },
        ],
      }),
    ).toBe(true);
  });

  it("leaves real mail alone", () => {
    expect(isMeetingInvite({ ...base, subject: "Invoice 2026/114" })).toBe(false);
  });
});

describe("learnedProject", () => {
  // Newest-first, the order the plugin stores links in.
  const history = [
    { from: "Ann <ann@client.be>", target: "productive", projectId: "p2" },
    { from: "ann@client.be", target: "productive", projectId: "p1" },
    { from: "ANN <ann@CLIENT.be>", target: "productive", projectId: "p1" },
    { from: "bob@other.be", target: "productive", projectId: "p9" },
    { from: "ann@client.be", target: "trello", projectId: "p5" },
  ];

  it("takes the sender's majority project, ignoring display name and case", () => {
    expect(learnedProject(history, "Ann Peeters <ann@client.be>", "productive"))
      .toEqual({ projectId: "p1", count: 2 });
  });

  it("keeps each tracker's history separate", () => {
    expect(learnedProject(history, "ann@client.be", "trello")).toEqual({
      projectId: "p5",
      count: 1,
    });
  });

  it("breaks a tie towards the most recent ticket", () => {
    const tied = [
      { from: "ann@client.be", target: "productive", projectId: "p2" },
      { from: "ann@client.be", target: "productive", projectId: "p1" },
    ];
    expect(learnedProject(tied, "ann@client.be", "productive")).toEqual({
      projectId: "p2",
      count: 1,
    });
  });

  it("returns null for an unseen sender", () => {
    expect(learnedProject(history, "new@client.be", "productive")).toBeNull();
  });

  it("survives links stored before the sender field existed", () => {
    // Not `from: ""` — storage is read back with a cast and no schema parse,
    // so an older link has no `from` key at all.
    const legacy = [{ target: "productive", projectId: "p1" }];
    expect(learnedProject(legacy, "ann@client.be", "productive")).toBeNull();
    expect(
      learnedProject(
        [...legacy, { from: "ann@client.be", target: "productive", projectId: "p3" }],
        "ann@client.be",
        "productive",
      ),
    ).toEqual({ projectId: "p3", count: 1 });
  });

  it("returns null when the incoming mail has no usable sender", () => {
    expect(learnedProject(history, "", "productive")).toBeNull();
  });
});
