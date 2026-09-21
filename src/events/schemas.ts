import { Type } from "typebox";

// Whole seconds ensure that the API and iCalendar represent identical intervals.
const timestamp = Type.String({
  format: "date-time",
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.0{1,3})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$",
  description: "RFC 3339 timestamp with timezone and whole-second precision.",
});
const nullableText = (maxLength: number) =>
  Type.Union([
    Type.String({
      maxLength,
      pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$",
    }),
    Type.Null(),
  ]);
const fields = {
  title: Type.String({
    minLength: 1,
    maxLength: 200,
    pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
  }),
  description: Type.Optional(nullableText(4000)),
  location: Type.Optional(nullableText(300)),
  startsAt: timestamp,
  endsAt: timestamp,
};
export const EventCreate = Type.Object(fields, { additionalProperties: false });
export const EventUpdate = Type.Object(
  {
    ...Type.Partial(Type.Object(fields)).properties,
    version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false, minProperties: 2 },
);
export const EventParams = Type.Object({
  id: Type.String({ pattern: "^[a-fA-F0-9]{24}$" }),
});
export const RangeQuery = Type.Object(
  { from: Type.Optional(timestamp), to: Type.Optional(timestamp) },
  { additionalProperties: false },
);
export const EventListQuery = Type.Object(
  {
    ...RangeQuery.properties,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  },
  { additionalProperties: false },
);
export const EventReply = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: nullableText(4000),
  location: nullableText(300),
  startsAt: Type.String({ format: "date-time" }),
  endsAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  version: Type.Integer(),
});
export const EventListReply = Type.Object({
  events: Type.Array(EventReply),
  limit: Type.Integer(),
  offset: Type.Integer(),
  hasMore: Type.Boolean(),
});
