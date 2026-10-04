#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openlane_dir="${AURA_OPENLANE_DIR:-${HOME}/.local/share/aura-silicon/openlane2}"

bash "${repo_root}/scripts/test-alu-128-wsl.sh"

if [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi
if [[ ! -f "${openlane_dir}/flake.nix" ]]; then
  echo "OpenLane's pinned Verilator/Yosys environment is not installed." >&2
  exit 1
fi

(
  cd "${openlane_dir}"
  nix-shell --run "cd '${repo_root}' && verilator --lint-only --Wall --top-module alu_128 examples/alu-128/rtl/alu_128.sv && yosys -Q -p 'read_verilog -sv examples/alu-128/rtl/alu_128.sv; hierarchy -check -top alu_128; proc; opt; check -assert; stat'"
)
