/**
 * A user defined in the static internal token table.
 *
 * Identities are declared in code; requests authenticate by presenting the
 * bearer token of one of these users.
 */
export type InternalUser = {
  /** The user's username exposed on `request.user` inside `withAuth` scopes. */
  username: string;
  /** The user's display name; may be null. */
  name: string | null;
  /**
   * The bearer token the user authenticates with. Tokens act as passwords:
   * replace these samples before deploying and never commit real secrets.
   */
  token: string;
};

// Sample users for local development and tests. These tokens act as passwords
// and must be replaced with real secrets before any real deployment.
export const users: InternalUser[] = [
  { username: "alice", name: "Alice", token: "alice-dev-token" },
  { username: "bob", name: "Bob", token: "bob-dev-token" },
];

/** Optional JSON token table; production must supply non-demo credentials. */
export function loadUsers(
  value: string | undefined,
  production = false,
): InternalUser[] {
  if (!value?.trim()) {
    if (production) throw new Error("AUTH_USERS is required in production");
    return users;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "AUTH_USERS must be a JSON array of username/name/token objects",
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AUTH_USERS must contain at least one user");
  }
  const usernames = new Set<string>();
  const tokens = new Set<string>();
  return parsed.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("username" in entry) ||
      typeof entry.username !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.username) ||
      !("token" in entry) ||
      typeof entry.token !== "string" ||
      !/^[\x21-\x7e]{16,256}$/.test(entry.token) ||
      !("name" in entry) ||
      (entry.name !== null && typeof entry.name !== "string")
    ) {
      throw new Error(
        "Invalid AUTH_USERS entry: username, name and a 16-256 character non-space ASCII token are required",
      );
    }
    if (usernames.has(entry.username) || tokens.has(entry.token))
      throw new Error("AUTH_USERS usernames and tokens must be unique");
    if (production && users.some((user) => user.token === entry.token))
      throw new Error("Demo tokens cannot be used in production");
    usernames.add(entry.username);
    tokens.add(entry.token);
    return { username: entry.username, name: entry.name, token: entry.token };
  });
}
