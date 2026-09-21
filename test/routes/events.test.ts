import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import Fastify from "fastify";
import fp from "fastify-plugin";
import ICAL from "ical.js";
import { ObjectId } from "mongodb";
import App from "../../src/app.js";
import { loadOptions } from "../../src/options.js";

const ALICE = { authorization: "Bearer alice-dev-token" };
const BOB = { authorization: "Bearer bob-dev-token" };
const input = {
  title: "Study group",
  description: "Revise databases",
  location: "Library",
  startsAt: "2026-09-21T10:00:00+08:00",
  endsAt: "2026-09-21T11:00:00+08:00",
};
const options = loadOptions({});
const app = Fastify({ ...options, logger: false });
beforeAll(async () => {
  await app.register(fp(App), { ...options, test: true });
  await app.ready();
}, 300000);
afterAll(() => app.close());
beforeEach(async () => {
  await app.collections.events.deleteMany({});
});

async function create(body = input, headers = ALICE) {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers,
    body,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

test("CRUD normalizes offsets, preserves fields and clears nullable fields", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers: ALICE,
    body: input,
  });
  expect(response.statusCode).toBe(201);
  const event = response.json();
  expect(response.headers.location).toBe(`/events/${event.id}`);
  expect(event.startsAt).toBe("2026-09-21T02:00:00.000Z");
  expect(event.version).toBe(1);
  expect(event.owner).toBeUndefined();
  const read = await app.inject({ url: `/events/${event.id}`, headers: ALICE });
  expect(read.json()).toEqual(event);
  const patched = await app.inject({
    method: "PATCH",
    url: `/events/${event.id}`,
    headers: ALICE,
    body: {
      version: 1,
      title: "  New title  ",
      startsAt: event.startsAt,
      location: null,
      description: null,
    },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({
    title: "New title",
    location: null,
    description: null,
    version: 2,
    startsAt: event.startsAt,
    createdAt: event.createdAt,
  });
  const deleted = await app.inject({
    method: "DELETE",
    url: `/events/${event.id}`,
    headers: ALICE,
  });
  expect(deleted.statusCode).toBe(204);
  expect(deleted.body).toBe("");
  expect(
    (await app.inject({ url: `/events/${event.id}`, headers: ALICE }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/events/${event.id}`,
        headers: ALICE,
      })
    ).statusCode,
  ).toBe(404);
});

test("Alice and Bob cannot list, export, read, update or delete each other's data", async () => {
  const event = await create();
  const aliceList = await app.inject({ url: "/events", headers: ALICE });
  expect(aliceList.json().events).toHaveLength(1);
  const bobList = await app.inject({ url: "/events", headers: BOB });
  expect(bobList.json().events).toEqual([]);
  for (const response of [aliceList, bobList]) {
    expect(response.headers["cache-control"]).toBe("private, no-store");
  }
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    const result = await app.inject({
      method,
      url: `/events/${event.id}`,
      headers: BOB,
      ...(method === "PATCH" ? { body: { version: 1, title: "Stolen" } } : {}),
    });
    expect(result.statusCode).toBe(404);
  }
  const calendar = await app.inject({
    url: "/events/export.ics",
    headers: BOB,
  });
  expect(calendar.statusCode).toBe(200);
  expect(calendar.body).not.toContain("BEGIN:VEVENT");
  expect(calendar.body).not.toContain(event.id);
  expect(
    (await app.inject({ url: `/events/${event.id}`, headers: ALICE })).json()
      .title,
  ).toBe(input.title);
});

test("every event endpoint requires authentication", async () => {
  const id = new ObjectId().toHexString();
  for (const credentials of [undefined, "Bearer invalid-token"]) {
    for (const endpoint of [
      { method: "GET", url: "/events" },
      { method: "GET", url: "/events/export.ics" },
      { method: "GET", url: `/events/${id}` },
      { method: "POST", url: "/events", body: input },
      {
        method: "PATCH",
        url: `/events/${id}`,
        body: { version: 1, title: "x" },
      },
      { method: "DELETE", url: `/events/${id}` },
    ] as const) {
      const response = await app.inject({
        ...endpoint,
        headers: credentials ? { authorization: credentials } : {},
      });
      expect(response.statusCode).toBe(401);
    }
  }
});

test.each([
  { title: "" },
  { title: 123 },
  { title: null },
  { title: "bad\u0000title" },
  { description: "bad\u0000description" },
  { startsAt: "2026-09-21T23:59:60Z" },
  { startsAt: "2026-09-21T23:59:59+24:00" },
  { title: " \t\n " },
  { title: "x".repeat(201) },
  { startsAt: "2026-09-21T10:00:00" },
  { startsAt: "2026-02-30T10:00:00Z" },
  { startsAt: "2026-09-21T02:00:00.001Z" },
  { endsAt: input.startsAt },
  { endsAt: "2026-09-20T00:00:00Z" },
  { owner: "bob" },
  { unexpected: "value" },
])("invalid create payload is rejected: %j", async (changes) => {
  const response = await app.inject({
    method: "POST",
    url: "/events",
    headers: ALICE,
    body: { ...input, ...changes },
  });
  expect(response.statusCode).toBe(400);
  expect(await app.collections.events.countDocuments()).toBe(0);
});

test("invalid IDs and missing events produce client errors", async () => {
  for (const method of ["GET", "PATCH", "DELETE"] as const) {
    for (const [id, expected] of [
      ["not-an-id", 400],
      [new ObjectId().toHexString(), 404],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/events/${id}`,
        headers: ALICE,
        ...(method === "PATCH"
          ? { body: { version: 1, title: "Update" } }
          : {}),
      });
      expect(response.statusCode).toBe(expected);
    }
  }
});

test("patch validates the merged interval and requires a meaningful versioned edit", async () => {
  const event = await create();
  for (const body of [
    {},
    { version: 1 },
    { title: "x" },
    { version: 1, owner: "bob" },
    { version: 1, startsAt: "2026-09-21T04:00:00Z" },
  ]) {
    const response = await app.inject({
      method: "PATCH",
      url: `/events/${event.id}`,
      headers: ALICE,
      body,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(
    (await app.inject({ url: `/events/${event.id}`, headers: ALICE })).json()
      .version,
  ).toBe(1);
});

test("concurrent updates cannot overwrite one another; stale retries return 409", async () => {
  const event = await create();
  const responses = await Promise.all(
    ["First", "Second"].map((title) =>
      app.inject({
        method: "PATCH",
        url: `/events/${event.id}`,
        headers: ALICE,
        body: { version: 1, title },
      }),
    ),
  );
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  const stored = (
    await app.inject({ url: `/events/${event.id}`, headers: ALICE })
  ).json();
  expect(stored.version).toBe(2);
  expect(stored.title).toBe(
    responses.find((response) => response.statusCode === 200)!.json().title,
  );
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/events/${event.id}`,
        headers: ALICE,
        body: { version: 1, title: "Stale" },
      })
    ).statusCode,
  ).toBe(409);
});

test("range filters use interval overlap and exclude touching boundaries", async () => {
  await create(); // 02:00-03:00 UTC
  await create({
    ...input,
    title: "Spanning",
    startsAt: "2026-09-20T00:00:00Z",
    endsAt: "2026-09-22T00:00:00Z",
  });
  const cases = [
    ["from=2026-09-21T03:00:00Z&to=2026-09-21T04:00:00Z", 1],
    ["from=2026-09-21T01:00:00Z&to=2026-09-21T02:00:00Z", 1],
    ["from=2026-09-21T02:30:00Z&to=2026-09-21T02:45:00Z", 2],
    ["from=2026-09-22T00:00:00Z", 0],
    ["to=2026-09-20T00:00:00Z", 0],
  ] as const;
  for (const [query, count] of cases) {
    expect(
      (await app.inject({ url: `/events?${query}`, headers: ALICE })).json()
        .events,
    ).toHaveLength(count);
    const calendar = await app.inject({
      url: `/events/export.ics?${query}`,
      headers: ALICE,
    });
    expect(
      new ICAL.Component(ICAL.parse(calendar.body)).getAllSubcomponents(
        "vevent",
      ),
    ).toHaveLength(count);
  }
});

test("pagination has stable tie ordering, integer limits and hasMore", async () => {
  const ids = await Promise.all([1, 2, 3].map(async () => (await create()).id));
  const first = await app.inject({
    url: "/events?limit=2&offset=0",
    headers: ALICE,
  });
  const second = await app.inject({
    url: "/events?limit=2&offset=2",
    headers: ALICE,
  });
  expect(first.json().hasMore).toBe(true);
  expect(second.json().hasMore).toBe(false);
  expect(
    [...first.json().events, ...second.json().events].map((event) => event.id),
  ).toEqual(ids.sort());
  for (const query of [
    "limit=1.5",
    "offset=0.5",
    "limit=101",
    "limit=0",
    "offset=-1",
    "offset=10001",
    "owner=bob",
    "from=garbage",
    "from=2026-09-22T00:00:00Z&to=2026-09-21T00:00:00Z",
  ]) {
    expect(
      (await app.inject({ url: `/events?${query}`, headers: ALICE }))
        .statusCode,
    ).toBe(400);
  }
});

test("iCalendar roundtrips Unicode and escaped text with stable UID and UTC dates", async () => {
  const title = "学习📅".repeat(40);
  const description = "comma, semi; slash\\ and\r\nBEGIN:VEVENT\nline two";
  const event = await create({ ...input, title, description });
  const exported = await app.inject({
    url: "/events/export.ics",
    headers: ALICE,
  });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers["content-type"]).toContain("text/calendar");
  expect(exported.headers["content-disposition"]).toContain("timetable.ics");
  expect(exported.headers["cache-control"]).toBe("private, no-store");
  for (const line of exported.body.split("\r\n"))
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  const parsed = new ICAL.Component(ICAL.parse(exported.body));
  expect(parsed.getAllSubcomponents("vevent")).toHaveLength(1);
  const parsedEvent = new ICAL.Event(parsed.getFirstSubcomponent("vevent")!);
  expect(parsedEvent.summary).toBe(title);
  expect(parsedEvent.description).toBe(description.replace(/\r\n/g, "\n"));
  expect(parsedEvent.startDate.toJSDate().toISOString()).toBe(event.startsAt);
  expect(parsedEvent.endDate.toJSDate().toISOString()).toBe(event.endsAt);
  expect(parsedEvent.uid).toContain(event.id);
  const again = await app.inject({ url: "/events/export.ics", headers: ALICE });
  expect(again.body).toBe(exported.body);
});

test("export refuses oversized calendars instead of silently truncating", async () => {
  const now = new Date();
  await app.collections.events.insertMany(
    Array.from({ length: 1001 }, () => ({
      owner: "alice",
      title: "Bulk",
      description: null,
      location: null,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      createdAt: now,
      updatedAt: now,
      version: 1,
    })),
  );
  expect(
    (await app.inject({ url: "/events/export.ics", headers: ALICE }))
      .statusCode,
  ).toBe(413);
  expect(
    (
      await app.inject({
        url: "/events/export.ics?from=2027-01-01T00:00:00Z",
        headers: ALICE,
      })
    ).statusCode,
  ).toBe(200);
});

test("health and generated OpenAPI describe the running service", async () => {
  expect(
    (await app.inject({ url: "/health" })).json<{ status: string }>(),
  ).toEqual({
    status: "ok",
  });
  const spec = (await app.inject({ url: "/documentation/json" })).json();
  expect(spec.paths["/events"].post.security).toEqual([{ Auth: [] }]);
  expect(spec.paths["/events/{id}"].patch.responses["409"]).toBeDefined();
  expect(spec.paths["/events/export.ics"].get).toBeDefined();
});
