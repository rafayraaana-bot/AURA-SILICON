# RV32I five-stage processor

`rv32i_core.sv` is a synthesizable, in-order, 32-bit RV32I integer core with
IF, ID, EX, MEM, and WB pipeline stages. It uses separate combinational
instruction and aligned 32-bit data-memory interfaces.

Implemented RV32I integer instructions include LUI/AUIPC, JAL/JALR, all six
conditional branches, signed/unsigned byte/halfword/word loads, byte/halfword/
word stores, immediate and register ALU operations, and FENCE as a no-op.
Forwarding covers both ALU operands and store data; load-use dependencies stall
the pipeline, and taken branches/jumps flush wrong-path instructions. Register
x0 always reads as zero.

The memory interface expects combinational instruction/data reads and captures
data writes on the rising clock edge. Loads and stores must be naturally
aligned; misaligned accesses, privileged instructions, interrupts, atomics,
compressed instructions, caches, MMU, and bus wait states are not implemented.
Invalid/reserved encodings are treated as no-ops, not architectural traps.

## Self-checking simulation

The testbench exercises data forwarding, load-use stall, branch/jump flushing,
register links, ALU immediates, signed/unsigned branches, and byte/halfword
loads and stores:

```bash
bash scripts/check-rv32i-wsl.sh
```

The script runs Icarus self-checks, Verilator lint, and Yosys synthesis checks
inside the same pinned OpenLane Nix environment. The testbench must pass before
starting the separate, consent-gated local OpenLane 2 + SKY130 physical-design
run. A generated layout is a real RTL-derived physical result, but is not a
foundry signoff claim.
