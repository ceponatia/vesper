import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Characters" };

export default function CharactersPage() {
  return <EntityLibrary entity="characters" />;
}
