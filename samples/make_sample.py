import ezdxf, math
doc = ezdxf.new("R2010", setup=True)
doc.units = ezdxf.units.MM
msp = doc.modelspace()
for name, color in [("A-WALL", 7), ("A-DOOR", 3), ("A-WIND", 4), ("A-GRID", 8), ("A-DIMS", 2), ("A-TEXT", 7), ("A-FURN", 6), ("A-STAIR", 5)]:
    doc.layers.add(name, color=color)
W, H = 24000, 15000
# grid
xs = [0, 6000, 12000, 18000, 24000]; ys = [0, 7500, 15000]
for i, x in enumerate(xs):
    msp.add_line((x, -2500), (x, H + 2500), dxfattribs={"layer": "A-GRID", "linetype": "CENTER"})
    msp.add_circle((x, H + 3200), 700, dxfattribs={"layer": "A-GRID"})
    msp.add_text(str(i + 1), height=600, dxfattribs={"layer": "A-GRID"}).set_placement((x, H + 3200), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
for j, y in enumerate(ys):
    msp.add_line((-2500, y), (W + 2500, y), dxfattribs={"layer": "A-GRID", "linetype": "CENTER"})
    msp.add_circle((-3200, y), 700, dxfattribs={"layer": "A-GRID"})
    msp.add_text("ABC"[j], height=600, dxfattribs={"layer": "A-GRID"}).set_placement((-3200, y), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
# walls (outer double line)
t = 200
msp.add_lwpolyline([(-t, -t), (W + t, -t), (W + t, H + t), (-t, H + t)], close=True, dxfattribs={"layer": "A-WALL"})
msp.add_lwpolyline([(t, t), (W - t, t), (W - t, H - t), (t, H - t)], close=True, dxfattribs={"layer": "A-WALL"})
for x in (6000, 12000, 18000):
    msp.add_line((x - 100, t), (x - 100, H - t), dxfattribs={"layer": "A-WALL"})
    msp.add_line((x + 100, t), (x + 100, H - t), dxfattribs={"layer": "A-WALL"})
msp.add_line((t, 7400), (W - t, 7400), dxfattribs={"layer": "A-WALL"})
msp.add_line((t, 7600), (W - t, 7600), dxfattribs={"layer": "A-WALL"})
# columns (hatched squares)
for x in xs:
    for y in ys:
        h = msp.add_hatch(color=7, dxfattribs={"layer": "A-WALL"})
        h.paths.add_polyline_path([(x - 300, y - 300), (x + 300, y - 300), (x + 300, y + 300), (x - 300, y + 300)], is_closed=True)
# doors (arc swings)
for x in (3000, 9000, 15000, 21000):
    msp.add_line((x, 7600), (x, 8500), dxfattribs={"layer": "A-DOOR"})
    msp.add_arc((x, 7600), 900, 0, 90, dxfattribs={"layer": "A-DOOR"})
# windows
for x in (1500, 7500, 13500, 19500):
    for y in (-t, H + t):
        msp.add_line((x, y - 100), (x + 3000, y - 100), dxfattribs={"layer": "A-WIND"})
        msp.add_line((x, y + 100), (x + 3000, y + 100), dxfattribs={"layer": "A-WIND"})
# stair
for k in range(12):
    msp.add_line((19000, 9000 + k * 280), (23000, 9000 + k * 280), dxfattribs={"layer": "A-STAIR"})
msp.add_line((21000, 9000), (21000, 12300), dxfattribs={"layer": "A-STAIR"})
# furniture (meeting table + chairs)
msp.add_lwpolyline([(7500, 10000), (10500, 10000), (10500, 12000), (7500, 12000)], close=True, dxfattribs={"layer": "A-FURN"})
for cx in (8000, 9000, 10000):
    msp.add_circle((cx, 9600), 250, dxfattribs={"layer": "A-FURN"})
    msp.add_circle((cx, 12400), 250, dxfattribs={"layer": "A-FURN"})
# room names
for (x, y, s) in [(3000, 11250, "OFFICE 1"), (9000, 13300, "MEETING"), (15000, 11250, "OFFICE 2"), (21000, 13300, "STAIR"),
                  (3000, 3750, "LOBBY"), (9000, 3750, "LOUNGE"), (15000, 3750, "STORAGE"), (21000, 3750, "RESTROOM")]:
    msp.add_text(s, height=450, dxfattribs={"layer": "A-TEXT"}).set_placement((x, y), align=ezdxf.enums.TextEntityAlignment.MIDDLE_CENTER)
msp.add_text("SAMPLE FLOOR PLAN  1:100", height=700, dxfattribs={"layer": "A-TEXT"}).set_placement((0, -5200))
# dimensions
for i in range(len(xs) - 1):
    msp.add_linear_dim(base=(0, -1800), p1=(xs[i], -t), p2=(xs[i + 1], -t), dxfattribs={"layer": "A-DIMS"}).render()
msp.add_linear_dim(base=(-1800, 0), p1=(-t, 0), p2=(-t, H), angle=90, dxfattribs={"layer": "A-DIMS"}).render()
doc.saveas("sample_floor_plan.dxf")
print("ok")
