import type { Metadata, Viewport } from "next";
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
 * `viewportFit: "cover"` lets the app paint into the iOS safe areas; the bottom
 * tab bar and the play-screen composer claim them back with
 * `env(safe-area-inset-bottom)`. `themeColor` = --color-ink-900 (app bg). No
 * `maximumScale`/`userScalable` — disabling zoom is an a11y regression.
 */
export const viewport: Viewport = {
  themeColor: "#0e0e12",
  viewportFit: "cover",
};

/**
 * Apply the stored high-contrast preference before first paint (no flash) by
 * setting data-contrast on <html> synchronously (UX-audit M6). Static string,
 * no user input. <html> gets suppressHydrationWarning because this runs before
 * React hydrates and mutates that element's attributes.
 */
const contrastScript = `(function(){try{if(localStorage.getItem('${CONTRAST_STORAGE_KEY}')==='high'){document.documentElement.dataset.contrast='high';}}catch(e){}})();`;

/**
 * Dev-only noise filter. Some mobile / in-app wallet browsers (MetaMask,
 * Coinbase Wallet, Brave…) inject a `window.ethereum` provider that throws
 * "undefined is not an object (window.ethereum.selectedAddress …)" at document
 * start. It's the injected script's bug, not ours, but Next's dev error overlay
 * counts every uncaught window error and shows "1 issue". A capture-phase
 * listener swallows just that error (narrow message match) before the overlay
 * sees it. Gated out of production builds, so it can never mask a real app error.
 */
const walletNoiseSilencer = `(function(){try{window.addEventListener('error',function(e){var m=(e&&e.message)||'';if(m.indexOf('ethereum')>-1||m.indexOf('selectedAddress')>-1){e.stopImmediatePropagation();e.preventDefault();}},true);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        {process.env.NODE_ENV !== "production" && (
          <script dangerouslySetInnerHTML={{ __html: walletNoiseSilencer }} />
        )}
        <script dangerouslySetInnerHTML={{ __html: contrastScript }} />
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
