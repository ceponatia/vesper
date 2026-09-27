# Issue authoring

Read when creating or restructuring issues and sub-issues. `vesper-board`
owns creation commands, board classification, links, lifecycle, and assignment.

## Make the next implementation concrete

A plan-sized effort is a parent issue. Keep its body concise enough to navigate
without reading historical documents; use this structure where it fits:

```markdown
**Outcome:** A player can <concrete action> so that <observable consequence>.

## Current state
<What exists and what is accepted; distinguish them honestly.>

## Scope
<Boundaries and links to the native sub-issues that deliver the outcome.>

## Acceptance
<Observable conditions and the verification or owner action that closes them.>

## Constraints & rulings
<Dated owner rulings and implementation constraints.>

## References
<The system references and code needed for implementation.>
```

- Create implementation stages as native sub-issues alongside the parent when
  enough is known to describe them. A child states its own scope, dependencies,
  and acceptance; do not maintain a duplicate checklist of its status.
- Add discovered prerequisites as work items with native blocked-by relations
  on the exact dependent issue. Prose and list order are not dependency links.
- A material unresolved choice belongs in a `decision-needed` issue with the
  plausible choices, consequences, and relevant code. Reuse existing owner
  rulings; resolve routine implementation decisions within the authorized task.
- Record owner rulings as dated comments on the owning issue. Update a durable
  reference only when the ruling changes technical law; preserve rationale in
  an ADR only when it warrants one.
- A research issue holds experiments and discussion. Once resolved, resulting
  behavior belongs in system docs, resulting work in issues, and history in the
  closed issue. A reproducible measurement may earn a text-only evidence record
  under the dated-evidence rule in [durable docs](durable-docs.md).
- When the task authorizes filing unrelated findings, label those `agent-found`.
  Do not expand an implementation task into a debt cleanup project.
- GitHub Discussions are not used; decisions there are unavailable to part of
  the agent fleet. Use issues and comments.

## Acceptance and saved state

Built and accepted are distinct. Do not imply completion while an acceptance
action remains. `vesper-board` owns the actual lifecycle transition and whether
a PR should close an issue. Use one closing keyword per completely delivered
issue; partial scope must retain an open work record.

After an authorized mutation, read the saved issue and native relations back.
If creation succeeded but classification or linking failed, resume from that
issue's number rather than filing a duplicate. Let board helpers own recovery.
