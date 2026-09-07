import type { Metadata } from "next";
import { CharacterForgePage } from "@/components/characters/character-forge-page";

export const metadata: Metadata = { title: "New character" };
export default function CharacterNewRoute() { return <CharacterForgePage mode="manual" />; }
