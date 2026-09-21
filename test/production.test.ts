import { expect, onTestFinished, test } from "bun:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

async function availablePort(): Promise<number> {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string")
        return reject(new Error("No TCP port"));
      socket.close(() => resolve(address.port));
    });
  });
}

test("production entrypoint persists data across application restarts", async () => {
  const mongo = await MongoMemoryServer.create();
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  onTestFinished(async () => {
    for (const process of processes) {
      if (process.exitCode === null) process.kill();
      await process.exited;
    }
    await mongo.stop();
  });
  const token = "production-smoke-local-token-12345";
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  async function start() {
    const port = await availablePort();
    const child = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        MONGO_URI: mongo.getUri("production-smoke"),
        AUTH_SKIP: "false",
        AUTH_USERS: JSON.stringify([{ username: "smoke", name: null, token }]),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    processes.push(child);
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(
          `Server exited: ${await new Response(child.stderr).text()}`,
        );
      const response = await fetch(`${url}/health`).catch(() => undefined);
      if (response?.ok) return { child, url };
      await Bun.sleep(100);
    }
    throw new Error("Production server did not become ready");
  }
  const first = await start();
  const created = await fetch(`${first.url}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Survives restart",
      startsAt: "2026-09-21T10:00:00Z",
      endsAt: "2026-09-21T11:00:00Z",
    }),
  });
  expect(created.status).toBe(201);
  const event = (await created.json()) as { id: string };
  first.child.kill();
  await first.child.exited;
  const second = await start();
  const read = await fetch(`${second.url}/events/${event.id}`, { headers });
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    id: event.id,
    title: "Survives restart",
  });
  const demo = await fetch(`${second.url}/events`, {
    headers: { authorization: "Bearer alice-dev-token" },
  });
  expect(demo.status).toBe(401);
}, 30000);
