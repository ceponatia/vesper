import Link from "next/link";

/**
 * Breadcrumb-style return from a library editor to its grid — the editor's
 * escape hatch on mobile, where the grid is otherwise only reachable through
 * the nav menu. The grid restores its last toolbar state on return
 * (entity-library.tsx §stored toolbar state), so this lands on the same view
 * the user left.
 */
export function LibraryBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="touch-target mb-1 inline-flex items-center gap-1.5 text-sm text-paper-400 transition-colors hover:text-paper-100"
    >
      <span aria-hidden>←</span>
      {label}
    </Link>
  );
}
