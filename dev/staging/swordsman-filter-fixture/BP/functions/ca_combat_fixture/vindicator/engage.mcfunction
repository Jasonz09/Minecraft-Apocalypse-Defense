# CONTROLLED TAGGED FILTER TEST, NOT real siege-owner integration.
# Manual exact1 actor/guard and fullHP; fresh owner-hour window REQUIRED.
# Invalidate if owner hour crosses, orphan removal or any command fails.
execute in overworld if entity @s[type=minecraft:player,m=spectator,x=-145.5,y=82,z=-630.5,r=128] if entity @e[type=civ_trial:swordsman,tag="civpop:v1:district-1:sol:1"] if entity @e[type=minecraft:vindicator,name="CA_CombatFixture"] unless entity @e[name="CA_CombatFixture",tag="civbesiege:v1"] run function ca_combat_fixture/vindicator/internal/engage_body
