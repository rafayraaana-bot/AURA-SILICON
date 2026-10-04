#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d /tmp/aura-alu-128.XXXXXX)"
trap 'rm -rf -- "${build_dir}"' EXIT
output_file="${build_dir}/simulation.log"

iverilog -g2012 -Wall -s alu_128_tb \
  -o "${build_dir}/alu_128_tb.vvp" \
  "${repo_root}/examples/alu-128/rtl/alu_128.sv" \
  "${repo_root}/examples/alu-128/tb/alu_128_tb.sv"
vvp "${build_dir}/alu_128_tb.vvp" | tee "${output_file}"
grep -q '^AURA_ALL_TESTS_PASS:' "${output_file}"
