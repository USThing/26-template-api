import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FastifyPluginAsync, FastifySchemaCompiler } from "fastify";
import { type Filter, ObjectId } from "mongodb";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import { exportCalendar } from "../../events/calendar.js";
import { type EventDocument, toApiEvent } from "../../events/model.js";
import {
  EventCreate,
  EventListQuery,
  EventListReply,
  EventParams,
  EventReply,
  EventUpdate,
  RangeQuery,
} from "../../events/schemas.js";
import { HttpError } from "../../plugins/sensible.js";

const metadata = { tags: ["Events"], security: [{ Auth: [] }] };
// Bodies must retain JSON types (especially explicit null); query parameters
// still use Fastify's numeric coercion because they arrive as URL strings.
const bodyValidator = new Ajv({ coerceTypes: false, allErrors: false });
addFormats(bodyValidator);
const validateBody: FastifySchemaCompiler<object> = ({ schema }) =>
  bodyValidator.compile(schema);

const events: FastifyPluginAsync = async (fastify: FastifyTypebox) => {
  fastify.withAuth(async (scope) => {
    scope.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
    });

    function filterFor(owner: string, range: { from?: string; to?: string }) {
      const from = range.from ? new Date(range.from) : undefined;
      const to = range.to ? new Date(range.to) : undefined;
      if (from && to && from >= to) {
        throw scope.httpErrors.badRequest("from must be before to");
      }
      // Half-open overlap: an event ending exactly at `from` is outside.
      const filter: Filter<EventDocument> = { owner };
      if (from) filter.endsAt = { $gt: from };
      if (to) filter.startsAt = { $lt: to };
      return filter;
    }

    scope.get(
      "/",
      {
        prefixTrailingSlash: "no-slash",
        schema: {
          ...metadata,
          summary: "List your events in start-time order",
          description:
            "Optional [from, to) overlap filter. Defaults: limit=20, offset=0.",
          querystring: EventListQuery,
          response: { 200: EventListReply, 400: HttpError },
        },
      },
      async (request) => {
        const limit = request.query.limit ?? 20;
        const offset = request.query.offset ?? 0;
        const docs = await scope.collections.events
          .find(filterFor(request.user.username, request.query))
          .sort({ startsAt: 1, _id: 1 })
          .skip(offset)
          .limit(limit + 1)
          .toArray();
        return {
          events: docs.slice(0, limit).map(toApiEvent),
          limit,
          offset,
          hasMore: docs.length > limit,
        };
      },
    );

    scope.get(
      "/export.ics",
      {
        schema: {
          ...metadata,
          summary: "Export your events as an iCalendar file",
          description:
            "Exports all matching events, up to 1000; narrow the date range if exceeded.",
          querystring: RangeQuery,
          produces: ["text/calendar"],
          response: { 200: Type.String(), 400: HttpError, 413: HttpError },
        },
      },
      async (request, reply) => {
        const docs = await scope.collections.events
          .find(filterFor(request.user.username, request.query))
          .sort({ startsAt: 1, _id: 1 })
          .limit(1001)
          .toArray();
        if (docs.length > 1000) {
          throw scope.httpErrors.payloadTooLarge(
            "Export exceeds 1000 events; narrow from/to",
          );
        }
        return reply
          .type("text/calendar; charset=utf-8")
          .header("Content-Disposition", 'attachment; filename="timetable.ics"')
          .send(exportCalendar(docs));
      },
    );

    scope.post(
      "/",
      {
        prefixTrailingSlash: "no-slash",
        validatorCompiler: validateBody,
        schema: {
          ...metadata,
          summary: "Create an event",
          body: EventCreate,
          response: { 201: EventReply, 400: HttpError },
        },
      },
      async (request, reply) => {
        const startsAt = new Date(request.body.startsAt);
        const endsAt = new Date(request.body.endsAt);
        if (startsAt >= endsAt)
          throw scope.httpErrors.badRequest("startsAt must be before endsAt");
        const now = new Date();
        const event: EventDocument = {
          owner: request.user.username,
          title: request.body.title.trim(),
          description: request.body.description ?? null,
          location: request.body.location ?? null,
          startsAt,
          endsAt,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        const { insertedId } = await scope.collections.events.insertOne(event);
        return reply
          .code(201)
          .header("Location", `/events/${insertedId.toHexString()}`)
          .send(toApiEvent({ ...event, _id: insertedId }));
      },
    );

    scope.get(
      "/:id",
      {
        schema: {
          ...metadata,
          summary: "Read an event",
          params: EventParams,
          response: { 200: EventReply, 400: HttpError, 404: HttpError },
        },
      },
      async (request) => {
        const event = await scope.collections.events.findOne({
          _id: new ObjectId(request.params.id),
          owner: request.user.username,
        });
        if (!event) throw scope.httpErrors.notFound("Event not found");
        return toApiEvent(event);
      },
    );

    scope.patch(
      "/:id",
      {
        validatorCompiler: validateBody,
        schema: {
          ...metadata,
          summary: "Update an event using its current version",
          description:
            "Send version from your last read and at least one editable field. Stale versions return 409.",
          params: EventParams,
          body: EventUpdate,
          response: {
            200: EventReply,
            400: HttpError,
            404: HttpError,
            409: HttpError,
          },
        },
      },
      async (request) => {
        const selector = {
          _id: new ObjectId(request.params.id),
          owner: request.user.username,
        };
        const current = await scope.collections.events.findOne(selector);
        if (!current) throw scope.httpErrors.notFound("Event not found");
        if (current.version !== request.body.version)
          throw scope.httpErrors.conflict(
            "Event changed; read it again before updating",
          );
        const changes = {
          title: request.body.title?.trim() ?? current.title,
          description:
            request.body.description === undefined
              ? current.description
              : request.body.description,
          location:
            request.body.location === undefined
              ? current.location
              : request.body.location,
          startsAt:
            request.body.startsAt === undefined
              ? current.startsAt
              : new Date(request.body.startsAt),
          endsAt:
            request.body.endsAt === undefined
              ? current.endsAt
              : new Date(request.body.endsAt),
          updatedAt: new Date(),
        };
        if (changes.startsAt >= changes.endsAt)
          throw scope.httpErrors.badRequest("startsAt must be before endsAt");
        // Compare-and-swap protects both the merged interval and concurrent edits.
        const updated = await scope.collections.events.findOneAndUpdate(
          { ...selector, version: current.version },
          { $set: changes, $inc: { version: 1 } },
          { returnDocument: "after" },
        );
        if (!updated)
          throw scope.httpErrors.conflict(
            "Event changed or was deleted; read it again",
          );
        return toApiEvent(updated);
      },
    );

    scope.delete(
      "/:id",
      {
        schema: {
          ...metadata,
          summary: "Delete an event",
          params: EventParams,
          response: { 204: Type.Null(), 400: HttpError, 404: HttpError },
        },
      },
      async (request, reply) => {
        const result = await scope.collections.events.deleteOne({
          _id: new ObjectId(request.params.id),
          owner: request.user.username,
        });
        if (result.deletedCount === 0)
          throw scope.httpErrors.notFound("Event not found");
        return reply.code(204).send(null);
      },
    );
  });
};

export default events;
