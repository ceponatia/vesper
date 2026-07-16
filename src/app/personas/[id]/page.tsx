import type { Metadata } from "next";
import { PersonaEditPage } from "@/components/personas/persona-edit-page";

export const metadata: Metadata = { title: "Persona" };

export default async function PersonaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonaEditPage personaId={id} />;
}
