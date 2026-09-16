// Exercises the todo CRUD through the full application (plugins autoloaded,
// in-memory MongoDB) with real bearer tokens from src/auth/users.ts.

import { onTestFinished, test } from "bun:test";
import * as assert from "node:assert";
import Fastify from "fastify";
import fp from "fastify-plugin";
import App from "../../src/app.js";

const ALICE = { authorization: "Bearer alice-dev-token" };

async function buildApp() {
  const app = Fastify({ pluginTimeout: 5 * 60 * 1000 });
  onTestFinished(() => app.close());

  await app.register(fp(App), {
    mongoUri: undefined,
    mongoTestUri: undefined,
    authSkip: false,
  });
  await app.ready();
  return app;
}

test("create, read, update, and delete a todo", async () => {
  const app = await buildApp();

  const created = await app.inject({
    url: "/todos",
    method: "POST",
    headers: ALICE,
    body: { title: "Ship the thing", dueDate: "2026-10-01T09:00:00.000Z" },
  });
  assert.equal(created.statusCode, 201);
  const todo = JSON.parse(created.payload);
  assert.equal(todo.title, "Ship the thing");
  assert.equal(todo.done, false);
  assert.equal(todo.user, "alice");

  const listed = await app.inject({ url: "/todos", headers: ALICE });
  assert.equal(listed.statusCode, 200);
  const list = JSON.parse(listed.payload);
  assert.equal(list.total, 1);
  assert.equal(list.todos[0]?.id, todo.id);

  const patched = await app.inject({
    url: `/todos/${todo.id}`,
    method: "PATCH",
    headers: ALICE,
    body: { done: true },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(JSON.parse(patched.payload).done, true);

  const deleted = await app.inject({
    url: `/todos/${todo.id}`,
    method: "DELETE",
    headers: ALICE,
  });
  assert.equal(deleted.statusCode, 204);

  const missing = await app.inject({
    url: `/todos/${todo.id}`,
    headers: ALICE,
  });
  assert.equal(missing.statusCode, 404);
});

test("todo routes require authentication", async () => {
  const app = await buildApp();

  const listed = await app.inject({ url: "/todos" });
  assert.equal(listed.statusCode, 401);

  const created = await app.inject({
    url: "/todos",
    method: "POST",
    body: { title: "nope" },
  });
  assert.equal(created.statusCode, 401);
});
