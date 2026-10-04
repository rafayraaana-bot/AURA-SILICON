import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateProjectPath } from './hardware-project.js';

const execFileAsync = promisify(execFile);
const sourceExtensions = new Set(['.v', '.sv', '.vh', '.svh']);
const testbenchPathPattern = /(^|\/)(tb|testbench|tests?)(\/|$)|(?:^|[_\-.])(tb|testbench)(?:[_\-.]|$)/i;
const modulePattern = /\bmodule\s+(?:automatic\s+|static\s+)?([A-Za-z_$][\w$]*)\b/g;
const dangerousSystemTaskPattern = /\$\s*(?:system|fopen|fclose|fseek|ftell|rewind|fgetc|fgets|fscanf|fread|fwrite|fdisplay|fmonitor|readmemh|readmemb|writememh|writememb|dumpfile)\b/i;
const includePattern = /^\s*`include\s+"([^"]+)"/gm;
const maxCompileTimeMs = 20000;
const maxRunTimeMs = 10000;
const maxOutputBytes = 1024 * 1024;

function findSimulatorPaths() {
  const windowsBin = 'C:\\iverilog\\bin';
  return {
    compilerPath: process.env.AURA_IVERILOG_PATH?.trim() ||
      (process.platform === 'win32' && fs.existsSync(path.join(windowsBin, 'iverilog.exe'))
        ? path.join(windowsBin, 'iverilog.exe')
        : process.platform === 'win32' ? null : 'iverilog'),
    runtimePath: process.env.AURA_VVP_PATH?.trim() ||
      (process.platform === 'win32' && fs.existsSync(path.join(windowsBin, 'vvp.exe'))
        ? path.join(windowsBin, 'vvp.exe')
        : process.platform === 'win32' ? null : 'vvp')
  };
}

export function getSimulationStatus() {
  const { compilerPath, runtimePath } = findSimulatorPaths();
  if (!compilerPath || !runtimePath) {
    return {
      available: false,
      simulator: 'Icarus Verilog',
      reason: 'Configure AURA_IVERILOG_PATH and AURA_VVP_PATH to the installed Icarus Verilog executables.'
    };
  }
  if ((path.isAbsolute(compilerPath) && !fs.existsSync(compilerPath)) ||
      (path.isAbsolute(runtimePath) && !fs.existsSync(runtimePath))) {
    return {
      available: false,
      simulator: 'Icarus Verilog',
      reason: 'The configured Icarus Verilog executable path does not exist.'
    };
  }
  return { available: true, simulator: 'Icarus Verilog', compilerPath, runtimePath, reason: null };
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
}

function safeChildEnvironment(executablePath) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const systemPath = process.env.PATH || '';
  const executableDir = path.isAbsolute(executablePath) ? path.dirname(executablePath) : '';
  env.PATH = [executableDir, systemPath].filter(Boolean).join(path.delimiter);
  return env;
}

export function getTestbenchModules(project) {
  const files = (project.sourceFiles || []).filter((file) =>
    sourceExtensions.has(path.posix.extname(file.name).toLowerCase()) &&
    (file.category === 'testbenches' || testbenchPathPattern.test(file.name))
  );
  return files.flatMap((file) => [...stripComments(file.content || '').matchAll(modulePattern)]
    .map((match) => ({ path: file.name, module: match[1] })));
}

export async function runIcarusSimulation({ project, testbenchPath: selectedPath, testbenchModule, onStart }) {
  const status = getSimulationStatus();
  if (!status.available) {
    const error = new Error(status.reason);
    error.code = 'SIMULATOR_NOT_FOUND';
    throw error;
  }
  if (!validateProjectPath(selectedPath)) {
    const error = new Error('Select a safe project-relative testbench path.');
    error.code = 'INVALID_TESTBENCH';
    throw error;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(testbenchModule)) {
    const error = new Error('Select a valid testbench module.');
    error.code = 'INVALID_TESTBENCH';
    throw error;
  }
  const allFiles = (project.sourceFiles || []).filter((file) =>
    sourceExtensions.has(path.posix.extname(file.name).toLowerCase()) &&
    (file.category === 'rtl' || !file.category || file.category === 'testbenches' || testbenchPathPattern.test(file.name))
  );
  const testbench = allFiles.find((file) => file.name === selectedPath &&
    (file.category === 'testbenches' || testbenchPathPattern.test(file.name)));
  if (!testbench || !getTestbenchModules(project).some((item) => item.path === selectedPath && item.module === testbenchModule)) {
    const error = new Error('The selected testbench module was not found in the selected project file.');
    error.code = 'INVALID_TESTBENCH';
    throw error;
  }
  const files = allFiles.filter((file) => file.name !== selectedPath || file === testbench);
  const knownNames = new Set(files.map((file) => file.name.replaceAll('\\', '/')));
  for (const file of files) {
    const source = stripComments(file.content || '');
    if (dangerousSystemTaskPattern.test(source)) {
      const error = new Error(`Simulation is blocked because ${file.name} uses a file or system task that can access resources outside the simulation workspace.`);
      error.code = 'UNSAFE_SIMULATION_SOURCE';
      throw error;
    }
    for (const [, includePath] of source.matchAll(includePattern)) {
      const normalizedInclude = path.posix.normalize(path.posix.join(path.posix.dirname(file.name.replaceAll('\\', '/')), includePath));
      if (!validateProjectPath(includePath) || !knownNames.has(normalizedInclude)) {
        const error = new Error(`Simulation is blocked because ${file.name} includes a file outside the selected project source set.`);
        error.code = 'UNSAFE_SIMULATION_INCLUDE';
        throw error;
      }
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content || '', 'utf8'), 0);
  if (files.length > 100 || totalBytes > 2 * 1024 * 1024) {
    const error = new Error('Simulation input exceeds the limit of 100 HDL files or 2 MiB.');
    error.code = 'SIMULATION_INPUT_TOO_LARGE';
    throw error;
  }

  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-simulation-'));
  try {
    for (const file of files) {
      if (!validateProjectPath(file.name)) {
        const error = new Error(`Simulation is blocked because ${file.name} is not a safe project-relative source path.`);
        error.code = 'UNSAFE_SIMULATION_PATH';
        throw error;
      }
      const target = path.resolve(workingDirectory, ...file.name.replaceAll('\\', '/').split('/'));
      if (!target.startsWith(`${workingDirectory}${path.sep}`)) {
        const error = new Error('Simulation source path escaped its isolated workspace.');
        error.code = 'UNSAFE_SIMULATION_PATH';
        throw error;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content || '', { encoding: 'utf8', flag: 'wx' });
    }
    const relativePaths = files.map((file) => file.name.replaceAll('\\', '/'));
    const imageName = 'aura-simulation.vvp';
    onStart?.();
    const compile = await execFileAsync(status.compilerPath, [
      '-g2012',
      '-s', testbenchModule,
      '-o', imageName,
      ...relativePaths
    ], {
      cwd: workingDirectory,
      env: safeChildEnvironment(status.compilerPath),
      timeout: maxCompileTimeMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      encoding: 'utf8'
    }).catch((error) => {
      const combined = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
      const failure = new Error(error.killed
        ? 'Icarus Verilog compilation exceeded its 20-second limit.'
        : error.code === 'ENOENT'
          ? 'Icarus Verilog compiler could not be started. Check AURA_IVERILOG_PATH.'
          : combined || error.message);
      failure.code = error.killed ? 'SIMULATION_COMPILE_TIMEOUT' : error.code === 'ENOENT' ? 'SIMULATOR_NOT_FOUND' : 'SIMULATION_COMPILE_FAILED';
      throw failure;
    });
    const runtimePath = path.resolve(workingDirectory, imageName);
    const run = await execFileAsync(status.runtimePath, ['-n', runtimePath], {
      cwd: workingDirectory,
      env: safeChildEnvironment(status.runtimePath),
      timeout: maxRunTimeMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
      encoding: 'utf8'
    }).catch((error) => {
      const combined = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
      const failure = new Error(error.killed
        ? 'Simulation exceeded its 10-second execution limit.'
        : combined || error.message);
      failure.code = error.killed ? 'SIMULATION_TIMEOUT' : 'SIMULATION_FAILED';
      throw failure;
    });
    return {
      simulator: status.simulator,
      testbench: selectedPath,
      topModule: testbenchModule,
      compileOutput: [compile.stdout, compile.stderr].filter(Boolean).join('\n').trim(),
      output: [run.stdout, run.stderr].filter(Boolean).join('\n').trim(),
      status: 'completed',
      sourceFiles: files.length
    };
  } finally {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  }
}
