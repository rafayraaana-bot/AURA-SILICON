# Eight-core RV32I processor

`rtl/rv32i_8core.sv` instantiates eight copies of the validated five-stage
`rv32i_core`. Every core executes independently and has its own combinational
instruction-memory port and aligned 32-bit data-memory port. The eight cores
share clock and active-low reset; each port group occupies its corresponding
32-bit slice in the top-level packed buses.

The design does not include caches, cache coherence, a shared-memory fabric,
interrupts, privileged execution, or atomic operations. Integrators must supply
memory and arbitration externally if the processors need to communicate or
share devices. It is an open, generic RV32I design, not an Intel implementation.

## Verify

With the project's WSL OpenLane environment installed, run:

```bash
bash scripts/check-rv32i-8core-wsl.sh
```

The self-checking test executes a different short program on each core and
verifies each independent data-memory write; the same script runs Verilator
lint and Yosys hierarchy/synthesis checks.

## Physical design

Import this folder into AURA and run the consent-gated local OpenLane 2 + SKY130
flow with `rv32i_8core` as the top module. The resulting GDSII and netlist are
real RTL-derived open-PDK physical-design artifacts, not an Intel mask layout.
They do not mean a chip was fabricated; fabrication readiness additionally
requires process-specific signoff, foundry checks, and an actual fabrication
run, none of which this project claims.
