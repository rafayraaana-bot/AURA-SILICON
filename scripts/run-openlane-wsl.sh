#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <OpenLane-config.json>" >&2
  exit 2
fi

source_config_path="$(realpath "$1")"
if [[ ! -f "${source_config_path}" || "${source_config_path##*.}" != "json" ]]; then
  echo "OpenLane config must be an existing .json file." >&2
  exit 2
fi

source_design_dir="$(dirname "${source_config_path}")"
run_design_dir="$(mktemp -d /tmp/aura-openlane-example.XXXXXX)"
trap 'rm -rf -- "${run_design_dir}"' EXIT
find "${source_design_dir}" -mindepth 1 -maxdepth 1 ! -name runs \
  -exec cp -a -- {} "${run_design_dir}/" \;
config_path="${run_design_dir}/$(basename "${source_config_path}")"

openlane_dir="${AURA_OPENLANE_DIR:-${HOME}/.local/share/aura-silicon/openlane2}"
pdk_root="${AURA_PDK_ROOT:-${PDK_ROOT:-}}"
if [[ -z "${pdk_root}" && -f "${HOME}/.config/aura-silicon/pdk-root" ]]; then
  IFS= read -r pdk_root < "${HOME}/.config/aura-silicon/pdk-root"
fi
pdk_root="${pdk_root:-${HOME}/.volare}"

if [[ ! -f "${openlane_dir}/flake.nix" ]]; then
  echo "OpenLane 2 is not installed. Run scripts/setup-eda-wsl.sh first." >&2
  exit 1
fi

if [[ ! -d "${pdk_root}/sky130A" ]]; then
  echo "SKY130A PDK is not enabled at ${pdk_root}. Run scripts/setup-eda-wsl.sh first." >&2
  exit 1
fi

if [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi

printf -v command 'openlane --pdk-root %q %q' "${pdk_root}" "${config_path}"
cd "${openlane_dir}"
export PDK_ROOT="${pdk_root}"
nix-shell --run "${command}"
if [[ -d "${run_design_dir}/runs" ]]; then
  mkdir -p "${source_design_dir}/runs"
  cp -a "${run_design_dir}/runs/." "${source_design_dir}/runs/"
fi
