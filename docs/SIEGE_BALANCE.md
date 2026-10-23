# Siege balance: reproduction, mechanisms, and the fix

Owner: WP1 (siege balance). Tracks the "known balance problem" in
[ROADMAP.md](ROADMAP.md) section C and the "Siege deadlock" limit in
[MINECRAFT_INTEGRATION.md](MINECRAFT_INTEGRATION.md).

Harness: `node dev/probe-siege.mjs` drives the real per-step pipeline (`sim/tick.js`
`advanceKingdomStep`: war, gate control, evacuation, construction, expansion, policy, population,
training) with the default policy and no player intervention. Seeds are fixed (`PROBE_SEEDS`: the
shipped default `20261017` plus `1`..`15`). The regression is `dev/test/siege-longhorizon.test.mjs`.
Every number here is a measured offline result. None of it shows in-game feel, pacing, or whether
the numbers read well to a player.

## 1. Baseline (before any change)

3000 steps per run, 16 seeds, default defence, recorded from the unmodified code at commit
`143afa9`.

| seed | first breach | first lost | lost at end | lost with raiders still on it | steps with assault (of 3000) | raids landed | breaches | integrity min |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20261017 | 211 | 231 | 5 | 5 | 2850 | 273 | 5 | 0 |
| 1 | 824 | 888 | 5 | 5 | 2337 | 384 | 6 | 0 |
| 2 | 822 | 848 | 5 | 5 | 2319 | 360 | 5 | 0 |
| 3 | 175 | 197 | 5 | 5 | 2889 | 265 | 5 | 0 |
| 4 | 869 | 894 | 5 | 5 | 2257 | 360 | 5 | 0 |
| 5 | 902 | 923 | 5 | 5 | 2281 | 395 | 5 | 0 |
| 6 | 836 | 858 | 5 | 5 | 2330 | 362 | 5 | 0 |
| 7 | 876 | 898 | 5 | 5 | 2291 | 365 | 5 | 0 |
| 8 | 851 | 888 | 5 | 5 | 2290 | 371 | 5 | 0 |
| 9 | 849 | 873 | 5 | 5 | 2309 | 361 | 5 | 0 |
| 10 | 870 | 896 | 5 | 5 | 2295 | 372 | 5 | 0 |
| 11 | 824 | 857 | 5 | 5 | 2308 | 360 | 5 | 0 |
| 12 | 964 | 985 | 5 | 5 | 2214 | 403 | 5 | 0 |
| 13 | 981 | 1004 | 5 | 5 | 2207 | 407 | 5 | 0 |
| 14 | 829 | 863 | 5 | 5 | 2315 | 356 | 6 | 0 |
| 15 | 795 | 827 | 5 | 5 | 2323 | 353 | 6 | 0 |

**Result: 16 of 16 default runs end with all five districts lost.** First loss falls between step
197 and step 1004 (median about 880, roughly 37 in-game days). Once lost, a district never recovers:
the lost count only ever rises.

Challenge cases on the same seeds (baseline, kingdom-wide counts):

| scenario | runs ending all lost | runs ending none lost | lost at end (range) | notes |
| --- | ---: | ---: | --- | --- |
| undefended district (district-3, 0 soldiers) | 0 / 16 | 2 / 16 | 0 to 4 | falls and re-falls repeatedly; about 60 lost/recovered cycles per run |
| under-garrisoned district (district-3, 2 soldiers) | 0 / 16 | 1 / 16 | 0 to 4 | same cycling |

Re-measured with the final probe on the committed code (`HEAD`): the default and undefended runs
both end 16 of 16 with all five districts lost, and the under-garrisoned run ends 16 of 16 the same
way. The baseline "none lost" counts above come from the earlier probe; the all-lost result is the
one that matters.

## 2. Mechanisms, verified against the code

The reported mechanisms (a) to (f) were each checked against `sim/war.js` (line numbers refer to
the unmodified file) and counted in the baseline run.

**The chain that actually produces a loss.** Traced on seed `20261017`, `district-2`:

1. Raids stack on the district faster than the garrison can kill them. The wall loses integrity
   every engaged step, and no repair is possible while any band is on the ground.
2. Integrity falls from 100 to 0 over about 30 steps. Effective defending strength is
   `front x clamp(integrity, 5, 100)/100`, so the garrison's real strength falls with the wall and
   bottoms out at 5% of its front.
3. The raid band is cut down to a remnant of 2 raiders. Against a standing strength of about 0.2
   the band loses **0** raiders per step (mechanism a), the counterattack needs 3 (mechanism b), and
   the wall cannot be repaired while `assault > 0` (mechanism c).
4. The remnant sits on the wall for 12 consecutive breached steps and the district is recorded
   `lost` (step 231 in the trace).

The remnant is the deadlock: in the baseline a lost district was still carrying an assault in every
case. `longestSiege` is the longest unbroken run of steps with a raid on one district: 2,036 to
2,851 steps. That is a band that never went away, not a siege that ended.

**(a) Tiny bands are never worn down. Real, load-bearing.** `war.js` `resolveAssault`:
`rawAttackerLosses = assault * ATTACKER_LOSS_RATE` (0.18), then `Math.round`. For assault 1 or 2 the
product is below 0.5, so the loss is 0 whenever defenders are standing. Baseline: battles with a 1 to
2 raider band that lost nobody to a standing defence: **9,900 to 11,700 per run in all 16 seeds**
(169,377 in total).

**(b) The counterattack needs 1.5x strength. Real, but a symptom.** `war.js` `counterattack` returns
early when `standing < assault * COUNTERATTACK_RATIO`. Remnant steps blocked by this (169,127 in
total) match the (a) count almost exactly, because a garrison at near-zero integrity has standing
0.2 to 1 against a band of 1 to 2 that needs 1.5 to 3. The ratio is not the root cause: the standing
collapses because integrity has collapsed.

**(c) Repairs are blocked while assault is above zero. Real as a rule, but no longer a deadlock.**
`war.js` `recoverAfterDefense` returns before any repair when `assault > 0`. Baseline: repairs blocked
on 10,300 to 12,100 district-steps per run, almost all with a 1 to 2 raider remnant on the ground
(169,498 remnant district-steps in total). The rule is kept deliberately: a wall is not repaired
under a live attack. It stopped being a deadlock once the remnant can be worn down (fix 1 below).

**(d) Construction cannot work in a lost district. Real.** `tick.js` `CONSTRUCTION_CAN_WORK_SECURITY`
is `secure`, `alert`, `isolated`; `lost` is excluded, so `assignBuilders` releases the crew and
`advanceConstruction` stalls every open project. `policies.js` `runPolicyStep` also refuses to
schedule new work outside `secure` and `alert`. Baseline: lost districts carried open projects on
4,200 to 10,600 district-steps per run (125,068 in total). This makes the loss permanent in the
baseline but is not, by itself, a cause.

**(e) Lost districts are never raided again. Real, by design.** `war.js` `spawnThreats` skips
`security === "lost"`. Baseline: about 10,000 lost district-steps per run (168,438 in total).
Together with (a) and (c) this meant a lost district could only leave the lost state through a
remnant clearing that the baseline never allowed.

**(f) 1 to 2 raiders erode walls. Partly real.** `resolveAssault`:
`integrityLoss = max(standing > 0 ? 0.5 : 1, odds * 1.2)`, capped at 4. Against a healthy wall the
0.5 floor is what applies (odds are under 0.42). Against the collapsed wall the cap applies: a
2-raider band against 0.2 standing costs 2.4 to 4 a step. The erosion is real, but it follows from
mechanism (a) keeping the band alive, not from the floor on its own. Baseline: tiny-band battles that
chipped the wall: 169,377 in total, the same battles as (a).

## 3. The fix

Final configuration, default probe over 16 seeds, 3000 steps.

### Rules changed

| change | where | before | after |
| --- | --- | --- | --- |
| Engaged bands lose at least one raider a step | `sim/war.js` `resolveAssault`, `ENGAGED_ATTACKER_MINIMUM_LOSS` in `sim/siegeTuning.js` | `round(assault * 0.18)`, zero for a band of 1 or 2 | `max(1, round(assault * 0.18))` when any defender stands. The unopposed rule is unchanged |
| Defenders lose 3% of the front per engaged step (was 4%) | `DEFENDER_LOSS_RATE` in `sim/siegeTuning.js` | 0.04 | 0.03 (counterattack casualties scale with it too) |
| Wall crew has a floor of two hands and one hand per 20 civilians | `sim/war.js` `wallCrewOf`, `MIN_REPAIR_CREW` in `sim/siegeTuning.js` | `max(1, builders)` | `max(2, builders, floor(civilians / 20))` |

Repairs still happen only when no raid is on the ground, at 0.6 integrity per hand per step, and
each point costs 0.5 materials from `reserves.materials`. Nothing in the war module repairs for free.

Unchanged: raid chance (8% per district per step), raid band 6 to 24, assault cap 32, counterattack
ratio 1.5, breach line 40, fall after 12 consecutive breached raid steps with no able defender, lost
districts not raided, lost districts recovering to `breached` at integrity 40 and then climbing the
ladder, reinforcement rules, construction gating.

Who changed what: the engaged floor and the civilian term of the wall crew were applied to `war.js`
in the shared working tree during this session by another contributor. They were kept, the constants
moved into `sim/siegeTuning.js`, and the defender rate and crew floor were set to the values the
coordinator asked for. `sim/siegeTuning.js` is the single place for the siege numbers.

### After table (default defence, 16 seeds, 3000 steps)

| measure | before (`HEAD`) | after |
| --- | ---: | ---: |
| runs ending with all five districts lost | 16 / 16 | **0 / 16** |
| runs ending with at most one district lost | 0 / 16 | **16 / 16** |
| runs ending with none lost | 0 / 16 | 15 / 16 |
| first breach, median step | 849 | 1277 |
| first loss, median step | 888 | 1419 |
| breaches per run (transitions into `breached`) | 5.2 | 84.9 |
| share of district-steps with a wall down (`breached`) | 0.8% | 5.8% |
| share of district-steps lost | 70.2% | 0.6% |
| falls per run (transitions into `lost`) | 5.0 | 11.1 |
| share of steps with a raid on at least one district | 78.8% | 53.8% |
| raids landed per run | 359 | 1194 |
| longest unbroken raid on one district (steps) | 2851 | 51 |
| lowest integrity reached | 0 | 0 |
| steps rejected by the save validator | 0 | 0 |

Raids per run rise because districts spend less time lost, and lost districts are not raided.
The raid chance itself is unchanged.

Held-out seeds `100`..`115` (not used to pick the numbers): 0 runs all-lost, 16 / 16 with at most
one district lost, first breach median step 1299, 81.7 breaches per run, 5.9% of district-steps
breached, 0.5% lost.

Mechanism counters over the same 16 seeds (sums; before from the baseline run, after from the final
run):

| mechanism | before | after |
| --- | ---: | ---: |
| (a) battles where a 1-2 band lost nobody to a standing defence | 169,377 | **0** |
| (b) remnant (1-2 raider) district-steps below 1.5x standing | 169,127 | 3,184 |
| (c) remnant district-steps with the wall below full | 169,498 | 3,807 |
| (d) lost district-steps with a project still open | 125,068 | 1,239 |
| (e) lost district-steps (raids skipped) | 168,438 | 1,329 |
| (f) battles where a 1-2 band chipped the wall | 169,377 | 3,816 |

Challenge scenarios (after):

| scenario | result |
| --- | --- |
| undefended district-3 (0 soldiers) | falls at least once on **16 / 16** seeds (1 to 5 falls each); lost 0.1% to 5.3% of steps; breached 3% to 19% |
| under-garrisoned district-3 (2 soldiers) | falls at least once on **12 / 16** seeds (0 falls on seeds 3, 5, 9, 13); no seed ends with all five lost |

The undefended runs before the fix were all-lost on 16 / 16 seeds (kingdom-wide), so the change keeps
the threat without removing it. Under-garrisoned falls are not guaranteed on every seed.

### Ablations (each change off in turn, default defence, 16 seeds, 3000 steps)

| variant | all five lost | at most one lost | none lost | breaches per run | share breached | share lost | first breach median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final (as shipped) | 0 | 16 | 15 | 84.9 | 5.8% | 0.6% | 1277 |
| defender loss 0.04 instead of 0.03 | 0 | 16 | 13 | 128.6 | 9.3% | 1.0% | 888 |
| minimum crew 1 instead of 2 | 0 | 16 | 15 | 85.1 | 6.0% | 0.9% | 1277 |
| no civilian term in the crew | 0 | **13** | 9 | 68.5 | 11.0% | 7.8% | 1268 |
| no engaged attrition floor | **16** | 0 | 0 | 5.1 | 0.8% | 56.1% | 1277 |

What this says:
- The engaged attrition floor is the load-bearing fix. Without it every seed still ends all-lost.
- The civilian term of the wall crew is what makes lost districts recover. Without it the target
  drops to 13 of 16 seeds.
- The defender loss rate is not needed to reach the target. It is a dial for breach frequency:
  0.03 cuts breaches by about a third.
- The minimum crew of two has no measurable effect on the default runs, because the civilian term
  already gives four hands on a district of 80. It is a floor for a district that has lost most of its
  people. Its effect on undefended falls was not separable in the runs (16 / 16 falls both ways).

## 4. Tests changed to match

Three existing assertions broke because a documented behaviour intentionally changed. Each keeps its
invariant and was changed only as far as the new numbers require.

1. `dev/test/war.test.mjs` "the wall crew is one hand per twenty civilians...": the standing crew is
   now `MIN_REPAIR_CREW` (2), not 1. Two assertions now compare against `MIN_REPAIR_CREW`. The rule
   (floor, then one hand per 20 civilians) is unchanged.
2. `dev/test/evacuation.test.mjs` "evacuation and war agree...": with a two-hand standing crew the
   70-step repair reaches the cap. Integrity expectation 93.4 becomes 100, and materials 138.3 become
   135 (90 points at 0.5). The invariant is unchanged: repair stops at 100, and every repaired point
   is paid for in materials.
3. `dev/test/siege-longhorizon.test.mjs` "the challenge is real...": the per-seed first-breach bound
   moves from 1000 to 1500. Under the final rules seven of eight seeds first breach between steps
   1039 and 1384 (seed 20261017 breaches at 213). The earliest breach across seeds is still held to
   300.

Added to `dev/test/siege-longhorizon.test.mjs`: at most one district lost at step 3000 on at least
90% of the eight long-run seeds (all eight in practice); never more than three lost together; the
save validator passes at every 150-step checkpoint, no store goes negative, and integrity stays inside
0 to 100; and a fast subset of eight further seeds run for 400 steps with the validator and the
store and integrity checks on every step. The file runs in about 9 seconds.

## 5. Still a judgement call (needs in-game playtesting)

These are offline numbers. The brief is "challenging but recoverable", and the offline result
suggests the defence may now be too strong. A playtest decides which way to move.

1. **Falls are now rare.** About 2 falls per district over 125 in-game days, and a district is lost
   0.6% of the time. A player may never see a district fall under default defence; the undefended
   district is the only one that falls reliably. If the threat should be felt, the first levers are
   the raid chance (`ASSAULT_CHANCE`, 8%) and the defender loss rate.
2. **Breaches are frequent but short.** About 85 breaches per run across five districts, a wall down
   about 6% of the time. Confirm that a breach reads as an event rather than background noise.
3. **The first breach comes around day 50.** Median step 1277 (about 53 days). Seed 20261017 breaches
   at step 213. Decide whether the first 40 days should be peaceful or whether a light early raid
   belongs in the first week.
4. **Repairs are effectively free in the economy.** A four-hand crew repairs 2.4 integrity a step for
   1.2 materials, and the materials stock sits near its storehouse cap (about 750 in the traces), so
   the materials rule never binds. Decide whether repair should be more expensive or limited by
   supplies.
5. **The wall crew costs the economy nothing.** The civilian term counts one repair hand per 20
   civilians, but the work-gang economy in `sim/policies.js` keeps producing as if those people were
   still at work. The walls get labour for free. In the physical build those civilians would be on the
   wall, so the economy would need to pay for it.
6. **Defender loss 0.03 is a dial, not a fix.** See the ablations: 0.04 still avoids all-lost.
7. **Raid size and frequency are untouched.** Bands of 6 to 24 at 8% per district per step will
   matter more once the invasion director (ROADMAP B) replaces this model.

## 6. Known gaps outside WP1 (not changed here)

- `sim/construction.js` `repairDefences` restores integrity with no materials spent, for any district
  that is `secure` or `alert` and has builders assigned. This is a free repair path that the war
  module does not have. It is not in WP1's files, so it was left alone.
- `dev/test/integration.test.mjs` "the offline core stays free of the Minecraft runtime..." fails on
  `ledger/runtime.js` (moved from integration/ so the boundary test allows it) (the boundary regex matches only
  `@minecraft/server`). `npm run typecheck` reports two errors in the same file. Neither is caused by
  the siege changes; the file belongs to the ledger UI work.

## 7. Reproduce

```
node dev/probe-siege.mjs --steps=3000                      # default, 16 seeds
node dev/probe-siege.mjs --steps=3000 --scenario=undefended
node --test dev/test/siege-longhorizon.test.mjs            # regression, about 9 s
```
