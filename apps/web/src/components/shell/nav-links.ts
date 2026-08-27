import type { NavIconName } from "./nav-icons";

export interface NavDest {
  href: string;
  label: string;
  icon: NavIconName;
  /** Extra section prefixes that light this destination (the Library hub spans four routes). */
  match?: readonly string[];
}

/**
 * The Library hub — one nav entry over the collection routes, which keep their
 * URLs and share a tab strip inside the library shell; the header reads
 * Chats · Worlds · Library · Gallery.
 */
const LIBRARY_DEST: NavDest = {
  href: "/characters",
  label: "Library",
  icon: "library",
  match: ["/personas", "/locations", "/items", "/social-cards"],
};

/**
 * Full destination list for the desktop top-nav and the hamburger drawer (the
 * wordmark already links Home, so Home isn't repeated here). Standalone module
 * so AppShell, BottomTabBar and NavDrawer can all share it without an import
 * cycle (AppShell renders the latter two).
 */
export const NAV_LINKS: readonly NavDest[] = [
  { href: "/chat", label: "Chats", icon: "chats" },
  { href: "/worlds", label: "Worlds", icon: "worlds" },
  LIBRARY_DEST,
  { href: "/gallery", label: "Gallery", icon: "gallery" },
];

/**
 * Bottom-tab-bar primary slots (4) — Home included; rest go to the More sheet.
 * Chats takes a primary slot (the companion experience is the front door — D12); the
 * Library hub covers the four collections, so only Gallery overflows.
 */
export const PRIMARY_NAV: readonly NavDest[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/chat", label: "Chats", icon: "chats" },
  LIBRARY_DEST,
  { href: "/worlds", label: "Worlds", icon: "worlds" },
];

/** Bottom-tab-bar overflow, surfaced via the "More" sheet. */
export const OVERFLOW_NAV: readonly NavDest[] = [{ href: "/gallery", label: "Gallery", icon: "gallery" }];

/**
 * Whether a destination is the current page. Home ("/") matches exactly;
 * everything else matches the section prefix (so /worlds/forge lights Worlds,
 * and any of the Library hub's collection routes light Library via `match`).
 */
export function isNavActive(pathname: string, dest: NavDest): boolean {
  if (dest.href === "/") return pathname === "/";
  const prefixes = [dest.href, ...(dest.match ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
