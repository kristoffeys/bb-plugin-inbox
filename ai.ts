// AI drafting through BB's own provider — no API key of our own. We spawn a
// hidden thread with the drafting prompt, wait for it to go idle, read its
// final output and throw the thread away. Round trip is a few seconds, which
// the save modal covers with a "Drafting…" state.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ParsedMessage } from "./gmail";

export const draftSchema = z.object({
  projectId: z.string(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  reasoning: z.string(),
  title: z.string(),
  description: z.string(),
});
export type Draft = z.infer<typeof draftSchema>;

export type ProjectHint = {
  id: string;
  name: string;
  /** Repo paths / remotes — cheap, high-signal clues about what a project is. */
  hints: string[];
};

function emailBlock(message: ParsedMessage): string {
  const attachments =
    message.attachments.length === 0
      ? "(none)"
      : message.attachments
          .map((file) => `${file.filename} (${file.mimeType}, ${file.size}B)`)
          .join(", ");
  return [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
    `Attachments: ${attachments}`,
    "",
    message.body,
  ].join("\n");
}

function projectBlock(projects: ProjectHint[]): string {
  if (projects.length === 0) return "(no projects available)";
  return projects
    .map(
      (project) =>
        `- id=${project.id} name=${project.name}${
          project.hints.length === 0 ? "" : ` hints=${project.hints.join(" ")}`
        }`,
    )
    .join("\n");
}

export function buildPrompt(args: {
  message: ParsedMessage;
  projects: ProjectHint[];
  instruction?: string;
}): string {
  return [
    "You turn a work-request email into a tracker ticket for a software agency.",
    "Write the ticket the way the person who has to do the work wants to read it:",
    "concrete, specific, no restating of pleasantries, no invented requirements.",
    "",
    "Match the email to a project only on real evidence (client or project name,",
    "domain, repo, product name in the subject, body or sender address). When the",
    'evidence is weak, return an empty projectId and confidence "none" — a wrong',
    "guess costs more than no guess.",
    "",
    "Candidate projects:",
    projectBlock(args.projects),
    "",
    "Email:",
    "<email>",
    emailBlock(args.message),
    "</email>",
    ...(args.instruction === undefined || args.instruction.trim() === ""
      ? []
      : ["", `Extra instruction from the user: ${args.instruction}`]),
    "",
    "Do not use any tools and do not read or write files. Reply with ONLY this",
    "JSON object, no prose and no code fence:",
    '{"projectId":"<id or empty string>","confidence":"high|medium|low|none",',
    '"reasoning":"<one short sentence>","title":"<imperative, max 80 chars>",',
    '"description":"<markdown ticket body>"}',
  ].join("\n");
}

/**
 * Pull the JSON object out of a reply that may be fenced or carry stray prose.
 *
 * Outermost brace to outermost brace, deliberately: a drafted description
 * regularly contains its own ``` code fence, so stripping fences first would
 * capture the error message inside the ticket instead of the ticket.
 */
export function parseDraft(output: string): Draft {
  const candidate = output;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end <= start) {
    throw new Error(
      `The drafting thread was cut off before it finished its JSON. Reply was:\n${output}`,
    );
  }
  if (start === -1) {
    throw new Error(`The drafting thread returned no JSON. Reply was:\n${output}`);
  }
  return draftSchema.parse(JSON.parse(candidate.slice(start, end + 1)));
}

export async function draftTicket(args: {
  bb: BbPluginApi;
  projectId: string;
  message: ParsedMessage;
  projects: ProjectHint[];
  instruction?: string;
  timeoutMs?: number;
}): Promise<Draft> {
  const { bb } = args;
  const thread = await bb.sdk.threads.spawn({
    projectId: args.projectId,
    environment: { type: "project-default" },
    visibility: "hidden",
    title: `Inbox draft: ${args.message.subject}`.slice(0, 120),
    prompt: buildPrompt(args),
  });
  try {
    await bb.sdk.threads.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: args.timeoutMs ?? 180_000,
    });
    const { output } = await bb.sdk.threads.output({ threadId: thread.id });
    if (output === null || output.trim() === "") {
      throw new Error("The drafting thread produced no output.");
    }
    return parseDraft(output);
  } finally {
    // Best effort: a stranded hidden thread is noise, not a failure worth
    // surfacing over a draft the user already has.
    await bb.sdk.threads
      .delete({ threadId: thread.id, childThreadsConfirmed: true })
      .catch(() => bb.log.warn(`could not delete draft thread ${thread.id}`));
  }
}
