import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans-base", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif-base", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Vesper", template: "%s · Vesper" },
  description: "Forge worlds and characters, then play turn-based sessions with a living world model.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className="flex min-h-screen flex-col">
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
