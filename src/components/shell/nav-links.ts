import type { NavIconName } from "./nav-icons";

export interface NavDest {
  href: string;
  label: string;
  icon: NavIconName;
}

/**
 * Full destination list for the desktop top-nav and the hamburger drawer (the
 * wordmark already links Home, so Home isn't repeated here). Standalone module
 * so AppShell, BottomTabBar and NavDrawer can all share it without an import
 * cycle (AppShell renders the latter two).
 */
export const NAV_LINKS: readonly NavDest[] = [
  { href: "/chat", label: "Chats", icon: "chats" },
  { href: "/worlds", label: "Worlds", icon: "worlds" },
  { href: "/characters", label: "Characters", icon: "characters" },
  { href: "/locations", label: "Locations", icon: "locations" },
  { href: "/items", label: "Items", icon: "items" },
  { href: "/social-cards", label: "Social cards", icon: "social-cards" },
  { href: "/gallery", label: "Gallery", icon: "gallery" },
];

/**
 * Bottom-tab-bar primary slots (4) — Home included; rest go to the More sheet.
 * Chats takes a primary slot (the companion experience is the front door —
 * character-chat-standalone.plan.md area 1 / D12); Gallery moves to overflow.
 */
export const PRIMARY_NAV: readonly NavDest[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/chat", label: "Chats", icon: "chats" },
  { href: "/characters", label: "Characters", icon: "characters" },
  { href: "/worlds", label: "Worlds", icon: "worlds" },
];

/** Bottom-tab-bar overflow, surfaced via the "More" sheet. */
export const OVERFLOW_NAV: readonly NavDest[] = [
  { href: "/gallery", label: "Gallery", icon: "gallery" },
  { href: "/locations", label: "Locations", icon: "locations" },
  { href: "/items", label: "Items", icon: "items" },
  { href: "/social-cards", label: "Social cards", icon: "social-cards" },
];

/**
 * Whether a destination is the current page. Home ("/") matches exactly;
 * everything else matches the section prefix (so /worlds/forge lights Worlds).
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
