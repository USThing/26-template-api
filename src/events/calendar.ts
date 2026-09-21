import type { WithId } from "mongodb";
import type { EventDocument } from "./model.js";

const utc = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

// RFC 5545 TEXT escaping prevents user text from introducing new properties.
const escapeText = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");

/** Fold at 75 UTF-8 octets, never splitting a multi-byte code point. */
function foldLine(line: string): string {
  let result = "";
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (octets + size > 75) {
      result += "\r\n ";
      octets = 1;
    }
    result += character;
    octets += size;
  }
  return result;
}

export function exportCalendar(events: WithId<EventDocument>[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Weilin Du//Custom Timetable//EN",
    "CALSCALE:GREGORIAN",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `UID:${event._id.toHexString()}@custom-timetable.local`,
      `DTSTAMP:${utc(event.updatedAt)}`,
      `CREATED:${utc(event.createdAt)}`,
      `LAST-MODIFIED:${utc(event.updatedAt)}`,
      `SEQUENCE:${event.version - 1}`,
      `DTSTART:${utc(event.startsAt)}`,
      `DTEND:${utc(event.endsAt)}`,
      `SUMMARY:${escapeText(event.title)}`,
      ...(event.description === null
        ? []
        : [`DESCRIPTION:${escapeText(event.description)}`]),
      ...(event.location === null
        ? []
        : [`LOCATION:${escapeText(event.location)}`]),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
