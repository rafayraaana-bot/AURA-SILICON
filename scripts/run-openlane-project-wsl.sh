#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <design-directory> <artifact-directory>" >&2
  exit 2
fi

source_design_dir="$(realpath "$1")"
artifact_dir="$(realpath -m "$2")"
design_dir="$(mktemp -d /tmp/aura-openlane-project.XXXXXX)"
trap 'rm -rf -- "${design_dir}"' EXIT
cp -a "${source_design_dir}/." "${design_dir}/"
config_path="${design_dir}/config.json"
openlane_dir="${AURA_OPENLANE_DIR:-${HOME}/.local/share/aura-silicon/openlane2}"
pdk_root="${AURA_PDK_ROOT:-${PDK_ROOT:-}}"
if [[ -z "${pdk_root}" && -f "${HOME}/.config/aura-silicon/pdk-root" ]]; then
  IFS= read -r pdk_root < "${HOME}/.config/aura-silicon/pdk-root"
fi
pdk_root="${pdk_root:-${HOME}/.volare}"

if [[ ! -f "${config_path}" ]]; then
  echo "Generated OpenLane config is missing." >&2
  exit 2
fi
if [[ ! -f "${openlane_dir}/flake.nix" || ! -d "${pdk_root}/sky130A" ]]; then
  echo "OpenLane 2 and the SKY130 PDK are required. Run scripts/setup-eda-wsl.sh first." >&2
  exit 1
fi
if [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

mkdir -p "${artifact_dir}"
(
  cd "${openlane_dir}"
  export PDK_ROOT="${pdk_root}"
  nix-shell --run "timeout --signal=TERM 7200 openlane --pdk-root '${pdk_root}' '${config_path}'"
)

python3 - "${design_dir}" "${artifact_dir}" <<'PY'
import os
import shutil
import sys

design_dir, artifact_dir = sys.argv[1:]
run_root = os.path.join(design_dir, "runs")
if not os.path.isdir(run_root):
    raise SystemExit("OpenLane did not create a run directory.")

files = []
for root, _dirs, names in os.walk(run_root):
    for name in names:
        full_path = os.path.join(root, name)
        if "/final/" in full_path.replace(os.sep, "/"):
            files.append(full_path)

def latest(paths):
    return max(paths, key=os.path.getmtime) if paths else None

gds = latest([item for item in files if item.lower().endswith(".gds")])
netlist = latest([
    item for item in files
    if item.lower().endswith(".v") and "/nl/" in item.replace(os.sep, "/")
])
if not netlist:
    netlist = latest([item for item in files if item.lower().endswith(".v")])
metrics = latest([
    item for item in files
    if item.lower().endswith(".json") and "metric" in os.path.basename(item).lower()
])

if not gds:
    raise SystemExit("OpenLane completed without a final GDSII layout.")
if not netlist:
    raise SystemExit("OpenLane completed without a final synthesized Verilog netlist.")

shutil.copyfile(gds, os.path.join(artifact_dir, "layout.gds"))
shutil.copyfile(netlist, os.path.join(artifact_dir, "final-netlist.v"))
if metrics:
    shutil.copyfile(metrics, os.path.join(artifact_dir, "openlane-metrics.json"))
print("AURA_OPENLANE_ARTIFACTS_READY")
PY

(
  cd "${openlane_dir}"
  export PDK_ROOT="${pdk_root}"
  nix-shell --run "klayout -b -r '$(dirname "$(realpath "$0")")/export-gds-preview.py' -rd input='${artifact_dir}/layout.gds' -rd output='${artifact_dir}/layout-preview.json'"
)
