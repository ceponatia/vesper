import type { ScheduleKind, ScheduleKindStatus } from "./classifier";

export interface ScheduleKindFixture {
  id: string;
  activity: string;
  expectedStatus: ScheduleKindStatus;
  expectedKind: ScheduleKind | null;
  note: string;
}

const matched = (
  id: string,
  activity: string,
  expectedKind: ScheduleKind,
  note = "explicit single-purpose activity",
): ScheduleKindFixture => ({ id, activity, expectedStatus: "matched", expectedKind, note });

const unresolved = (
  id: string,
  activity: string,
  expectedStatus: "ambiguous" | "unknown",
  note: string,
): ScheduleKindFixture => ({ id, activity, expectedStatus, expectedKind: null, note });

export const SCHEDULE_KIND_FIXTURES: ScheduleKindFixture[] = [
  matched("sleep-simple", "Sleep", "sleep"),
  matched("sleep-bed", "Going to bed", "sleep"),
  matched("sleep-nap", "Take a nap", "sleep"),
  matched("meal-breakfast", "Breakfast", "meal"),
  matched("meal-lunch", "Have lunch", "meal"),
  matched("meal-coffee", "Coffee break", "meal"),
  matched("hygiene-shower", "Take a shower", "hygiene"),
  matched("hygiene-teeth", "Brush teeth", "hygiene"),
  matched("hygiene-compound", "Shower and brush teeth", "hygiene", "two segments, same kind"),
  matched("work-shift", "Work shift", "work"),
  matched("work-night", "Night shift", "work"),
  matched("work-teach", "Teaching classes", "work"),
  matched("travel-commute", "Commute to work", "travel"),
  matched("travel-drive", "Drive to the harbor", "travel"),
  matched("travel-going", "Going to market", "travel"),
  matched("exercise-run", "Morning run", "exercise"),
  matched("exercise-workout", "Work out", "exercise"),
  matched("exercise-yoga", "Yoga", "exercise"),
  matched("social-meet", "Meet Alex", "social"),
  matched("social-call", "Call Mom", "social"),
  matched("leisure-read", "Read", "leisure"),
  matched("leisure-movie", "Watch a movie", "leisure"),

  unresolved(
    "ambiguous-shower-coffee",
    "Shower and coffee",
    "ambiguous",
    "the motivating counterexample: hygiene plus meal",
  ),
  unresolved("ambiguous-work-dinner", "Work then dinner", "ambiguous", "work plus meal"),
  unresolved("ambiguous-dinner-date", "Dinner with Alex", "ambiguous", "meal plus social"),
  unresolved(
    "ambiguous-travel-exercise",
    "Drive to the gym and work out",
    "ambiguous",
    "travel plus exercise",
  ),
  unresolved(
    "ambiguous-partial",
    "Shower and get ready",
    "ambiguous",
    "one classified segment plus one semantically open segment",
  ),

  unresolved("unknown-routine", "Morning routine", "unknown", "too broad for a hard effect"),
  unresolved("unknown-prepare", "Prepare for work", "unknown", "preparation is not the work shift"),
  unresolved("unknown-child-bed", "Put the child to bed", "unknown", "must not be read as the actor sleeping"),
  unresolved("unknown-rest", "Rest", "unknown", "could be sleep, recovery, or leisure"),
  unresolved("unknown-errands", "Errands", "unknown", "underspecified activity bundle"),
  unresolved("unknown-home", "At home", "unknown", "location prose is not an activity kind"),
];
