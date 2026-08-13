import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Items" };

export default function ItemsPage() {
  return <EntityLibrary entity="items" />;
}
