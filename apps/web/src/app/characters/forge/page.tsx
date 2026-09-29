import { redirect } from "next/navigation";

/** Forge creates a blank character and opens it directly (`use-forge-character.ts`);
 * this route creates nothing. */
export default function CharactersForgeRoute() {
  redirect("/characters");
}
