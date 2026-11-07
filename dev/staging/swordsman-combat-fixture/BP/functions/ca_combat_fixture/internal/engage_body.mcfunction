# INTERNAL: public ca_combat_fixture/engage only. No spawn command here.
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.armor.head 0 minecraft:air
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.armor.chest 0 minecraft:air
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.armor.legs 0 minecraft:air
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.armor.feet 0 minecraft:air
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.weapon.mainhand 0 minecraft:air
replaceitem entity @e[type=minecraft:zombie,name="CA_CombatFixture"] slot.weapon.offhand 0 minecraft:air
execute at @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] run tp @e[type=minecraft:zombie,name="CA_CombatFixture"] ~ ~ ~1
