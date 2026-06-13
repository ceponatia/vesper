import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, users } from "@/server/db";
import { USER_COOKIE } from "@/server/auth";
import { jsonError, readBody, withRoute } from "@/server/api";

const switchBodySchema = z.object({ userId: z.string().min(1) });

/** Dev-cookie identity switch (docs/streaming-api.md §Auth). */
export const POST = withRoute(async (req: NextRequest) => {
  const body = await readBody(req, switchBodySchema);
  if (!body.ok) return body.response;
  const [user] = await db().select().from(users).where(eq(users.id, body.value.userId)).limit(1);
  if (!user) return jsonError("not_found", "user not found", 404);

  const res = NextResponse.json({ user });
  res.cookies.set(USER_COOKIE, user.id, { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
});
