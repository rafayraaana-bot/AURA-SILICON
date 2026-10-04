# AURA AND-gate simulation example

Import this folder into AURA SILICON to try the saved RTL and simulation flow.

- `rtl/top.sv`: two-input AND gate
- `tb/top_tb.sv`: self-checking testbench for all four input combinations

In the workspace, select the imported project, select `top_tb` in **RTL Simulation**, authorize local execution of the trusted HDL, and choose **Run Simulation**. A successful run prints `AURA_SIM_PASS: AND gate passed 4/4 vectors`.

The testbench demonstrates local functional simulation only; it does not synthesize or physically validate a chip.

An optional OpenLane 2 + SKY130 flow config is in `config.json`.
Follow [`../../docs/physical-design-wsl.md`](../../docs/physical-design-wsl.md)
to install the WSL toolchain, then run it from the AURA repository root with:

```bash
bash scripts/run-openlane-wsl.sh examples/and-gate/config.json
```
