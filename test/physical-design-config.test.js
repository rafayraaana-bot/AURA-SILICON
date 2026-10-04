import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenLaneConfig, estimateTopModuleIoPins, normalizeOpenLaneMetricsJson } from '../src/physical-design.js';

test('sizes the OpenLane die for all explicitly declared top-level bus pins', () => {
  const files = [{
    name: 'alu_128.sv',
    content: `module alu_128 (
      input logic [127:0] operand_a,
      input logic [127:0] operand_b,
      input logic [3:0] opcode,
      output logic [127:0] result,
      output logic carry_out,
      output logic overflow,
      output logic zero,
      output logic negative,
      output logic valid_opcode
    ); endmodule`
  }];

  assert.equal(estimateTopModuleIoPins('alu_128', files), 393);
  const config = createOpenLaneConfig('alu_128', ['dir::rtl/alu_128.sv'], files);
  assert.equal(config.CLOCK_PERIOD, 100);
  assert.ok(config.DIE_AREA[2] >= 500);
  assert.ok((config.DIE_AREA[2] * 4) > 1336.2);
  assert.deepEqual(config.CORE_AREA, [25, 25, config.DIE_AREA[2] - 25, config.DIE_AREA[2] - 25]);
});

test('scales the floorplan perimeter for very wide tops and grouped ANSI ports', () => {
  const files = [{
    name: 'wide.sv',
    content: `module wide (
      input logic [1023:0] a, b,
      output logic [1023:0] result
    ); endmodule`
  }];

  assert.equal(estimateTopModuleIoPins('wide', files), 3072);
  const config = createOpenLaneConfig('wide', ['dir::rtl/wide.sv'], files);
  assert.ok(config.DIE_AREA[2] > 500);
  assert.ok(config.DIE_AREA[2] * 4 >= (3072 / 0.29 * 1.25));
});

test('ignores comments and resolves simple parameterized ANSI port widths', () => {
  const files = [{
    name: 'controller.sv',
    content: `// module controller(input logic phantom);
      module controller #(parameter WIDTH = 16) (
        input logic clk,
        input logic reset_n,
        input logic [WIDTH-1:0] data,
        output logic ready
      ); endmodule`
  }];

  assert.equal(estimateTopModuleIoPins('controller', files), 19);
  assert.ok(createOpenLaneConfig('controller', ['dir::rtl/controller.sv'], files).DIE_AREA[2] >= 500);
});

test('sets a conservative 25 ns OpenLane clock budget for a clocked top module', () => {
  const files = [{
    name: 'pipeline.sv',
    content: `module pipeline (
      input logic clk_i,
      input logic data_i,
      output logic data_o
    ); endmodule`
  }];

  const config = createOpenLaneConfig('pipeline', ['dir::rtl/pipeline.sv'], files);
  assert.equal(config.CLOCK_PERIOD, 25);
});

test('reserves a larger floorplan for the eight-core RV32I processor and its per-core buses', () => {
  const files = [{
    name: 'rv32i_8core.sv',
    content: `module rv32i_8core (
      input logic clk_i,
      input logic reset_ni,
      output logic [255:0] instr_addr_o,
      input logic [255:0] instr_rdata_i,
      output logic [7:0] data_req_o,
      output logic [7:0] data_we_o,
      output logic [31:0] data_wstrb_o,
      output logic [255:0] data_addr_o,
      output logic [255:0] data_wdata_o,
      input logic [255:0] data_rdata_i
    ); endmodule`
  }];

  const config = createOpenLaneConfig('rv32i_8core', ['dir::rtl/rv32i_8core.sv'], files, { minimumDieSide: 1800 });
  assert.equal(estimateTopModuleIoPins('rv32i_8core', files), 1330);
  assert.deepEqual(config.DIE_AREA, [0, 0, 1800, 1800]);
  assert.deepEqual(config.CORE_AREA, [90, 90, 1710, 1710]);
  assert.equal(config.CLOCK_PERIOD, 25);
});

test('normalizes non-finite OpenLane metrics to valid JSON null values', () => {
  const content = Buffer.from('{"unconstrained":Infinity,"negative":-Infinity,"unknown":NaN}');
  assert.deepEqual(JSON.parse(normalizeOpenLaneMetricsJson(content)), {
    unconstrained: null,
    negative: null,
    unknown: null
  });
});
