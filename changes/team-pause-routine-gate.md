---
type: added
---

**Pausing a team stops its routines' agent runs.** While a team's newest `team-control` record pauses it, every agent fire of a routine in that team, scheduled, caught up, fired by an event or run by hand, is recorded as skipped with the reason `team_paused`, before budget, loop guard and overlap. Command routines and built-in routines keep running, and a routine whose `routine.yml` sets `runs_while_team_paused: true` keeps running too; the routine tools can't set that flag.
