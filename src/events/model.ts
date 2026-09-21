import type { ObjectId, WithId } from "mongodb";

export interface EventDocument {
  _id?: ObjectId;
  owner: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export function toApiEvent(event: WithId<EventDocument>) {
  return {
    id: event._id.toHexString(),
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    version: event.version,
  };
}
