import type { Metadata } from "next";
import { WorldForgePage } from "@/components/worlds/world-forge-page";

export const metadata: Metadata = { title: "World forge" };

export default function WorldsForgeRoute() {
  return <WorldForgePage />;
}
