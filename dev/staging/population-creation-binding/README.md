# Durable physical creation bindings — isolated implementation, NOT promotion-ready

The actual production adapter/reducer was reproduced creating a second civilian
when the first living canonical actor was unloaded. Reloading both causes strict
all-group duplicate hold. See the sibling population-unloaded-duplicate reproduction:
three controls pass, using default24total/8district caps. This is a code/model
reproduction, not proof of the native civ10 origin. Two native IDs are civilian
representatives; the military prefix names strict mode, not their soldier class.

`bindings.mjs` implements injected dynamic-property metadata only. The proposed
popSync copy consumes it as an OPTIONAL dependency: the same sole owner remains
responsible for all actual spawn/removal. No timer, second spawner or world edit
was installed. All default callers remain unchanged. No legacy duplicate is
removed, retagged or merged. All active owner bytes still match the frozen baseline.

## Inspectable protocol

A fresh epoch requires an externally verified never-started fixture contract;
legacy mode conservatively preserves unknown creation history. One1KiBASCII
property per group stores epoch, generation, type, actorID and pending/alive/
removing/retired or legacy states. Newbirth preparation is durably saved BEFORE
spawn. Ground/standing deferral happens before preparation, so never-created
intents still materialize when safe. No loaded actor means unknown for an issued
binding, never permission to spawn a replacement.

After spawn, actorID is persisted, canonical and generation tags are attached,
then a fresh unique canonical census and metadata CAS bind ALIVE. A crash before
binding stays pending; a loaded exact actor+generation can recover it. Unknown
pending/untagged actors remain preserved without another birth. Rollback can
retire only the exact captured newborn after removal returns and isValid=false.
Private frozen session tickets bind birth/removal transitions; copied tickets
cannot commit a different operation. Failed metadata readback never silently
permits a second birth.

Intentional LOD dematerialization persists removing intent, repeats fresh identity
and uniqueness, removes that exact actor through the existing owner, then records
positive owner-remove retirement. Later near promotion uses a NEW generation.
Crash after removal but before terminal persistence safely holds, not respawns.
Loaded removing actors can be reverified alive, then current owner intent decides
whether to keep/retry removal. EntityRemove/unload is never a death signal.

The optional entityDie observer subscribes once, requires fresh canonical tags,
exact durable actorID/type and generation tag, and records a physical death only.
Unreadable/stale identity is held; there is no diagnostic prior-binding fallback.
Duplicate or old generation events do not authorize another birth. This is NOT
aggregate casualty accounting and does not claim lossless event delivery. A missed
death/write failure can leave an issued group held, which is an explicit limit.

## Meaningful tested increment

13 focused tests pass257.554ms. They use the actual proposed owner through its
normal imports plus the existing loaded-only fakeworld, not a rewritten owner.
Tests include the unload duplicate prevention, clean deferred birth, actual LOD
remove/re-promotion, strict death/stale-event handling, every birth mutation crash
boundary/rejoin, tag rollback, silent prepare/actor/bind/cursor write failures,
remove terminal-save failure, legacy unknown/duplicate preservation, final query
failure/late canonical appearance, and the selected swordsman resolver. Initial
harness missing getDynamicPropertyIds failure is retained; it was fixed only by
an explicit read-only fakeworld key census. Strict production typecheck and full
checks have NOT run. No native protocol acceptance is inherited.

## Migration, bounds and remaining entry work

The v1 cursor tracks admitted intent and budgets, not actor IDs or whether a birth
actually happened. Its comments promising cursor corruption never duplicates are
not unconditional truths under unloading. It must remain advisory, NOT be reused
as an issued/never-issued ledger. Blocking every previously admitted intent would
freeze clean deferred groups; this implementation tests that mistake is avoided.

Legacy groups with no record cannot be assumed never-created. A unique loaded
legacy actor may be recorded as generation0 but receives no automatic retag,
removal or rebirth authority. Surviving duplicates remain untouched. This means
existing worlds need conservative held state or a separately evidenced migration;
there is no safe generic one-click conversion from loaded-only absence. A clean
release/template must initialize the fresh ledger BEFORE its first owner run.

The current verifyFreshWorld callback is a PRIVILEGED TEST CONTRACT, not a real
runtime provenance verifier. Before promotion replace it with a private capability
minted only by the actual known-fixture/raw-source/never-started-history adapter;
never accept a request-supplied fresh=true/proof object. Main/peopleStreets startup,
starter/export guards and activation/status command are NOT wired. Corrupt or
missing active metadata must refuse rather than fall back to legacy spawning.

Metadata caps are1KiBASCII/property,2048retained group records,4096key census and
48loaded observations/pass. Ordinary logical recruitment is not capped, but new
physical issuance at capacity is held. This bound needs reviewed chunked storage
before larger worlds; do not advertise limitless materialization. Records are not
deleted to free space or silently fold surviving identities. Runtime costs and
native tag/death availability also need acceptance. Only a single JS owner/writer
is supported; DP read-before-write/readback is not a multi-writer atomic transaction.

Next integration is the existing streets factory passing one initialized binding
store into createPopSync and one early-safe entityDie subscription; no second
scheduler/owner. Add actual fixture verifier/private activation, strict typing,
clean-release initialization and migration/status tests before central/full/deploy.
