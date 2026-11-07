# REMOVE test namespace BEFORE aftermath-only target TP. Never add district tag.
tag @e[type=minecraft:vindicator,name="CA_CombatFixture"] remove civbesiege:v1
execute unless entity @e[name="CA_CombatFixture",tag="civbesiege:v1"] run tp @e[type=minecraft:vindicator,name="CA_CombatFixture"] -200.5 69 -630.5
