import type { Metadata } from "next";
import { CharacterForgePage } from "@/components/characters/character-forge-page";

export const metadata: Metadata = { title: "Character forge" };

export default function CharactersForgeRoute() {
  return <CharacterForgePage />;
}
