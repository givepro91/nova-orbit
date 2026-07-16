import { randomUUID } from "node:crypto";

const apiBase = process.env.CREWDECK_API_URL?.replace(/\/$/, "");
const apiKey = process.env.CREWDECK_API_KEY;
const workspaceId = process.env.CREWDECK_WORKSPACE_ID;
const terminalSessionId = process.env.CREWDECK_TERMINAL_ID;

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(input: string | undefined, name: string): string {
  if (!input?.trim()) throw new Error(`${name} is required`);
  return input.trim();
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!apiBase || !apiKey || !workspaceId || !terminalSessionId) {
    throw new Error("This command must run inside a Crewdeck terminal Workspace");
  }
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((body as { error?: unknown }).error ?? `HTTP ${response.status}`));
  return body;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const clientRequestId = value(args, "--request-id") ?? randomUUID();
  if (command === "context") {
    console.log(JSON.stringify(await request(`/terminal-bridge/context?workspaceId=${encodeURIComponent(workspaceId!)}&terminalSessionId=${encodeURIComponent(terminalSessionId!)}`), null, 2));
    return;
  }
  if (command === "decision") {
    if (!terminalSessionId) throw new Error("This terminal session is missing its Crewdeck id");
    console.log(JSON.stringify(await request("/terminal-bridge/decisions", {
      method: "POST",
      body: JSON.stringify({ workspaceId, terminalSessionId, message: required(value(args, "--message") ?? args.join(" "), "--message") }),
    }), null, 2));
    return;
  }
  if (command === "goal") {
    const tasksRaw = value(args, "--tasks-json");
    const tasks = tasksRaw ? JSON.parse(tasksRaw) : [];
    const result = await request("/terminal-bridge/goals", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        terminalSessionId,
        clientRequestId,
        title: required(value(args, "--title") ?? args.find((arg) => !arg.startsWith("--")), "--title"),
        description: value(args, "--description") ?? "",
        priority: value(args, "--priority") ?? "medium",
        tasks,
      }),
    });
    const created = result as { goal?: Record<string, unknown>; tasks?: Array<Record<string, unknown>>; workspaceId?: string; replayed?: boolean };
    console.log(JSON.stringify({
      ok: true,
      goal: created.goal ? { id: created.goal.id, title: created.goal.title } : null,
      tasks: (created.tasks ?? []).map((task) => ({ id: task.id, title: task.title, status: task.status })),
      workspaceId: created.workspaceId ?? null,
      replayed: created.replayed ?? false,
    }, null, 2));
    return;
  }
  if (command === "task") {
    const result = await request("/terminal-bridge/tasks", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        terminalSessionId,
        clientRequestId,
        goalId: required(value(args, "--goal-id"), "--goal-id"),
        task: {
          title: required(value(args, "--title"), "--title"),
          description: value(args, "--description") ?? "",
          assignee: value(args, "--assignee"),
        },
      }),
    });
    const created = result as { task?: Record<string, unknown>; replayed?: boolean };
    console.log(JSON.stringify({ ok: true, task: created.task ? {
      id: created.task.id, goalId: created.task.goal_id, title: created.task.title, status: created.task.status,
    } : null, replayed: created.replayed ?? false }, null, 2));
    return;
  }
  if (command === "task-status") {
    const taskId = required(value(args, "--task-id"), "--task-id");
    const result = await request(`/terminal-bridge/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        workspaceId,
        terminalSessionId,
        clientRequestId,
        status: required(value(args, "--status"), "--status"),
        summary: value(args, "--summary"),
      }),
    });
    const updated = result as { task?: Record<string, unknown>; replayed?: boolean };
    console.log(JSON.stringify({ ok: true, task: updated.task ? {
      id: updated.task.id, title: updated.task.title, status: updated.task.status,
    } : null, replayed: updated.replayed ?? false }, null, 2));
    return;
  }
  if (command === "agent-exit") {
    const exitCode = Number(required(value(args, "--exit-code"), "--exit-code"));
    if (!Number.isInteger(exitCode)) throw new Error("--exit-code must be an integer");
    const result = await request("/terminal-bridge/agent-exit", {
      method: "POST",
      body: JSON.stringify({
        workspaceId,
        terminalSessionId,
        clientRequestId,
        provider: value(args, "--provider") ?? "AI agent",
        exitCode,
      }),
    });
    const reconciled = result as { task?: Record<string, unknown> | null };
    console.log(JSON.stringify({ ok: true, task: reconciled.task ? {
      id: reconciled.task.id, title: reconciled.task.title, status: reconciled.task.status,
    } : null }, null, 2));
    return;
  }
  console.log(`Crewdeck terminal bridge

Commands:
  crewdeck-sync context
  crewdeck-sync decision --message <user-resolution>
  crewdeck-sync goal --title <title> [--description <text>] [--priority medium] [--tasks-json '[{"title":"...","assignee":"backend"}]']
  crewdeck-sync task --goal-id <id> --title <title> [--description <text>] [--assignee <name-or-role>]
  crewdeck-sync task-status --task-id <id> --status <todo|in_progress|in_review|done|blocked> [--summary <text>]
  crewdeck-sync agent-exit --provider <claude|codex> --exit-code <integer>
`);
}

main().catch((error) => {
  console.error(`crewdeck-sync: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
