#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
openlane_dir="${AURA_OPENLANE_DIR:-${HOME}/.local/share/aura-silicon/openlane2}"
temporary_dir="$(mktemp -d /tmp/aura-rv32i-8core-test.XXXXXX)"
trap 'rm -rf -- "${temporary_dir}"' EXIT

if [[ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]]; then
  # shellcheck disable=SC1091
  source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
fi
if [[ ! -f "${openlane_dir}/flake.nix" ]]; then
  echo "OpenLane's pinned Icarus/Verilator/Yosys environment is not installed." >&2
  exit 1
fi

(
  cd "${openlane_dir}"
  nix-shell --run "cd '${repo_root}' && \
    iverilog -g2012 -s rv32i_8core_tb -o '${temporary_dir}/rv32i-8core-test' \
      examples/rv32i-pipeline/rtl/rv32i_core.sv \
      examples/rv32i-8core/rtl/rv32i_8core.sv \
      examples/rv32i-8core/tb/rv32i_8core_tb.sv && \
    vvp '${temporary_dir}/rv32i-8core-test' && \
    verilator --lint-only --Wall --top-module rv32i_8core \
      examples/rv32i-pipeline/rtl/rv32i_core.sv \
      examples/rv32i-8core/rtl/rv32i_8core.sv && \
    yosys -Q -p 'read_verilog -sv examples/rv32i-pipeline/rtl/rv32i_core.sv examples/rv32i-8core/rtl/rv32i_8core.sv; \
      hierarchy -check -top rv32i_8core; proc; opt; check -assert; stat'"
)
