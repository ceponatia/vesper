import type { ReactNode } from "react";

export type NavIconName =
  | "home"
  | "chats"
  | "worlds"
  | "library"
  | "characters"
  | "locations"
  | "items"
  | "social-cards"
  | "gallery"
  | "more"
  | "menu";

/** Inner SVG geometry per icon (stroke-based, 24×24 box). */
const PATHS: Record<NavIconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M9 21v-6h6v6" />
    </>
  ),
  chats: (
    <>
      <path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5c-1.3 0-2.5-.3-3.6-.8L4 20.5l1.3-4.4A7.5 7.5 0 1 1 20 12.5z" />
      <path d="M9 11.5h6M9 14.5h3.5" />
    </>
  ),
  worlds: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
    </>
  ),
  library: (
    <>
      <path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v14c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-14c-4.5 0-6.5-.5-8 2z" />
      <path d="M12 6.5v14" />
    </>
  ),
  characters: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1.4-4 4.4-6 7.5-6s6.1 2 7.5 6" />
    </>
  ),
  locations: (
    <>
      <path d="M12 21s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  items: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  "social-cards": (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  gallery: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
};

/** A nav glyph. Stroke inherits currentColor; size via the className font/size. */
export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
