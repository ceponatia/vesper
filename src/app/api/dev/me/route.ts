import { listUsers } from "@/server/auth";
import { jsonOk, withUser } from "@/server/api";

/** Dev identity panel: the resolved user plus everyone switchable. */
export const GET = withUser(async (user) => {
  const users = await listUsers();
  return jsonOk({ user, users });
});
