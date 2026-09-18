// Cross-plugin bridge. The inbox plugin never talks to Productive/Jira/Trello
// APIs itself: it calls the tracker plugin's own `bb <plugin> …` command over
// the server's loopback CLI endpoint, so credentials and field mapping stay
// where they already live.
//
// Adding a tracker = one entry in TARGETS.

export type CliResult = { exitCode: number; stdout: string; stderr: string };

export async function pluginCli(
  loopbackBaseUrl: string,
  pluginId: string,
  argv: string[],
  signal?: AbortSignal,
): Promise<CliResult> {
  const response = await fetch(
    `${loopbackBaseUrl}/api/v1/plugins/${pluginId}/cli`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv }),
      signal,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `bb ${pluginId} ${argv[0] ?? ""} failed (${response.status}): ${text.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(text) as Partial<CliResult>;
  return {
    exitCode: parsed.exitCode ?? 1,
    stdout: parsed.stdout ?? "",
    stderr: parsed.stderr ?? "",
  };
}

export type CreateInput = {
  projectId: string;
  title: string;
  description: string;
  /** Tracker-side destination (Productive task list, Trello list, Jira type). */
  destinationId: string | null;
  /** Absolute, server-local paths staged by the inbox plugin. */
  attachments: string[];
};

export type TargetDefinition = {
  id: string;
  label: string;
  /** CLI argv (without the leading plugin name) that creates the ticket. */
  createArgv: (input: CreateInput) => string[];
  /** CLI argv that reports whether this bb project is wired up. */
  statusArgv: (projectId: string) => string[];
  /** CLI argv listing the places a ticket can land, `[{id, name, isDefault}]`. */
  destinationsArgv: (projectId: string) => string[];
  /** What the tracker calls that place, for the modal's label. */
  destinationLabel: string;
  /** Pull a human-facing ticket reference out of the create command's JSON. */
  reference: (payload: unknown) => { id: string; url: string | null };
};

function pick(payload: unknown, ...keys: string[]): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  const nested = record.task ?? record.item ?? record.issue ?? record.card;
  if (nested !== undefined && nested !== payload) return pick(nested, ...keys);
  return null;
}

export const TARGETS: Record<string, TargetDefinition> = {
  productive: {
    id: "productive",
    label: "Productive",
    createArgv: (input) => [
      "create",
      "--title",
      input.title,
      "--description",
      input.description,
      "--project",
      input.projectId,
      ...(input.destinationId === null ? [] : ["--list", input.destinationId]),
      ...input.attachments.flatMap((path) => ["--attach", path]),
      "--json",
    ],
    statusArgv: (projectId) => ["status", "--project", projectId, "--json"],
    destinationsArgv: (projectId) => ["lists", "--project", projectId, "--json"],
    destinationLabel: "Task list",
    // `bb productive create --json` returns { item: { locator, key, url }, … }.
    reference: (payload) => ({
      id: pick(payload, "key", "locator", "id") ?? "?",
      url: pick(payload, "url", "webUrl", "appUrl"),
    }),
  },
};

export function targetOrThrow(id: string): TargetDefinition {
  const target = TARGETS[id];
  if (target === undefined) {
    throw new Error(
      `Unknown ticket target "${id}". Known: ${Object.keys(TARGETS).join(", ")}.`,
    );
  }
  return target;
}

/** bb projects that have this tracker configured, newest-useful first. */
export async function configuredProjects(
  loopbackBaseUrl: string,
  target: TargetDefinition,
  projects: { id: string; name: string }[],
): Promise<{ id: string; name: string; configured: boolean }[]> {
  const checked = await Promise.all(
    projects.map(async (project) => {
      try {
        const result = await pluginCli(
          loopbackBaseUrl,
          target.id,
          target.statusArgv(project.id),
        );
        if (result.exitCode !== 0) return { ...project, configured: false };
        const payload = JSON.parse(result.stdout) as {
          status?: { configured?: boolean };
        };
        return { ...project, configured: payload.status?.configured === true };
      } catch {
        return { ...project, configured: false };
      }
    }),
  );
  return checked;
}

export async function createTicket(
  loopbackBaseUrl: string,
  target: TargetDefinition,
  input: CreateInput,
): Promise<{ id: string; url: string | null; raw: unknown }> {
  const result = await pluginCli(
    loopbackBaseUrl,
    target.id,
    target.createArgv(input),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `bb ${target.id} create exited ${result.exitCode}`,
    );
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    raw = { stdout: result.stdout };
  }
  return { ...target.reference(raw), raw };
}

export type Destination = { id: string; name: string; isDefault: boolean };

export async function listDestinations(
  loopbackBaseUrl: string,
  target: TargetDefinition,
  projectId: string,
): Promise<Destination[]> {
  const result = await pluginCli(
    loopbackBaseUrl,
    target.id,
    target.destinationsArgv(projectId),
  );
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Destination[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
