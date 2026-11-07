# COPIED FIXTURE WORLD ONLY. Root manually verifies exactly1 canonical guard/health30.
# Bounded Overworld Spectator source; no selector count truncation.
execute in overworld if entity @s[type=minecraft:player,m=spectator,x=-145.5,y=82,z=-630.5,r=128] if entity @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] unless entity @e[name="CA_CombatFixture"] unless entity @e[family=mob,x=-200.5,y=69,z=-630.5,r=4] unless entity @e[type=!minecraft:player,x=-202,y=68,z=-632,dx=2,dy=4,dz=2] run function ca_combat_fixture/internal/prepare_body
