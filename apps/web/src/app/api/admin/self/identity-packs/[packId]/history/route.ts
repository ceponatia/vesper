import { jsonOk } from "@/server/api";
import { withOwnPackHistory, type IdentityPackParams } from "../../owned";

/**
 * Every revision of the character behind one pack id.
 *
 * Newest first, and metadata only — geometry, versions, stable codes, review
 * actors and reasons. No image bytes and no URLs cross this boundary even for an
 * administrator; the hidden crop is named by id and fetched, if at all, through
 * the authorized image route.
 *
 * A row whose stored measurements do not parse degrades to a null crop with a
 * diagnostic rather than failing the read: an inspection surface that shows
 * nothing because one old revision is wrecked is useless precisely when it is
 * needed.
 */
export const GET = withOwnPackHistory<IdentityPackParams>(async (_user, history) =>
  jsonOk({ packId: history.packId, characterId: history.characterId, history: history.revisions }),
);
