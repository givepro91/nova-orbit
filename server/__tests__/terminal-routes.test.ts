import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTerminalRoutes } from "../api/routes/terminals.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startApi(dismiss: (id: string) => unknown) {
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({
    terminalManager: { dismiss },
    broadcast,
  } as never));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcast };
}

async function startTaskApi(terminalManager: Record<string, unknown>) {
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({
    db: {},
    terminalManager,
    broadcast,
  } as never));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcast };
}

describe("terminal tab routes", () => {
  it("dismisses a completed terminal and broadcasts the tab update", async () => {
    const dismiss = vi.fn().mockReturnValue({ id: "term-1", workspaceId: "w1", projectId: "p1" });
    const { baseUrl, broadcast } = await startApi(dismiss);

    const response = await fetch(`${baseUrl}/api/terminals/term-1/dismiss`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "dismissed", terminalId: "term-1" });
    expect(dismiss).toHaveBeenCalledWith("term-1");
    expect(broadcast).toHaveBeenCalledWith("terminal:dismissed", {
      terminalId: "term-1",
      workspaceId: "w1",
      projectId: "p1",
    });
  });

  it("requires an active terminal to be stopped first", async () => {
    const { baseUrl } = await startApi(() => {
      throw new Error("Active terminal must be stopped before dismissal");
    });

    const response = await fetch(`${baseUrl}/api/terminals/term-active/dismiss`, { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Active terminal must be stopped before dismissal" });
  });

  it("rejects task start before claiming when terminal context is mismatched", async () => {
    const write = vi.fn();
    const { baseUrl } = await startTaskApi({
      get: vi.fn().mockReturnValue({ id: "term-1", status: "active", contextState: "mismatch" }),
      write,
    });

    const response = await fetch(`${baseUrl}/api/terminals/term-1/start-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Terminal context is not connected" });
    expect(write).not.toHaveBeenCalled();
  });
});
