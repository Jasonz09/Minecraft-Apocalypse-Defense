# Frontage inspection — staging only

Proposed command, using an exact building ID from the saved destination preview:

```text
/scriptevent civ:people travel destinations inspect district=1 building=BUILDING_ID
```

Three proposed production files, shown in `proposal.patch` and `handoff.json`:

- `people/destinations.js`: compiler-owned ephemeral provenance/current-metadata token.
- `people/frontage.js`: strict parser and injected three-cell snapshot inspector.
- `integration/civilianDestinations.js`: inspect branch on the existing async route.

No main/command registration changes, actor owner, routefinding, timer, chunk hold,
property/block write, spawning, teleport, steering or food credit. Ordinary destination
preview still performs zero native block reads. Source156 remains hash-identical.

The inspector checks **at most3 getBlock calls**: exact planned road floor, feet and
head. It uses known conservative full-block footing and AIR body cells; the separate
flora proposal is not included. `VERIFIED`, `UNLOADED`, `BLOCKED` and `REFUSED` are
distinct. VERIFIED means **one sampled frontage cell now**, not a route, doorway
access, actor clearance along a sweep or future movement permission.

Only results from the same compiler instance can reach native reads; JSON/prototype
clones cannot. Exact checksum/building/lot/height and live-record metadata are bound
in a WeakMap. Changes across compilation yields or before/after any native getter,
player dimension changes, cancellation, duplicate/missing candidates or unresolved
height refuse. No native Block reference survives a yield.

**37 focused checks pass**, including one small real production layout, late metadata
and context changes, floor/body hazards, unloaded/invalid/throwing getters, clone
rejection, quota/zero-write assertions and actual async-controller routing. Strict
typechecking passes on an isolated full-source overlay. These are simulated native
reads, not Minecraft acceptance. See `focused.log`.

Do not promote the two tiny import shims or `validation-overlay/`. After root review,
integration needs central verification, closed deployment and native inspection of
one saved frontage, repeat, blocked/unloaded behavior and cancellation/rejoin. No
movement or work claim follows from this preview.
