# OPERATOR MUST VERIFY EXACTLY ONE canonical/type/tag guard, diagnostics ON.
# Existence tests do NOT assert cardinality. No c=1 hides duplicate guards.
# Call public wrappers only. No guard summon/teleport/health/effect writes exist.
# AFTER spawn initialization tick: operator verifies exactly ONE named zombie,
# no staging injury/contact, same guard identity and health30. Then invoke once.
# Body clears all six slots and teleports only the named zombie in one chain.
# Commands are not transactional; native command failures invalidate the trial.
execute in overworld if entity @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] if entity @e[type=minecraft:zombie,name="CA_CombatFixture"] run function ca_combat_fixture/internal/engage_body
