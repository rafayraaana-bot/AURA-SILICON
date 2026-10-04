# OpenLane 2 on WSL

This setup adds a reproducible, local OpenLane 2 + SKY130 flow for testing the
checked-in AND-gate example. It does not make AURA's web workspace claim that
arbitrary projects have completed physical design. The OpenLane run must finish
successfully before its own run directory contains physical artifacts.

## Prerequisites

- Windows 10/11 with WSL 2 and Ubuntu 20.04 or newer.
- CPU virtualization enabled in UEFI/BIOS and WSL 2 able to start.
- A normal Ubuntu WSL user with `sudo` (the setup script deliberately refuses to run as `root`).
- Internet access and several gigabytes of free disk space. SKY130 PDK builds
  are large and are stored inside the WSL distribution by default.

If WSL has just been installed or Windows optional features were changed,
restart Windows before continuing. Verify Ubuntu opens as a normal Linux user:

```bash
id -un
```

If it prints `root`, create a named Linux user from an Ubuntu root shell, add
that user to `sudo`, and set it as the default WSL user before running the EDA
setup. Do not run the setup as root.

## Install

From the copied AURA project directory inside Ubuntu:

```bash
bash scripts/setup-eda-wsl.sh
```

The script installs Nix using the official Determinate installer with OpenLane's
documented binary cache, checks out OpenLane 2, downloads the exact SKY130
`open_pdks` revision pinned by that checkout, enables `sky130A`, and runs
OpenLane's smoke test. It does not overwrite an existing OpenLane checkout.

The defaults keep tool sources and the PDK outside the project:

- OpenLane checkout: `~/.local/share/aura-silicon/openlane2`
- PDK root: `~/.volare`
- Enabled SKY130A directory: `~/.volare/sky130A`

Installing the Python `volare` command does not download or enable the PDK.
The setup script uses the OpenLane-pinned `open_pdks` revision, enables
`sky130`, checks for the resulting `sky130A` directory, and saves a custom
`AURA_PDK_ROOT` in `~/.config/aura-silicon/pdk-root` for later status checks
and web jobs. Set `AURA_OPENLANE_DIR` or `AURA_PDK_ROOT` before setup to choose
different locations.

The Docker Desktop workspace cannot call Windows `wsl.exe` from inside its
Linux container. Use the native Windows server, normally `http://localhost:3000`,
for WSL-backed physical-design jobs; the Docker-served workspace reports this
limitation instead of advertising a runnable job.

## Run the saved example

```bash
bash scripts/run-openlane-wsl.sh examples/and-gate/config.json
```

OpenLane writes run logs and physical-design artifacts in its run directory
alongside the design config. The RTL/testbench example remains in
`examples/and-gate`; OpenLane does not edit the source files.

## Workspace integration and limits

The AURA workspace can launch a local OpenLane 2 + SKY130 job from the selected
project after the user chooses a top module and explicitly authorizes local
execution. Jobs use a versioned RTL snapshot. A job is marked complete only
after OpenLane succeeds and produces both final GDSII and a synthesized
Verilog netlist; those real files are then available as organization-scoped
downloads. The workspace reports setup failures instead of presenting a
success-shaped result when WSL or the toolchain is unavailable.
For a top module with a recognized clock input, AURA assigns OpenLane a
conservative 25 ns clock period (40 MHz); a clockless design uses a 100 ns
virtual timing period for its combinational I/O paths. These are initial flow
constraints, not measured silicon performance or a signoff claim.

The authenticated workspace viewer shows verified layouts only after a completed
RTL-backed OpenLane run has verified a real GDSII artifact. Each completed web job extracts
polygon geometry from the verified final GDSII using the OpenLane environment's
KLayout and stores it alongside the GDSII, netlist, and metrics. The authenticated
`/visualizer` page loads only completed jobs and downloads artifacts through the
organization-scoped artifact API. Three.js renders the extracted X/Y polygons as
an interactive exploded 3D layer view; the 2D top-down view is also available.
The 3D viewer provides a camera reset and optional auto-rotation controls.
Layer spacing in the 3D view is expanded for visibility because GDSII does not
provide fabricated Z thicknesses. An optional i7-1165G7-inspired educational
floorplan is available separately at `/visualizer?concept=i7`; it is labeled as
illustrative and is not Intel design data, verified GDSII, or a physical-design
result.

The `examples/rv32i-8core` directory contains an open eight-core RV32I design
for users who want a real multi-core RTL-derived layout. It instantiates eight
validated five-stage cores with separate per-core instruction and data memory
interfaces and a larger OpenLane floorplan. Run
`bash scripts/check-rv32i-8core-wsl.sh` before importing it and selecting
`rv32i_8core` as the physical-design top module. The design requires external
memory integration for communication; it has no cache-coherence fabric.
OpenLane GDSII is a routed SKY130 design artifact, not an assertion that a
physical chip was fabricated or that foundry signoff has passed.
Congestion analysis and physical signoff validation remain
**not implemented**. Toolchain availability by itself
is not evidence that a project has completed placement, routing, or generated a
layout. Only artifacts verified from a completed OpenLane run are reported.
