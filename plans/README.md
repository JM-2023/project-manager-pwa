# Motion plans

Executable motion-improvement plans. Each plan is self-contained (current code, target code, steps, boundaries, acceptance), so another agent can carry it out without this conversation's context. Each is stamped with the commit it was written against. If the code has drifted, stop and report rather than improvising.

| # | Title | Severity | Status | Acceptance |
|---|---|---|---|---|
| 001 | [Rewrite the content-swap layer: a mount is no longer an entrance](001-view-swap-motion.md) | HIGH | DONE (not yet committed; iPhone feel check pending) | `node plans/001-verify.cjs`: 4/13 before, 13/13 after |
| — | Put every expand/collapse on one spring (Next groups, archived projects, mobile project picker, calendar log) | MEDIUM | In progress in a separate session (`one-spring-disclosure`, its own worktree), no plan file | Defined by that session |

## Execution order and dependencies

1. **001 first.** It covers the most frequent moments (Today day switch, Search typing, project switch, cold launch), and every problem it fixes is measured.
2. **001 and the one-spring session can run in parallel.** Their files don't overlap: 001 edits `pageTransition.ts`, `listMotion.ts`, `TaskTable.tsx`, `TodayPage.tsx`, `SearchPage.tsx` and `ProjectsPage.tsx`; the other session edits `disclosure.ts`, `NextPage.tsx`, `ProjectList.tsx` and `CalendarPage.tsx`. Both edit `src/styles/app.css`, but different rules. Expect at most a text-level conflict at merge, nothing semantic.
3. Candidates after this (no plans yet), in priority order:
   - Move listMotion moves onto a spring, so an interrupted re-sort keeps its velocity (today an interruption restarts from the current position at zero velocity).
   - Other mount entrances: the `.settings-*` and `.project-row` staggers (still stacked at cold launch), and `.cache-item`'s `scale-in` (ideas in the Search ideas scope vanish instantly when filtered).
   - Keyframe restarts: the menu (`task-menu-morph`), the sync pill (`toast-in/out`) and RollText jump back to frame 0 when triggered again mid-animation.
