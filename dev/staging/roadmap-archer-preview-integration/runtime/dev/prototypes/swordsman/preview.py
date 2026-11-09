"""Offline orthographic inspection of this prototype's actual rest-pose cubes/UVs.
Not a Minecraft renderer, animation test or native acceptance result. Requires Pillow.
"""
from pathlib import Path
import json
import math
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
geometry = json.loads((ROOT / "RP/models/entity/swordsman.geo.json").read_text())["minecraft:geometry"][0]
atlas = Image.open(ROOT / "RP/textures/entity/civ_trial/swordsman.png").convert("RGB")
bones = {b["name"]: b for b in geometry["bones"]}

def transformed(point, bone):
    p = list(point)
    pivot = bone.get("pivot", [0, 0, 0])
    p = [p[i] - pivot[i] for i in range(3)]
    for axis, degrees in enumerate(bone.get("rotation", [0, 0, 0])):
        a = math.radians(degrees)
        c, s = math.cos(a), math.sin(a)
        x, y, z = p
        p = ([x, y*c-z*s, y*s+z*c] if axis == 0 else
             [x*c+z*s, y, -x*s+z*c] if axis == 1 else
             [x*c-y*s, x*s+y*c, z])
    p = [p[i] + pivot[i] for i in range(3)]
    return transformed(p, bones[bone["parent"]]) if "parent" in bone else p

def view(p):
    yaw, pitch = math.radians(28), math.radians(13)
    x, y, z = p
    x, z = x*math.cos(yaw)+z*math.sin(yaw), -x*math.sin(yaw)+z*math.cos(yaw)
    return (x, y*math.cos(pitch)+z*math.sin(pitch), -y*math.sin(pitch)+z*math.cos(pitch))

polygons = []
for bone in bones.values():
    for cube in bone.get("cubes", []):
        x, y, z = cube["origin"]
        w, h, d = cube["size"]
        faces = {
            "north": [(x,y+h,z),(x+w,y+h,z),(x+w,y,z),(x,y,z)],
            "south": [(x+w,y+h,z+d),(x,y+h,z+d),(x,y,z+d),(x+w,y,z+d)],
            "east": [(x+w,y+h,z),(x+w,y+h,z+d),(x+w,y,z+d),(x+w,y,z)],
            "west": [(x,y+h,z+d),(x,y+h,z),(x,y,z),(x,y,z+d)],
            "up": [(x,y+h,z+d),(x+w,y+h,z+d),(x+w,y+h,z),(x,y+h,z)],
            "down": [(x,y,z),(x+w,y,z),(x+w,y,z+d),(x,y,z+d)]}
        for side, points in faces.items():
            shade = {"north":1,"south":.7,"east":.82,"west":.75,"up":1.1,"down":.6}[side]
            a, b, _, e = points
            uv = cube["uv"][side]
            # All authored faces use eight-by-eight atlas rectangles.
            for row in range(8):
                for column in range(8):
                    corners = []
                    for u, v in [(column/8,row/8),((column+1)/8,row/8),((column+1)/8,(row+1)/8),(column/8,(row+1)/8)]:
                        point = [a[i]+(b[i]-a[i])*u+(e[i]-a[i])*v for i in range(3)]
                        corners.append(view(transformed(point, bone)))
                    color = atlas.getpixel((int(uv["uv"][0]+column), int(uv["uv"][1]+row)))
                    polygons.append((sum(p[2] for p in corners)/4, corners, tuple(min(255,int(c*shade)) for c in color)))

image = Image.new("RGB", (560, 720), (231, 235, 238))
draw = ImageDraw.Draw(image)
draw.ellipse((125, 625, 440, 683), fill=(205, 213, 218))
for _, corners, color in sorted(polygons, key=lambda item: item[0], reverse=True):
    draw.polygon([(280+p[0]*19, 650-p[1]*19) for p in corners], fill=color)
draw.text((18, 15), "SWORDSMAN | original prototype geometry", fill=(30, 43, 55))
draw.text((18, 35), "Offline rest pose; Minecraft rendering untested", fill=(65, 78, 90))
image.save(ROOT / "preview.png")
print("Saved isolated geometry preview.png")
