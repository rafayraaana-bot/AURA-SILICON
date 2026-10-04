# AURA 128-bit ALU example

This synthesizable combinational ALU is a local, deterministic RTL example; it
does not require or send code to an AI provider.

`rtl/alu_128.sv` implements:

- 128-bit addition and subtraction, with unsigned carry/no-borrow and signed
  overflow flags.
- AND, OR, XOR, and NOT.
- Logical left/right shifts, arithmetic right shift, and rotate left/right.
  `operand_b[6:0]` selects a shift/rotate amount from 0 through 127.
- Equality, signed less-than, and unsigned less-than.
- Zero, negative, and valid-opcode status outputs.

For operations other than ADD/SUB, `carry_out` and `overflow` are zero. An
unsupported opcode returns zero result/flags and clears `valid_opcode`.

| Opcode | Operation |
| --- | --- |
| `0x0` | ADD |
| `0x1` | SUB |
| `0x2`–`0x5` | AND, OR, XOR, NOT |
| `0x6`–`0x8` | Logical left, logical right, arithmetic right shift |
| `0x9`–`0xA` | Rotate left, rotate right |
| `0xB`–`0xD` | Equal, signed less-than, unsigned less-than |
| `0xE`–`0xF` | Reserved/invalid |

## Run the self-checking testbench

From the repository root in WSL:

```bash
bash scripts/check-alu-128-wsl.sh
```

The testbench checks every opcode, carry/borrow and signed-overflow boundaries,
the full-width shift endpoints, arithmetic sign extension, rotations, and
invalid-opcode behavior. Success prints `AURA_ALL_TESTS_PASS`.

The design may also be imported into AURA SILICON as a project folder. Running
OpenLane for this ALU is a separate physical-design action and requires its own
explicit local execution consent.
