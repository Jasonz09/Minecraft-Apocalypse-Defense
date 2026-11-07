# INTERNAL, public prepare wrapper only. Fixed outside-city45cell trial volume.
difficulty normal
gamerule doMobSpawning false
gamerule doDaylightCycle false
time set 229000
fill -202 68 -632 -200 72 -630 minecraft:glass
fill -201 69 -631 -201 71 -631 minecraft:air
tp @s -145.5 82 -630.5
execute at @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] run camera @s set minecraft:free pos ~ ~5 ~5 facing @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"]
