# Real saved farm-pad destination refusal — staged fix

Confirmed from the pinned closed D1 source, checksum `07515fcb`, complete queue:
`pad-d1-farm_kitchen-1` and `building-d1-farm_kitchen-1` share blueprint
`farm_kitchen_v2` and lot `d1-farm_kitchen-1`. The foundation legitimately has no
rotation, door or frontage. The installed compiler classified its farm blueprint
as a destination before checking that it was a building, reproducing the exact
native refusal. `before.log` records the real fixture reproduction.

`proposal.patch` changes only `people/destinations.js`: select building descriptors
before classifying homes/farms. No actual-building validation, duplicate checks,
op scan, final ownership, bounds or native capability changes. Pads remain in the
final op scan; they are only excluded as entrance destinations.

**39/39 checks and strict overlay typecheck pass**:33 existing guards plus6 real
saved-source regressions, including unchanged-code failure, exact farm indexed
once, bad actual-building metadata/duplicate farm still refused, and actual async
preview controller success with zero native block reads/property writes.

Pinned fixture SHA, baseline/proposal SHA and limits are in `handoff.json`.
No active156 source, installed pack, game or world DB was changed. Do not promote
test shims, the unchanged controller test bridge or validation overlay. Root review,
central full verification, closed deployment and native preview repeat remain.
The earlier frontage proposal must be rebased onto this fix before promotion.
