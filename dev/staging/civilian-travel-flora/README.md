# Civilian corridor flora — historical staging proposal, not promotion-ready

**Current review checkpoint (November 6):** installed build160 has 1,864 passing
full checks; the updated source160 identity/diagnostics revision is undergoing
full verification. Its shared native read budget is **256 per slice**, not the
historical 240 below. This old proposal is based on the earlier 156-era driver.
Its patch, hashes, handoff and 48-test log are retained as historical evidence;
they do not match or validate today's shared safety module or pinned actor driver.
Do not apply the old whole-file proposal over the current driver.

The next native run must first report an exact flora body obstruction. The
partial D1 route result (141 unloaded observations) does not establish a flora
cause. Without that evidence this remains a possible capability, not a required
fix or a completed path.

## Small conditional migration plan

If native diagnostics identify one of the four exact plant IDs as a blocker:

1. Rebase a tiny patch on the then-current `people/walkSafety.js`, preserving its
   exact footing predicate. Keep one shared body predicate for planner and driver;
   avoid adding a second private allowlist to `integration/civilianTravel.js`.
   Use a clear body-clearance name rather than leaving an `isTravelBodyAir` name
   that now accepts plants. Do not replace or rebase the actor identity pin.
2. Update both consumers explicitly. In `people/workRoutePreview.js`, stand/rise
   checks, diagnostics and the **fresh final path reread** currently require AIR.
   The latter compares each body ID exactly to AIR, so changing only the shared
   predicate would produce an inconsistent preview. A future patch must preserve
   the observed primitive body ID for each admitted cell and require it unchanged
   on the fresh reread, in addition to passing the shared clearance predicate.
   The motion driver must continue its full swept body checks and late identity,
   source/stop/threat checks before any impulse, within the same 256-read cap.
3. Promote only newly reviewed tests using the current source: both consumers
   agree; every permitted plant is refused as footing; both tall-plant halves,
   unreadable cells and late plant-to-wall/plant-to-hazard changes are covered.
   Retain doors/gates, crops, leaves, liquids, hazards and unknown-block refusal,
   exact actor pin, stop/rejoin-off and no block/entity/property writes. Do not
   infer arbitrary low-collision blocks from `isSolid` or a broad family name.
4. Strict typecheck and focused/central full gates precede deployment. The old
   48 checks are not inherited by this rebased patch. Run a backed-up native trial
   with one existing admitted actor, actual safe footing and exact plant IDs.
   Verify real passage through lower **and upper** tall grass/large fern cells,
   unchanged plants/identity/counts and successful stop/unload handling. A route
   preview alone is not collision or walking acceptance.

Official ID/state listings and generic collision documentation cited below do
not prove each built-in plant's collision shape. Native both-halves passage
remains a specific acceptance gate; no collision claim is supplied by this review.

## Historical proposal and 48-test evidence (earlier driver)

This one-file proposal changes **body-cell clearance only** in the existing
opt-in travel trial. Its exact permitted body IDs are `minecraft:air`,
`minecraft:short_grass`, `minecraft:fern`, `minecraft:tall_grass` and
`minecraft:large_fern`. It neither changes/removes plants nor treats plants as
ground. Required footing and the full two-high swept corridor are unchanged.

The current production check accepts only air in body cells. This source fact
does **not** establish why the earlier native D1 route search failed: no exact
obstruction from that trial was captured. This is a planned capability, not a
diagnosed native root-cause fix. It was authored outside the active/installed packs while the separate 156-file
destination/leaf build was undergoing full verification (historical checkpoint).

The [official vanilla listing](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/vanillalistingsreference/blocks?view=minecraft-bedrock-stable)
confirms these current IDs; tall grass/large fern use `upper_block_bit`.
The [official collision component documentation](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/blockreference/examples/blockcomponents/minecraftblock_collision_box?view=minecraft-bedrock-stable)
defines collision-box semantics. Neither is a direct per-block proof of the
built-in four flora collision definitions. **Native passage through both tall
halves and unchanged plants still needs acceptance before promotion.** No new
state-dependent collision inference, old `tallgrass`/`double_plant` aliases or
broad `isSolid=false` fallback is introduced.

Closed/open doors and gates remain refused; crops, water/lava, fire, cactus,
berries, web, powder snow, leaves and unknown IDs remain refused. No changes to
shared read limits, safe footing, late re-probes, actor identity/admission,
population ownership, scheduling, impulses, stopping, route geometry or food
accounting. No new timer, entity, block/property write, loading request or route
is added by this proposal.

`proposal.patch` targets only
`CivilizationApocalypse_BP/scripts/integration/civilianTravel.js`.
`handoff.json` records baseline/proposal hashes; the active baseline was rechecked
unchanged. The copied proposed source is exercised by resolving its imports to
the actual production dependencies. No implementation mirror is substituted.

Validation: **48/48 standalone focused checks**, zero failures/cancellations/skips,
3,375.6473ms (`focused.log`). This includes the17 existing travel checks and31
new cases: all four plants in the body sweep, tall pairs, refusing each plant as
footing,20 named obstacles, late wall insertion and unreadable plant positions.
These historical checks retained shared 240-read caps, full sweep, late actor/position/
duplicate guards, stopping, no-teleport and unload/rejoin ownership. Strict
typecheck is deliberately deferred while the parent's full verification runs;
no existing typecheck/full-suite/native proof is inherited by this new source.

At that historical checkpoint, the suggested later native sequence was:
use a backed-up trial with one **existing** admitted villager:

```text
/scriptevent civ:people travel inspect district=1 group=0
/scriptevent civ:people travel start-near district=1 group=0 length=4
/scriptevent civ:people travel status
/scriptevent civ:people travel stop
```

First establish the actual actor/group and a naturally loaded, safe flat corridor;
do not assume group0 exists. Demonstrate actual motion through the named plants,
both halves for tall flora, with unchanged plants/identity/counts and no teleport.
Then verify blocking wall/closed gate/liquid/unload pauses, stop behavior and
session-off after rejoin. Retain specific obstruction diagnostics if refused.
This remains a movement trial, not physical farming or earned production.
