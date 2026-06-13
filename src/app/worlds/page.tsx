import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Worlds" };

export default function WorldsPage() {
  return <EntityLibrary entity="worlds" />;
}
