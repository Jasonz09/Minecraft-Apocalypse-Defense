# COPIED FIXTURE WORLD ONLY. Root manually verifies exactly1 canonical guard/health30.
# Bounded Overworld Spectator source; no selector count truncation.
execute in overworld if entity @s[type=minecraft:player,m=spectator,x=-145.5,y=82,z=-630.5,r=128] if entity @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] at @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] run camera @s set minecraft:free pos ~ ~5 ~5 facing @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"]
