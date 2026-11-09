# Corrected final reads — separate frozen overlay

Original A739 observer foundation, BE59 journal and both independent failing repros/log remain unchanged. This delta replaces ONLY the two staged proposal modules. No production, world, UI, native activation, subscription, timer or terminal sink was added.

The independent reviewer demonstrated two stale read-only candidates: the second lookup's final property-ID census replaced the same journal key after its last raw comparison, and the second metadata callback changed the native actor ID after its last repeated frame. Both returned a candidate instead of HOLD. These were observer freshness defects, not journal terminal writes or aggregate losses.

Minimal corrections: `lookupActor` compares the saved raw bytes AGAIN after its final census, before returning the detached record; `observeDeath` repeats the native frame AFTER the second metadata callback and refuses any mismatch. The default NULL path, same existing subscription wrapper/filter, original-wave retention, untracked-history refusal and zero observer writes remain.

Focused41/41PASS1538.8507ms =39 prior cases unchanged +2 exact independent repros unchanged, with their imports resolving this NEW overlay. Strict validation closureTSC0. Validation module copies exactly match proposed modules; original dependency copies unchanged. These are synthetic injected-port tests, not real engine event readability or combat acceptance.

There is no atomic multi-source snapshot primitive in Script API. No finite arrangement of getters can promise linearizable reads under arbitrary hostile last-getter/setter or distinct-wrapper mutation. The final native frame and metadata port remain trusted boundaries. A native getter in that final frame could mutate journal bytes after the last metadata comparison; this delta does not claim to prevent that arbitrary-port trace or authorize persistence. Candidate still has NO terminal writer/sink, no native birth provenance, no lifecycle command, no aggregate/resource debit, and no default production configuration. Do not wire this candidate straight to journal.death.

Next gate is independent exact two-repro and41case review. Actual production callback wiring, genuine existing-owner birth hook, all encounter-family starter/export guards and native deadEntity readability remain OPEN.
