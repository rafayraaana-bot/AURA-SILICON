import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRtl } from '../src/compiler.js';

test('compiles the same immutable RTL deterministically', () => {
  const source = `module top(input logic clk, input logic data, output logic result);
assign result = data & clk;
endmodule
`;
  const input = {
    files: [{ name: 'top.sv', content: source }],
    projectVersionId: 'version-fixed'
  };
  const first = compileRtl(input);
  const second = compileRtl(input);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.ir.designHash, second.ir.designHash);
  assert.deepEqual(first.artifact, second.artifact);
  assert.deepEqual(first.ir.modules[0].ports.map((port) => port.name), ['clk', 'data', 'result']);
  const nextVersion = compileRtl({ ...input, projectVersionId: 'version-next' });
  assert.equal(nextVersion.ir.designHash, first.ir.designHash);
});

test('reports unsupported procedural syntax rather than silently accepting it', () => {
  const result = compileRtl({
    files: [{ name: 'top.sv', content: 'module top; always @(posedge clk) begin end endmodule' }],
    projectVersionId: 'version-invalid'
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'RTL_CONSTRUCT_UNSUPPORTED'));
});

test('rejects packed widths instead of emitting widthless IR', () => {
  const result = compileRtl({
    files: [{ name: 'top.sv', content: 'module top(input logic [7:0] data); endmodule' }],
    projectVersionId: 'version-width'
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'RTL_PORT_WIDTH_UNSUPPORTED'));
});
