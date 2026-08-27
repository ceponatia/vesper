import type { Metadata } from "next";
import { SuccessorWorldsPage } from "@/components/worlds/successor-worlds-page";

export const metadata: Metadata = { title: "Worlds" };

/**
 * The successor engine's front door (owner ruling 2026-07-22): create and open
 * successor-engine chats, each in its own fresh world. Replaces the deprecated
 * world-model library that lived here.
 */
export default function WorldsPage() {
  return <SuccessorWorldsPage />;
}
