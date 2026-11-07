# Operator checks exact1 guard/1 named fixture. Existence is not cardinality.
execute in overworld if entity @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] if entity @e[type=minecraft:zombie,name="CA_CombatFixture"] run function ca_combat_fixture/internal/clear_gear_body
