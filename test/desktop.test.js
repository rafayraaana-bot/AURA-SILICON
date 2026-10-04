import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanProjectFolder, validateRelativePath, writeExportDirectory } = require('../desktop/project-files.cjs');

test('native desktop folder scan reads supported project text and excludes secrets and dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-desktop-scan-'));
  try {
    await fs.mkdir(path.join(root, 'rtl'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'sample'), { recursive: true });
    await fs.writeFile(path.join(root, 'rtl', 'cpu.sv'), 'module cpu; endmodule');
    await fs.writeFile(path.join(root, '.env'), 'AUTH_TOKEN=not-imported');
    await fs.writeFile(path.join(root, 'node_modules', 'sample', 'ignored.sv'), 'module ignored; endmodule');
    await fs.writeFile(path.join(root, 'bitstream.bin'), Buffer.from([0, 1, 2]));

    const result = await scanProjectFolder(root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'rtl/cpu.sv');
    assert.equal(result.files[0].content, 'module cpu; endmodule');
    assert.ok(result.excludedFiles.some((file) => file.code === 'SENSITIVE_FILE_EXCLUDED'));
    assert.ok(result.excludedFiles.some((file) => file.code === 'UNSUPPORTED_FILE'));
    assert.equal(result.excludedFiles.some((file) => file.path.includes('node_modules')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop project paths reject traversal and exports create a new isolated copy', async () => {
  assert.equal(validateRelativePath('../outside.sv'), false);
  assert.equal(validateRelativePath('rtl/..\\outside.sv'), false);
  assert.equal(validateRelativePath('rtl/cpu.sv'), true);

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-desktop-export-'));
  try {
    const exportedPath = await writeExportDirectory(parent, 'CPU Project', [
      { path: 'rtl/cpu.sv', content: 'module cpu; endmodule' },
      { path: 'constraints/timing.sdc', content: 'create_clock -period 10 clk' }
    ]);
    assert.equal(await fs.readFile(path.join(exportedPath, 'rtl', 'cpu.sv'), 'utf8'), 'module cpu; endmodule');
    assert.equal(await fs.readFile(path.join(exportedPath, 'constraints', 'timing.sdc'), 'utf8'), 'create_clock -period 10 clk');

    await assert.rejects(
      writeExportDirectory(parent, 'Unsafe Project', [{ path: '../outside.sv', content: 'bad' }]),
      /invalid project-relative file/
    );
    await assert.rejects(fs.access(path.join(parent, 'outside.sv')));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
