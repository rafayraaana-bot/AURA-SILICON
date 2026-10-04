import json
import os

import pya


input_path = os.path.abspath(globals().get("input", ""))
output_path = os.path.abspath(globals().get("output", ""))
if not os.path.isfile(input_path) or not output_path:
    raise RuntimeError("KLayout requires valid input and output paths.")

layout = pya.Layout()
layout.read(input_path)
cell = layout.top_cell()
if cell is None:
    raise RuntimeError("GDSII contains no top cell.")

cell.flatten(-1)
bounds = cell.bbox()
if bounds.empty():
    raise RuntimeError("GDSII top cell contains no layout geometry.")

max_polygons = 25000
layers = []
polygon_count = 0
layer_indexes = list(layout.layer_indexes())
polygon_counts = {
    layer_index: sum(
        1 for shape in cell.shapes(layer_index).each()
        if shape.is_box() or shape.is_polygon() or shape.is_path()
    )
    for layer_index in layer_indexes
}
populated_layers = [layer_index for layer_index in layer_indexes if polygon_counts[layer_index]]
layer_quotas = {layer_index: 0 for layer_index in populated_layers}
active_layers = populated_layers
remaining_budget = max_polygons

while remaining_budget and active_layers:
    base_quota, extra_quota = divmod(remaining_budget, len(active_layers))
    next_active_layers = []
    allocated = 0
    for position, layer_index in enumerate(active_layers):
        quota = base_quota + (position < extra_quota)
        available = polygon_counts[layer_index] - layer_quotas[layer_index]
        addition = min(quota, available)
        layer_quotas[layer_index] += addition
        allocated += addition
        if addition < available:
            next_active_layers.append(layer_index)
    remaining_budget -= allocated
    active_layers = next_active_layers

for layer_index in populated_layers:
    info = layout.get_info(layer_index)
    polygons = []
    quota = layer_quotas[layer_index]
    if quota == 0:
        continue
    eligible_index = 0
    next_sample = 0
    for shape in cell.shapes(layer_index).each():
        if not (shape.is_box() or shape.is_polygon() or shape.is_path()):
            continue
        sample_index = next_sample * polygon_counts[layer_index] // quota
        should_sample = eligible_index == sample_index
        eligible_index += 1
        if not should_sample:
            continue
        next_sample += 1
        if shape.is_box():
            polygon = pya.Polygon(shape.box)
        elif shape.is_path():
            polygon = shape.path.polygon()
        else:
            polygon = shape.polygon

        points = [[point.x * layout.dbu, point.y * layout.dbu] for point in polygon.each_point_hull()]
        if len(points) < 3:
            continue
        polygons.append(points)
        polygon_count += 1

    if polygons:
        layers.append({
            "layer": int(info.layer),
            "datatype": int(info.datatype),
            "polygons": polygons
        })

truncated = sum(polygon_counts.values()) > polygon_count

if polygon_count == 0:
    raise RuntimeError("GDSII contains no supported box, path, or polygon geometry.")

result = {
    "format": "AURA_GDSII_LAYOUT_PREVIEW",
    "units": "um",
    "topCell": cell.name,
    "bounds": [
        bounds.left * layout.dbu,
        bounds.bottom * layout.dbu,
        bounds.right * layout.dbu,
        bounds.top * layout.dbu
    ],
    "polygonCount": polygon_count,
    "sourcePolygonCount": sum(polygon_counts.values()),
    "truncated": truncated,
    "layers": layers
}

with open(output_path, "w", encoding="utf-8") as preview:
    json.dump(result, preview, separators=(",", ":"))
