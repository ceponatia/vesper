import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Locations" };

export default function LocationsPage() {
  return <EntityLibrary entity="locations" />;
}
