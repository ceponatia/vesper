import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, users } from "../db";

const COOKIE = "vesper_user";
const DEFAULT_EMAIL = "player@vesper.local";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
}

/**
 * Dev-cookie identity (docs/streaming-api.md §Auth). The cookie stores a user
 * id; absent/invalid cookies resolve to the default dev user (created on
 * demand). Replacing this module is the entire auth-migration surface.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const store = await cookies();
  const userId = store.get(COOKIE)?.value;
  if (userId) {
    const [row] = await db().select().from(users).where(eq(users.id, userId)).limit(1);
    if (row) return row;
  }
  return ensureDefaultUser();
}

export async function ensureDefaultUser(): Promise<CurrentUser> {
  const [existing] = await db().select().from(users).where(eq(users.email, DEFAULT_EMAIL)).limit(1);
  if (existing) return existing;
  const [created] = await db()
    .insert(users)
    .values({ email: DEFAULT_EMAIL, name: "Player", role: "admin" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db().select().from(users).where(eq(users.email, DEFAULT_EMAIL)).limit(1);
  if (!raced) throw new Error("failed to ensure default user");
  return raced;
}

export async function listUsers(): Promise<CurrentUser[]> {
  return db().select().from(users);
}

export const USER_COOKIE = COOKIE;
