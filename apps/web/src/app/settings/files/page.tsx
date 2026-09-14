import type { Metadata } from "next";
import { FilesPage } from "@/components/settings/files-page";

export const metadata: Metadata = { title: "Files" };

/** Owner-admin temporary file-sharing utility. Backing APIs enforce the real gate. */
export default function FilesRoute() {
  return <FilesPage />;
}
