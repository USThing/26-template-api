import type { FastifyPluginAsync } from "fastify";
import { ObjectId } from "mongodb";
import { Type } from "typebox";
import type { FastifyTypebox } from "../../app.js";
import type { TodoDocument } from "../../plugins/init-mongo.js";

const TodoCreate = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  dueDate: Type.Optional(
    Type.Union([Type.Null(), Type.String({ format: "date-time" })]),
  ),
});

const TodoUpdate = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  done: Type.Optional(Type.Boolean()),
  dueDate: Type.Optional(Type.String({ format: "date-time" })),
});

const TodoListQuery = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  offset: Type.Optional(Type.Number({ minimum: 0 })),
});

const TodoParams = Type.Object({
  id: Type.String(),
});

const TodoReply = Type.Object({
  id: Type.String(),
  user: Type.String(),
  title: Type.String(),
  done: Type.Boolean(),
  dueDate: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const TodoListReply = Type.Object({
  todos: Type.Array(TodoReply),
  total: Type.Number(),
});

/** A stored todo shaped for the API: ObjectId and Dates become strings. */
interface ApiTodo {
  id: string;
  user: string;
  title: string;
  done: boolean;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

function toApiTodo(doc: TodoDocument): ApiTodo {
  return {
    id: doc._id?.toString() ?? "",
    user: doc.user,
    title: doc.title,
    done: doc.done,
    dueDate: doc.dueDate,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const todos: FastifyPluginAsync = async (
  fastify: FastifyTypebox,
): Promise<void> => {
  // Todo lists are polled frequently (dashboards, tabs left open) while the
  // collection only changes on writes, so repeated identical list queries
  // should not re-hit MongoDB. Writes clear the cache, keeping responses
  // consistent with the store after every mutation.
  const LIST_CACHE_TTL_MS = 15_000;
  const listCache = new Map<
    string,
    { response: { todos: ApiTodo[]; total: number }; expiresAt: number }
  >();

  fastify.withAuth(async (fastify) => {
    fastify.get(
      "/",
      {
        schema: {
          summary: "List Todos",
          description: "List the authenticated user's todos, newest first.",
          tags: ["Todos"],
          querystring: TodoListQuery,
          response: { 200: TodoListReply },
        },
      },
      async (request, reply) => {
        const user = request.user.username;
        const limit = request.query.limit ?? 20;
        const offset = request.query.offset ?? 0;
        const cacheKey = `${offset}:${limit}`;

        const cached = listCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.response;
        }

        const collection = fastify.collections.todos;
        const [docs, total] = await Promise.all([
          collection
            .find({ user })
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit)
            .toArray(),
          collection.countDocuments({ user }),
        ]);

        const response = { todos: docs.map(toApiTodo), total };
        listCache.set(cacheKey, {
          response,
          expiresAt: Date.now() + LIST_CACHE_TTL_MS,
        });
        // Lists are per-user and only change on writes, so short-lived
        // client caching is safe here.
        reply.header("cache-control", "public, max-age=60");
        return response;
      },
    );

    fastify.post(
      "/",
      {
        schema: {
          summary: "Create Todo",
          tags: ["Todos"],
          body: TodoCreate,
          response: { 201: TodoReply },
        },
      },
      async (request, reply) => {
        const now = new Date();
        const doc: TodoDocument = {
          user: request.user.username,
          title: request.body.title,
          done: false,
          dueDate: request.body.dueDate ?? null,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = await fastify.collections.todos.insertOne(doc);
        // Writes clear the list cache so later reads see the new todo.
        listCache.clear();
        return reply.code(201).send(
          toApiTodo({
            ...doc,
            _id: inserted.insertedId,
          }),
        );
      },
    );

    fastify.get(
      "/:id",
      {
        schema: {
          summary: "Get Todo",
          tags: ["Todos"],
          params: TodoParams,
          response: { 200: TodoReply },
        },
      },
      async (request, reply) => {
        let id: object;
        try {
          id = new ObjectId(request.params.id);
        } catch {
          return reply.notFound("Todo not found");
        }

        const doc = await fastify.collections.todos.findOne({
          _id: id,
          user: request.user.username,
        });
        if (doc === null) {
          return reply.notFound("Todo not found");
        }
        return toApiTodo(doc);
      },
    );

    fastify.patch(
      "/:id",
      {
        schema: {
          summary: "Update Todo",
          tags: ["Todos"],
          params: TodoParams,
          body: TodoUpdate,
          response: { 200: TodoReply },
        },
      },
      async (request, reply) => {
        let id: object;
        try {
          id = new ObjectId(request.params.id);
        } catch {
          return reply.notFound("Todo not found");
        }

        const $set: Partial<TodoDocument> = { updatedAt: new Date() };
        if (request.body.title !== undefined) {
          $set.title = request.body.title;
        }
        if (request.body.done !== undefined) {
          $set.done = request.body.done;
        }
        if (request.body.dueDate !== undefined) {
          $set.dueDate = request.body.dueDate;
        }

        const doc = await fastify.collections.todos.findOneAndUpdate(
          { _id: id, user: request.user.username },
          { $set },
          { returnDocument: "after" },
        );
        if (doc === null) {
          return reply.notFound("Todo not found");
        }
        // Writes clear the list cache so later reads see the update.
        listCache.clear();
        return toApiTodo(doc);
      },
    );

    fastify.delete(
      "/:id",
      {
        schema: {
          summary: "Delete Todo",
          tags: ["Todos"],
          params: TodoParams,
        },
      },
      async (request, reply) => {
        let id: object;
        try {
          id = new ObjectId(request.params.id);
        } catch {
          return reply.notFound("Todo not found");
        }

        const result = await fastify.collections.todos.deleteOne({
          _id: id,
          user: request.user.username,
        });
        if (result.deletedCount === 0) {
          return reply.notFound("Todo not found");
        }
        // Writes clear the list cache so later reads see the deletion.
        listCache.clear();
        return reply.code(204).send();
      },
    );
  });
};

export default todos;
