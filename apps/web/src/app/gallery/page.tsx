import type { Metadata } from "next";
import { GalleryPage } from "@/components/gallery/gallery-page";

export const metadata: Metadata = { title: "Gallery" };

export default function Gallery() {
  return <GalleryPage />;
}
