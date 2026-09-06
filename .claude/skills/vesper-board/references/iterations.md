# Iteration maintenance

Read only for iteration boundaries, date changes, or assignment recovery.
Query the live field configuration for titles, dates, IDs, and completed
iterations. Do not derive the current cycle from an old numbered iteration.

At a boundary, accept or carry over the closing iteration's work, then place
next execution issues with `board-set.sh N Iteration @next`. A parent's iteration
must include the child work visible in the current-iteration view.

Changing `iterationConfiguration` can recreate iteration IDs and clear every
item's assignment. Before an authorized date change:

1. Save `iteration-snapshot.sh` output to a task-owned JSON file.
2. Read the current configuration, including completed iterations. The input is
   `{ startDate, duration, iterations: [{ title, startDate, duration }] }`; do not
   copy old IDs or invent a `startDay` field. Preserve stable titles for restore.
3. Apply only the authorized edit and inspect the returned configuration.
   Overlapping periods can be silently omitted; verify the intended dates and
   complete list before restoring assignments.
4. Run `iteration-restore.sh <snapshot.json>`, which matches titles, then read
   back the affected assignments. Keep the snapshot until verified.

This is a bulk board mutation. Existing authorization for the exact maintenance
operation is sufficient; a normal issue-field update does not imply permission
to recut every iteration. For UI-only board settings, use a supported browser
with the target tab active and verify saved state instead of trusting a toast.
