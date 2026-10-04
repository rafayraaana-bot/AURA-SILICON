import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateProjectPath } from './hardware-project.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runTimeoutMs = 2 * 60 * 60 * 1000;
const maxArtifactBytes = 100 * 1024 * 1024;

export function normalizeOpenLaneMetricsJson(content) {
  const normalized = content.toString('utf8')
    .replace(/(^|[:,\s\[])(-?Infinity|NaN)(?=\s*[,}\]])/g, '$1null');
  return Buffer.from(JSON.stringify(JSON.parse(normalized)));
}

function decodeWslOutput(value) {
  if (!Buffer.isBuffer(value)) return String(value || '').trim();
  const utf16 = value.includes(0);
  return (utf16 ? value.toString('utf16le') : value.toString('utf8')).replace(/\0/g, '').trim();
}

async function runWsl(args, options = {}) {
  try {
    const result = await execFileAsync('wsl.exe', args, {
      encoding: 'buffer',
      timeout: options.timeout ?? 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { ok: true, stdout: decodeWslOutput(result.stdout), stderr: decodeWslOutput(result.stderr) };
  } catch (error) {
    return {
      ok: false,
      stdout: decodeWslOutput(error.stdout),
      stderr: decodeWslOutput(error.stderr),
      message: decodeWslOutput(error.stderr) || error.message
    };
  }
}

export async function getPhysicalDesignStatus() {
  if (process.platform !== 'win32') {
    return {
      available: false,
      toolchain: 'OpenLane 2 + SKY130',
      reason: 'OpenLane runs through Windows WSL and cannot be launched from the Docker/Linux server. Open the native Windows AURA server at http://localhost:3000 for local physical-design jobs.'
    };
  }

  const script = [
    'set -eu',
    'openlane_dir="${AURA_OPENLANE_DIR:-$HOME/.local/share/aura-silicon/openlane2}"',
    'pdk_root="${AURA_PDK_ROOT:-${PDK_ROOT:-}}"',
    'if [ -z "$pdk_root" ] && [ -f "$HOME/.config/aura-silicon/pdk-root" ]; then IFS= read -r pdk_root < "$HOME/.config/aura-silicon/pdk-root"; fi',
    'pdk_root="${pdk_root:-$HOME/.volare}"',
    'if [ "$(id -u)" -eq 0 ]; then echo AURA_WSL_ROOT_USER >&2; exit 2; fi',
    'if [ ! -f "$openlane_dir/flake.nix" ]; then echo AURA_OPENLANE_MISSING >&2; exit 2; fi',
    'if [ ! -d "$pdk_root/sky130A" ]; then echo AURA_SKY130A_MISSING >&2; exit 2; fi',
    'if [ ! -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then echo AURA_NIX_MISSING >&2; exit 2; fi',
    '. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh',
    'cd "$openlane_dir"',
    'nix-shell --run "openlane --help"'
  ].join('; ');
  const result = await runWsl(['--exec', 'bash', '-lc', script], { timeout: 60_000 });
  if (!result.ok) {
    let reason = 'OpenLane 2 or the SKY130 PDK is not ready in WSL. Run bash scripts/setup-eda-wsl.sh from the Ubuntu project directory.';
    if (result.message.includes('AURA_WSL_ROOT_USER')) {
      reason = 'Ubuntu WSL is running as root. Create and select a normal Ubuntu user with sudo, then run scripts/setup-eda-wsl.sh.';
    } else if (result.message.includes('AURA_OPENLANE_MISSING')) {
      reason = 'OpenLane 2 is not installed in this Ubuntu WSL user. Run scripts/setup-eda-wsl.sh as a normal Ubuntu user with sudo.';
    } else if (result.message.includes('AURA_SKY130A_MISSING')) {
      reason = 'The Volare command is installed, but SKY130A is not enabled at the configured PDK root. Run scripts/setup-eda-wsl.sh as a normal Ubuntu user.';
    } else if (result.message.includes('AURA_NIX_MISSING')) {
      reason = 'Nix is not installed for the Ubuntu WSL user. Run scripts/setup-eda-wsl.sh as a normal Ubuntu user with sudo.';
    } else if (result.message.includes('There is no distribution')) {
      reason = 'No WSL distribution is installed. Install and initialize Ubuntu, then run the OpenLane setup script.';
    } else if (result.message.includes('virtualization') || result.message.includes('WSL 2')) {
      reason = 'WSL 2 cannot start. Enable CPU virtualization in BIOS/UEFI and the Windows Virtual Machine Platform feature, then restart.';
    }
    return { available: false, toolchain: 'OpenLane 2 + SKY130', reason };
  }
  return {
    available: true,
    toolchain: 'OpenLane 2 + SKY130',
    version: 'OpenLane 2',
    reason: null
  };
}

async function toWslPath(localPath) {
  const result = await runWsl(['--exec', 'wslpath', '-a', localPath]);
  if (!result.ok || !result.stdout) {
    throw new Error(`WSL could not access the local OpenLane workspace: ${result.message}`);
  }
  return result.stdout;
}

function stageSources(workDir, topModule, files) {
  const rtlDir = path.join(workDir, 'rtl');
  fs.mkdirSync(rtlDir, { recursive: true, mode: 0o700 });
  const sourcePaths = [];
  let sourceBytes = 0;

  for (const file of files) {
    if (!validateProjectPath(file.name)) throw new Error(`Unsafe RTL source path: ${file.name}`);
    const extension = path.extname(file.name).toLowerCase();
    if (!['.v', '.sv', '.vh', '.svh'].includes(extension)) continue;
    sourceBytes += Buffer.byteLength(file.content, 'utf8');
    if (sourceBytes > 8 * 1024 * 1024) throw new Error('RTL input exceeds the 8 MiB physical-design limit.');
    if (/\x00/.test(file.content)) throw new Error(`RTL source contains binary data: ${file.name}`);
    if (/\x60include\s*["<]\s*(?:[\\/]|[A-Za-z]:|.*(?:^|[\\/])\.\.(?:[\\/]|$))/.test(file.content)) {
      throw new Error(`RTL includes must stay within the project RTL directory: ${file.name}`);
    }
    const destination = path.resolve(rtlDir, file.name);
    if (!destination.startsWith(`${rtlDir}${path.sep}`)) throw new Error(`Unsafe RTL source path: ${file.name}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, file.content, { flag: 'wx', mode: 0o600 });
    if (['.v', '.sv'].includes(extension)) {
      sourcePaths.push(`dir::rtl/${file.name.replace(/\\/g, '/')}`);
    }
  }

  if (!sourcePaths.length) throw new Error('No Verilog or SystemVerilog source files are available for synthesis.');
  const config = createOpenLaneConfig(topModule, sourcePaths, files, {
    minimumDieSide: topModule === 'rv32i_8core' ? 1800 : 500
  });
  fs.writeFileSync(path.join(workDir, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
}

function matchingParenthesis(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function splitPortDeclarations(ports) {
  const declarations = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < ports.length; index += 1) {
    if ('([{'.includes(ports[index])) depth += 1;
    else if (')]}'.includes(ports[index])) depth -= 1;
    else if (ports[index] === ',' && depth === 0) {
      declarations.push(ports.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(ports.slice(start));
  return declarations;
}

function parseIntegerLiteral(value) {
  const text = value.trim().replaceAll('_', '');
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  const based = text.match(/^(?:\d+)?'[sS]?([bBoOdDhH])([0-9a-fA-F]+)$/);
  if (!based) return null;
  const radix = { b: 2, o: 8, d: 10, h: 16 }[based[1].toLowerCase()];
  const result = Number.parseInt(based[2], radix);
  return Number.isSafeInteger(result) ? result : null;
}

function evaluateSimpleBound(expression, parameters) {
  const readValue = (token) => parseIntegerLiteral(token) ?? parameters.get(token.trim()) ?? null;
  const direct = readValue(expression);
  if (direct !== null) return direct;
  const binary = expression.trim().match(/^([A-Za-z_$][\w$]*|[+-]?\d+)\s*([+-])\s*([A-Za-z_$][\w$]*|[+-]?\d+)$/);
  if (!binary) return null;
  const first = readValue(binary[1]);
  const second = readValue(binary[3]);
  if (first === null || second === null) return null;
  return binary[2] === '+' ? first + second : first - second;
}

export function estimateTopModuleIoPins(topModule, files) {
  const escapedTop = topModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moduleDeclaration = new RegExp(`\\bmodule\\s+(?:automatic\\s+|static\\s+)?${escapedTop}\\b`);
  let pinCount = 0;
  const parameters = new Map();

  for (const file of files) {
    const source = file.content
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\r\n]*/g, ' ');
    const declaration = moduleDeclaration.exec(source);
    if (!declaration) continue;
    let cursor = declaration.index + declaration[0].length;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '#') {
      cursor += 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (source[cursor] !== '(') continue;
      const parameterEnd = matchingParenthesis(source, cursor);
      if (parameterEnd < 0) continue;
      const parameterList = source.slice(cursor + 1, parameterEnd);
      for (const declaration of splitPortDeclarations(parameterList)) {
        const parameter = declaration.match(/\b(?:parameter|localparam)\b[\s\S]*?\b([A-Za-z_$][\w$]*)\s*=\s*([^,\s]+)/i);
        if (!parameter) continue;
        const value = parseIntegerLiteral(parameter[2]);
        if (value !== null) parameters.set(parameter[1], value);
      }
      cursor = parameterEnd + 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
    }
    if (source[cursor] !== '(') continue;
    const portsEnd = matchingParenthesis(source, cursor);
    if (portsEnd < 0) continue;

    let direction = null;
    let width = 1;
    for (const port of splitPortDeclarations(source.slice(cursor + 1, portsEnd))) {
      const directionMatch = port.match(/^\s*(input|output|inout)\b/i);
      if (directionMatch) {
        direction = directionMatch[1].toLowerCase();
        const packedRange = port.match(/\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]/);
        const symbolicRange = port.match(/\[\s*([^\]:]+)\s*:\s*([^\]]+)\s*\]/);
        if (packedRange) width = Math.abs(Number(packedRange[1]) - Number(packedRange[2])) + 1;
        else if (symbolicRange) {
          const left = evaluateSimpleBound(symbolicRange[1], parameters);
          const right = evaluateSimpleBound(symbolicRange[2], parameters);
          width = left === null || right === null ? 256 : Math.abs(left - right) + 1;
        } else width = 1;
      }
      if (!direction) continue;
      const identifiers = port.match(/[A-Za-z_$][\w$]*/g) || [];
      if (identifiers.length) pinCount += width;
    }
    return pinCount;
  }
  return 0;
}

function hasTopModuleClockInput(topModule, files) {
  const escapedTop = topModule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const moduleDeclaration = new RegExp(`\\bmodule\\s+(?:automatic\\s+|static\\s+)?${escapedTop}\\b`);

  for (const file of files) {
    const source = file.content
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\r\n]*/g, ' ');
    const declaration = moduleDeclaration.exec(source);
    if (!declaration) continue;
    let cursor = declaration.index + declaration[0].length;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '#') {
      cursor += 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
      if (source[cursor] !== '(') continue;
      const parameterEnd = matchingParenthesis(source, cursor);
      if (parameterEnd < 0) continue;
      cursor = parameterEnd + 1;
      while (/\s/.test(source[cursor] || '')) cursor += 1;
    }
    if (source[cursor] !== '(') continue;
    const portsEnd = matchingParenthesis(source, cursor);
    if (portsEnd < 0) continue;
    return splitPortDeclarations(source.slice(cursor + 1, portsEnd)).some((port) => {
      if (!/^\s*input\b/i.test(port)) return false;
      const identifiers = port.match(/[A-Za-z_$][\w$]*/g) || [];
      const portName = identifiers.at(-1) || '';
      return /^(?:[A-Za-z_$][\w$]*_)?(?:a?clk|clock)(?:_i)?$/i.test(portName);
    });
  }
  return false;
}

export function createOpenLaneConfig(topModule, sourcePaths, files, { minimumDieSide = 500 } = {}) {
  const ioPins = estimateTopModuleIoPins(topModule, files);
  const estimatedSide = ioPins === 0 ? 0 : (ioPins / 0.29 * 1.25) / 4;
  const dieSide = Math.max(minimumDieSide, 500, Math.ceil(estimatedSide / 10) * 10);
  const coreMargin = Math.max(20, Math.round(dieSide * 0.05));
  const config = {
    DESIGN_NAME: topModule,
    VERILOG_FILES: sourcePaths,
    VERILOG_INCLUDE_DIRS: ['dir::rtl'],
    PDK: 'sky130A',
    STD_CELL_LIBRARY: 'sky130_fd_sc_hd',
    FP_SIZING: 'absolute',
    DIE_AREA: [0, 0, dieSide, dieSide],
    CORE_AREA: [coreMargin, coreMargin, dieSide - coreMargin, dieSide - coreMargin]
  };
  config.CLOCK_PERIOD = hasTopModuleClockInput(topModule, files) ? 25 : 100;
  return config;
}

function executeWslScript(args, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('OpenLane physical-design run exceeded the 2-hour limit.'));
    }, runTimeoutMs);
    const append = (chunk) => {
      tail = `${tail}${chunk.toString('utf8')}`.slice(-16_000);
      onOutput?.(chunk.toString('utf8'));
    };
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(Object.assign(error, { output: tail }));
      else if (code !== 0) reject(Object.assign(new Error(`OpenLane exited with code ${code}.`), { output: tail }));
      else resolve(tail);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => finish(new Error(`Could not start WSL OpenLane: ${error.message}`)));
    child.once('close', (code) => finish(null, code));
  });
}

async function collectArtifacts(artifactDir) {
  const entries = await fs.promises.readdir(artifactDir, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(artifactDir, entry.name);
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0 || stat.size > maxArtifactBytes) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const type = extension === '.gds' ? 'GDSII'
      : extension === '.v' ? 'SYNTHESIZED_NETLIST'
        : entry.name === 'layout-preview.json' ? 'GDSII_LAYOUT_PREVIEW'
          : extension === '.json' ? 'OPENLANE_METRICS' : null;
    if (!type) continue;
    artifacts.push({
      name: entry.name,
      type,
      mimeType: extension === '.json' ? 'application/json' : extension === '.v' ? 'text/plain' : 'application/octet-stream',
      content: entry.name === 'openlane-metrics.json'
        ? normalizeOpenLaneMetricsJson(await fs.promises.readFile(filePath))
        : await fs.promises.readFile(filePath)
    });
  }
  if (!artifacts.some((artifact) => artifact.type === 'GDSII')) {
    throw new Error('OpenLane finished without producing a final GDSII layout; no physical-design result was recorded.');
  }
  if (!artifacts.some((artifact) => artifact.type === 'SYNTHESIZED_NETLIST')) {
    throw new Error('OpenLane finished without producing a final synthesized netlist; no physical-design result was recorded.');
  }
  return artifacts;
}

export async function runOpenLanePhysicalDesign({ jobId, topModule, files, onOutput }) {
  const dataDir = path.resolve(process.env.AURA_DATA_DIR || path.join(projectRoot, 'data'));
  const workDir = path.join(dataDir, 'physical-design-jobs', jobId);
  const artifactDir = path.join(workDir, 'artifacts');
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  try {
    stageSources(workDir, topModule, files);
    const [workPath, scriptPath, artifactPath] = await Promise.all([
      toWslPath(workDir),
      toWslPath(path.join(projectRoot, 'scripts', 'run-openlane-project-wsl.sh')),
      toWslPath(artifactDir)
    ]);
    const output = await executeWslScript(
      ['--exec', 'bash', scriptPath, workPath, artifactPath],
      onOutput
    );
    return { artifacts: await collectArtifacts(artifactDir), output };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
}
