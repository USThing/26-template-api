import { expect, test } from "bun:test";
import { loadUsers, users } from "../src/auth/users.js";
import { loadOptions } from "../src/options.js";

test("demo users are available only when production configuration is not required", () => {
  expect(loadUsers(undefined)).toEqual(users);
  expect(() => loadOptions({ NODE_ENV: "production" })).toThrow("AUTH_USERS");
  expect(() =>
    loadOptions({ NODE_ENV: "production", AUTH_SKIP: "true" }),
  ).toThrow("AUTH_SKIP");
});

test("explicit token tables validate identities and uniqueness", () => {
  const alice = {
    username: "alice",
    name: "Alice",
    token: "local-secret-1234567890",
  };
  expect(loadUsers(JSON.stringify([alice]), true)).toEqual([alice]);
  for (const invalid of [
    "broken",
    "[]",
    "null",
    JSON.stringify([{}]),
    JSON.stringify([alice, alice]),
    JSON.stringify([{ ...alice, token: "with spaces not allowed" }]),
    JSON.stringify([{ ...alice, username: " " }]),
  ]) {
    expect(() => loadUsers(invalid)).toThrow();
  }
});
