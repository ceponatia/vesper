import { redirect } from "next/navigation";

/** Characters use the library's create-on-new path (`entity-library.tsx`
 * `createBlank`); this route creates nothing. */
export default function CharacterNewRoute() {
  redirect("/characters");
}
