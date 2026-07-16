import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Personas" };

export default function PersonasPage() {
  return <EntityLibrary entity="personas" />;
}
