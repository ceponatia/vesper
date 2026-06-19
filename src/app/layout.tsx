import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { CONTRAST_STORAGE_KEY } from "@/lib/contrast-theme";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans-base", display: "swap" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--font-serif-base", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Vesper", template: "%s · Vesper" },
  description: "Forge worlds and characters, then play turn-based sessions with a living world model.",
};

/**
 * Apply the stored high-contrast preference before first paint (no flash) by
 * setting data-contrast on <html> synchronously (UX-audit M6). Static string,
 * no user input. <html> gets suppressHydrationWarning because this runs before
 * React hydrates and mutates that element's attributes.
 */
const contrastScript = `(function(){try{if(localStorage.getItem('${CONTRAST_STORAGE_KEY}')==='high'){document.documentElement.dataset.contrast='high';}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <script dangerouslySetInnerHTML={{ __html: contrastScript }} />
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
