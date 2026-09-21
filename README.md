# Custom Timetable API

USThing Backend Technical Test 2026 — Task 1. Built for Weilin Du on the supplied Fastify/TypeScript/MongoDB template (base commit `d9035fa`). See `AI_ASSISTANCE.md` before submitting this working draft.

This service stores each user's custom events, supports versioned updates, filters events overlapping a timetable window, and exports them as an iCalendar file. Existing university class schedules are out of scope.

## Run locally

Requires **Bun 1.4.2 or newer**. From this directory:

```sh
bun install --frozen-lockfile
bun run dev
```

No database setup is needed for development. The first run downloads a real MongoDB executable (approximately 150 MB); its temporary database is destroyed when the service stops. For persistent storage, use Docker Compose below or set `MONGO_URI` to an existing MongoDB database. The application listens on `127.0.0.1:3000` by default.

Without an `.env` file, two development accounts are available:

| User | Bearer token |
| --- | --- |
| alice | `alice-dev-token` |
| bob | `bob-dev-token` |

These are public demo credentials, not real secrets. If you copy `.env.example`, its `AUTH_USERS` table replaces these defaults; use the tokens in that file instead.

- Interactive API docs: <http://localhost:3000/documentation>
- Alternative API docs: <http://localhost:3000/reference>
- OpenAPI JSON: <http://localhost:3000/documentation/json>
- Database readiness: <http://localhost:3000/health>

## Run with Docker

Requires Docker Engine/Desktop and Compose v2.

```sh
cp .env.example .env
# Replace the example AUTH_USERS tokens for any non-local use.
docker compose up --build -d
docker compose ps
```

PowerShell: use `Copy-Item .env.example .env` for the first command. The example Alice token for this configuration is `alice-local-example-token-2026`.

Compose starts the API and MongoDB. MongoDB has a named persistent volume and no published port; the API port is bound only to host loopback. The API image runs as the non-root `bun` user with production-only dependencies. `docker compose stop` preserves the data. Containers are a local demonstration setup; a real deployment should provide TLS, database credentials/network controls and operational monitoring.

The authoring environment has no Docker engine, so **the image build and Compose runtime have not been executed**. The pinned image tags were checked in Docker Hub. Native production startup, authentication, real HTTP requests and application-restart persistence are tested automatically.

## API

Send `Authorization: Bearer <token>` on every `/events` request. Ownership comes solely from the authenticated user; it cannot be supplied in a request body or query.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/events` | Create an event; 201 plus `Location` |
| GET | `/events` | List your events; optional `from`, `to`, `limit`, `offset` |
| GET | `/events/:id` | Read one of your events |
| PATCH | `/events/:id` | Partial update with the last-read `version` |
| DELETE | `/events/:id` | Delete; 204 with no body |
| GET | `/events/export.ics` | Export all matching events; optional `from`, `to` |

### Create

Example for a shell with curl; in PowerShell use `curl.exe`, or `Invoke-RestMethod` with `ConvertTo-Json`.

```sh
curl -i http://localhost:3000/events \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Study group","description":"Review databases","location":"Library","startsAt":"2026-09-21T10:00:00+08:00","endsAt":"2026-09-21T11:00:00+08:00"}'
```

`title`, `startsAt` and `endsAt` are required. The response includes an ID, UTC timestamps, `createdAt`, `updatedAt`, and `version: 1`. `description` and `location` default to null.

Titles are trimmed, nonblank, single-line and limited to 200 characters. Description/location allow null and are limited to 4000/300 characters. Non-text control characters are rejected. Unknown fields are rejected. JSON body values are not coerced into another type.

Input timestamps must use uppercase `T` and `Z` (or an explicit numeric UTC offset), whole seconds and a valid calendar date. An optional all-zero fractional part (`.0`, `.00`, `.000`) is accepted, so response timestamps can be reused unchanged. Non-zero fractional seconds, leap seconds and timezone-free timestamps are rejected. Responses normalize dates to UTC with `.000Z`. `startsAt` must precede `endsAt`.

### List a timetable window

```sh
curl 'http://localhost:3000/events?from=2026-09-21T00:00:00Z&to=2026-09-28T00:00:00Z&limit=20&offset=0' \
  -H 'Authorization: Bearer alice-dev-token'
```

The filter selects events overlapping the half-open interval `[from, to)`: `event.endsAt > from` and `event.startsAt < to`. Either bound may be omitted. Touching endpoints do not overlap. If a query timestamp contains `+`, URL-encode it as `%2B`.

The response is `{ "events": [...], "limit": 20, "offset": 0, "hasMore": false }`. Sort order is `startsAt` ascending, then ID ascending. Limits are integers from 1 to 100; offsets are integers from 0 to 10000. The defaults are 20 and 0. Offset pagination can shift during concurrent writes; it is not a snapshot.

### Update or delete

```sh
curl -X PATCH http://localhost:3000/events/EVENT_ID \
  -H 'Authorization: Bearer alice-dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"title":"Updated study group","location":null}'

curl -i -X DELETE http://localhost:3000/events/EVENT_ID \
  -H 'Authorization: Bearer alice-dev-token'
```

PATCH requires the current version and at least one editable field. Omitted fields stay unchanged; null clears description/location. Each successful update increments the version. A stale or concurrently changed version returns 409: read again and deliberately reconcile the edit before retrying. Partial date updates are validated against the stored other endpoint. DELETE is unconditional with respect to version, but always owner-scoped.

### Export to a calendar

```sh
curl 'http://localhost:3000/events/export.ics?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z' \
  -H 'Authorization: Bearer alice-dev-token' -o timetable.ics
```

Import the file into a calendar application. Export includes every matching event, not just the first list page. More than 1000 matches returns 413 and asks for a narrower range; exports are never silently truncated. This is a file export, not a live calendar subscription or invitation service.

### Errors

| Status | Meaning |
| --- | --- |
| 400 | Invalid body/query/ID/time interval, or malformed authorization header |
| 401 | Missing or invalid bearer token |
| 404 | Event absent or owned by someone else |
| 409 | PATCH version no longer current, or deletion raced with PATCH |
| 413 | Request exceeds 32 KiB, or export exceeds 1000 events |

Resource and validation errors use Fastify's JSON error shape (`statusCode`, `error`, `message`, optionally `code`). The inherited authentication plugin returns text for authentication errors. OpenAPI documents both. Event responses use `Cache-Control: private, no-store`; there is no shared application cache.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3000`; container uses `0.0.0.0` internally |
| `MONGO_URI` | Temporary MongoDB in development; explicit URI recommended outside Compose |
| `MONGO_TEST_URI` | Optional dedicated test database when `test: true` is passed |
| `AUTH_USERS` | JSON array of `{username,name,token}`; development defaults to Alice/Bob |
| `AUTH_SKIP` | Off; bypass is only supported for development/tests |
| `NODE_ENV` | `production` requires `AUTH_USERS` and refuses `AUTH_SKIP=true` |

Usernames and tokens must be unique. Configured tokens must be 16–256 non-space ASCII characters. Generate long random tokens; never commit real credentials. The two short template demo tokens are only used by the development fallback. Static tokens intentionally keep authentication small; this service does not implement sign-up, SSO or account recovery.

## Checks

```sh
bun run compile
bun run check
bun run test
```

Tests use a real disposable MongoDB, Fastify injection, an independent iCalendar parser, and a production subprocess accessed over HTTP. They cover CRUD, authentication, user isolation, strict input validation, time boundaries, pagination, concurrent version conflicts, nullable updates, export limits/escaping/UTF-8 folding, OpenAPI and persistence across application restarts. No external account or database is required.

See [Architecture](docs/ARCHITECTURE.md) for implementation decisions and [Validation](docs/VALIDATION.md) for the recorded verification scope.
