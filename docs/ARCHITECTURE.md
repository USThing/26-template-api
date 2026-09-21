# Design decisions

## Boundaries and data flow

The service extends the supplied Fastify template and keeps its MongoDB lifecycle, bearer-authentication scope and generated OpenAPI infrastructure. `src/server.ts` loads configuration and handles process signals. Autoload registers infrastructure plugins and HTTP routes. Example endpoints/collections were removed; their auth-contract tests use small test-only routes.

```text
HTTP request
  -> bearer authentication (request.user)
  -> schema validation
  -> event route (ownership + interval/version rules)
  -> MongoDB events collection
  -> explicit API representation / iCalendar serialization
```

- `src/events/schemas.ts`: request and response contracts.
- `src/events/model.ts`: database shape and explicit response mapping.
- `src/events/calendar.ts`: small iCalendar serializer for the supported event subset.
- `src/routes/events/index.ts`: CRUD, range queries, export and optimistic updates.
- `src/plugins/init-mongo.ts`: connection lifecycle and collection/index setup.
- `src/auth/users.ts`: validated token configuration; the template auth plugin verifies tokens.

There is no generic repository layer: the handful of MongoDB operations are short and benefit from being visible alongside their owner selectors. Tests exercise them against a real database instead of mocking the persistence boundary.

## Stored event

| Field | Storage / rule |
| --- | --- |
| `_id` | MongoDB ObjectId; serialized as `id` |
| `owner` | Stable username from the verified token; not returned or editable |
| `title` | Trimmed, nonblank, at most 200 characters |
| `description`, `location` | Nullable text |
| `startsAt`, `endsAt` | BSON Dates; start strictly earlier than end |
| `createdAt`, `updatedAt` | Server-generated BSON Dates |
| `version` | Integer starting at 1 and incremented on update |

`{owner: 1, startsAt: 1, _id: 1}` supports the owner prefix and list ordering, with an upper start-time bound where supplied. The overlap condition on `endsAt` is an additional filter; one compound index does not optimize both arbitrary range bounds fully. This tradeoff is sufficient for a personal timetable. The built-in unique `_id` index supports item operations. Renaming usernames requires an explicit data migration because ownership uses the username.

UTC instants avoid ambiguous local times. Clients select an offset for input and render the result in their timezone (for example, Asia/Hong_Kong). This implementation models timed, non-recurring events. All-day events, recurrence rules, university schedule integration and timezone-aware recurrence expansion are deliberately outside scope. Event overlaps are allowed.

## Isolation and concurrency

Every database read/write includes the authenticated owner. Missing and foreign-owned IDs both return 404. Callers cannot mass-assign owner, timestamps or version. All JSON bodies use strict Ajv validation without type coercion; query parameters retain Fastify's normal numeric parsing. Unknown fields are rejected.

PATCH reads the owned document, checks the submitted version, merges editable fields, validates the resulting interval, then atomically updates with `{_id, owner, version}` in the selector. A competing edit or delete makes the final update return no document, producing 409. This protects against both stale-client overwrites and races between validation and persistence without a multi-document transaction. See MongoDB's [single-document atomicity documentation](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).

DELETE is an owner-scoped, unconditional deletion. There is no promise of a frozen collection across multiple list requests. Responses fetch `limit + 1` documents to derive `hasMore`, avoiding a separate count that could disagree with the list during writes.

No application list cache is introduced. Private/no-store response headers keep personal event data out of HTTP caches. Tokens are compared using the template's fixed-length SHA-256 digests and timing-safe comparison; tokens are excluded from request logs. Production configuration requires an explicit token table, while local development has documented demo users.

## Extra features

Time-window filtering selects interval overlaps, including events spanning the entire requested window. Adjacent events ending at `from` or starting at `to` are excluded.

The `.ics` export follows the supported subset of [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545): VCALENDAR/VEVENT wrappers, stable event UID, UTC DTSTART/DTEND, timestamps, sequence number and text fields. Text is escaped before folding content lines at 75 UTF-8 octets; line endings are CRLF and code points are not split. The tests parse output using `ical.js` and check the original Unicode/text values. A 1000-event limit bounds export work and returns an explicit error instead of truncating. Re-import handling depends on the calendar client; no synchronization or cancellation protocol is claimed.

## Operations and limitations

Development/tests use a temporary real MongoDB process. Production uses an existing database; Compose supplies one with a persistent volume. The API Dockerfile installs only runtime dependencies, runs without root, and has a readiness healthcheck. SIGINT/SIGTERM close the application and its database connection.

Before hosting for real users, add managed identity/token rotation, rate limits, database authentication/backups, TLS and monitoring. An event list is capped and offsets are bounded, but the service does not enforce a per-user storage quota. Static tokens and the local Compose network are deliberate technical-test choices, not a claim of a complete production identity or operations system.
