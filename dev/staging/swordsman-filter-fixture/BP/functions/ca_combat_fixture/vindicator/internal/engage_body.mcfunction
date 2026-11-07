# INTERNAL: clear only; no spawn/teleport.
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.armor.head 0 minecraft:air
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.armor.chest 0 minecraft:air
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.armor.legs 0 minecraft:air
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.armor.feet 0 minecraft:air
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.weapon.mainhand 0 minecraft:air
replaceitem entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] slot.weapon.offhand 0 minecraft:air
tag @e[type=minecraft:vindicator,name="CA_CombatFixture"] add civbesiege:v1
execute if entity @e[type=minecraft:vindicator,name="CA_CombatFixture",tag="civbesiege:v1"] at @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] run tp @e[type=minecraft:vindicator,name="CA_CombatFixture",tag="civbesiege:v1"] ~ ~ ~1
