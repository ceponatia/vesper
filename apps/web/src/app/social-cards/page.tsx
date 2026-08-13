import type { Metadata } from "next";
import { EntityLibrary } from "@/components/library/entity-library";

export const metadata: Metadata = { title: "Social cards" };

export default function SocialCardsPage() {
  return <EntityLibrary entity="social-cards" />;
}
