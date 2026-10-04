const textExtensions = new Set([
  '.v', '.sv', '.vh', '.svh', '.vhd', '.vhdl',
  '.sdc', '.xdc', '.tcl', '.lib', '.liberty', '.lef', '.def', '.tf', '.tech',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  '.mem', '.hex', '.mif', '.coe', '.csv', '.txt', '.md', '.f', '.flist', '.mk'
]);
const rtlExtensions = new Set(['.v', '.sv', '.vh', '.svh']);
const ignoredDirectories = new Set(['.git', 'node_modules', 'vendor', 'build', 'dist', 'out', 'obj_dir']);
const excludedFilePattern = /(^|\/)(\.env(?:\..*)?|.*(?:credential|secret|private[-_.]?key|id_rsa).*)$/i;
const maxFiles = 250;
const maxFileBytes = 512 * 1024;
const maxTotalBytes = 8 * 1024 * 1024;

function extensionOf(name) {
  const last = name.split('/').at(-1) || '';
  const index = last.lastIndexOf('.');
  return index < 0 ? '' : last.slice(index).toLowerCase();
}

export function validateProjectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.length <= 20 && parts.every((part) =>
    part.length > 0 &&
    part !== '.' &&
    part !== '..' &&
    !/[<>:"|?*\u0000-\u001f]/.test(part) &&
    !/[. ]$/.test(part)
  );
}

export function isIgnoredProjectPath(name) {
  return name.split('/').some((part) => ignoredDirectories.has(part.toLowerCase()));
}

export function classifyProjectFileCategory(name) {
  const extension = extensionOf(name);
  const base = name.split('/').at(-1).toLowerCase();
  const pathLower = name.toLowerCase();
  if (rtlExtensions.has(extension)) {
    return /(^|\/)(tb|testbench|tests?)(\/|$)|(?:^|[_\-.])(tb|testbench)(?:[_\-.]|$)/i.test(name)
      ? 'testbenches'
      : 'rtl';
  }
  if (['.vhd', '.vhdl'].includes(extension)) return 'unsupported-hdl';
  if (['.sdc', '.xdc'].includes(extension) || (extension === '.tcl' && /constraint|timing|sdc|xdc/i.test(name))) return 'constraints';
  if (['.lib', '.liberty', '.lef', '.def', '.tf', '.tech'].includes(extension)) return 'technology';
  if (['.mem', '.hex', '.mif', '.coe'].includes(extension)) return 'ip';
  if (/(^|\/)(ip|ips|cores|third_party)(\/|$)/i.test(name)) return 'ip';
  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.f', '.flist', '.mk'].includes(extension) ||
      ['makefile', 'cmakelists.txt', 'platformio.ini'].includes(base)) return 'configuration';
  if (['.v', '.sv', '.vh', '.svh'].includes(extension)) return 'rtl';
  if (pathLower.includes('/')) return 'other';
  return 'other';
}

function removeComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\r\n]*/g, '');
}

function inspectModules(files) {
  const modules = new Map();
  const instances = [];
  const diagnostics = [];
  for (const file of files.filter((item) => item.category === 'rtl' || item.category === 'testbenches')) {
    const source = removeComments(file.content);
    for (const match of source.matchAll(/\bmodule\s+(?:automatic\s+|static\s+)?([A-Za-z_$][\w$]*)\b/g)) {
      const name = match[1];
      if (modules.has(name)) diagnostics.push({ code: 'DUPLICATE_MODULE', file: file.path, module: name });
      else modules.set(name, {
        name,
        file: file.path,
        testbench: file.category === 'testbenches',
        instantiatedBy: []
      });
    }
    const withoutModuleHeaders = source
      .replace(/\bmodule\b[\s\S]*?;/g, ' ')
      .replace(/\$(?:signed|unsigned)\s*\([^)]*\)/g, ' ')
      .replace(/\b(?:begin|end|case|endcase|if|else|for|while|repeat|forever)\b/g, ' ');
    for (const match of withoutModuleHeaders.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      const type = match[1];
      if (['input', 'output', 'inout', 'wire', 'reg', 'logic', 'assign', 'always', 'if', 'for', 'case'].includes(type)) continue;
      instances.push({ type, file: file.path, testbench: file.category === 'testbenches' });
    }
  }
  const instantiatedTypes = new Set();
  for (const instance of instances.filter((item) => !item.testbench)) {
    const module = modules.get(instance.type);
    if (module) {
      module.instantiatedBy.push(instance.file);
      instantiatedTypes.add(instance.type);
    }
  }
  const declared = [...modules.values()];
  const topCandidates = declared.filter((module) => !module.testbench && !instantiatedTypes.has(module.name));
  const dependencies = instances.filter((instance) => !instance.testbench)
    .filter((instance) => !modules.has(instance.type))
    .map(({ type, file }) => ({ module: type, referencedFrom: file }));
  for (const item of dependencies) {
    diagnostics.push({ code: 'UNRESOLVED_MODULE', file: item.referencedFrom, module: item.module });
  }
  return {
    modules: declared,
    dependencies,
    topCandidates: topCandidates.map((item) => item.name),
    detectedTopModule: topCandidates.length === 1 ? topCandidates[0].name : null,
    diagnostics
  };
}

export function analyzeHardwareProject({ files, excludedFiles = [] }) {
  const diagnostics = [];
  if (!Array.isArray(files) || files.length === 0) throw new Error('Select a folder containing text project files before importing.');
  if (files.length > maxFiles) throw new Error(`Project imports are limited to ${maxFiles} text files; the selection has ${files.length}.`);

  let totalBytes = 0;
  const normalizedFiles = [];
  const seenPaths = new Set();
  for (const input of files) {
    if (!validateProjectPath(input.path)) {
      throw new Error(`Unsafe or unsupported project-relative path: ${String(input.path).slice(0, 100)}`);
    }
    if (isIgnoredProjectPath(input.path)) {
      diagnostics.push({ code: 'IGNORED_DIRECTORY', path: input.path, message: 'Files from dependency/build directories are not imported.' });
      continue;
    }
    if (excludedFilePattern.test(input.path)) {
      diagnostics.push({ code: 'SENSITIVE_FILE_EXCLUDED', path: input.path, message: 'Potential credentials or private-key file was not imported.' });
      continue;
    }
    if (seenPaths.has(input.path.toLowerCase())) throw new Error(`Duplicate project-relative path: ${input.path}`);
    seenPaths.add(input.path.toLowerCase());
    const extension = extensionOf(input.path);
    const category = classifyProjectFileCategory(input.path);
    if (!textExtensions.has(extension) && !['makefile', 'cmakelists.txt', 'platformio.ini'].includes(input.path.split('/').at(-1).toLowerCase())) {
      diagnostics.push({ code: 'UNSUPPORTED_FILE', path: input.path, message: 'Binary or unsupported file type; not imported.' });
      continue;
    }
    if (typeof input.content !== 'string') throw new Error(`Text content is required for ${input.path}`);
    if (input.content.includes('\0')) {
      diagnostics.push({ code: 'BINARY_CONTENT_EXCLUDED', path: input.path, message: 'File contains binary NUL bytes and was not imported.' });
      continue;
    }
    const size = Buffer.byteLength(input.content, 'utf8');
    if (size > maxFileBytes) {
      diagnostics.push({ code: 'FILE_SIZE_LIMIT', path: input.path, message: `File exceeds ${maxFileBytes} bytes and was not imported.` });
      continue;
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw new Error(`Project import exceeds the ${maxTotalBytes} byte total text-file limit.`);
    normalizedFiles.push({
      path: input.path,
      name: input.path,
      content: input.content,
      size,
      category,
      language: extension === '.v' || extension === '.vh' ? 'verilog' :
        extension === '.sv' || extension === '.svh' ? 'systemverilog' :
          ['.vhd', '.vhdl'].includes(extension) ? 'vhdl' : 'text'
    });
  }

  for (const item of excludedFiles) {
    if (validateProjectPath(item.path)) {
      diagnostics.push({ code: item.code || 'UNSUPPORTED_FILE', path: item.path, message: item.message || 'File not imported.' });
    }
  }

  const analysis = inspectModules(normalizedFiles);
  const auraConfigDetected = normalizedFiles.some((file) =>
    file.path.toLowerCase().startsWith('.aura/') ||
    /(^|\/)aura(?:\.project)?\.(json|ya?ml|toml)$/i.test(file.path)
  );
  const categorizedFiles = {
    rtl: normalizedFiles.filter((file) => file.category === 'rtl'),
    testbenches: normalizedFiles.filter((file) => file.category === 'testbenches'),
    constraints: normalizedFiles.filter((file) => file.category === 'constraints'),
    technology: normalizedFiles.filter((file) => file.category === 'technology'),
    ip: normalizedFiles.filter((file) => file.category === 'ip'),
    configuration: normalizedFiles.filter((file) => file.category === 'configuration'),
    other: normalizedFiles.filter((file) => file.category === 'other'),
    unsupportedHdl: normalizedFiles.filter((file) => file.category === 'unsupported-hdl')
  };
  if (categorizedFiles.rtl.length === 0) diagnostics.push({
    code: 'RTL_SOURCES_MISSING',
    message: 'No Verilog or SystemVerilog source files were detected.'
  });
  if (categorizedFiles.unsupportedHdl.length) diagnostics.push({
    code: 'VHDL_UNSUPPORTED',
    message: 'VHDL files were detected and imported as project context, but VHDL compilation is not implemented.'
  });
  return {
    files: normalizedFiles,
    categorizedFiles,
    modules: analysis.modules,
    dependencies: analysis.dependencies,
    topCandidates: analysis.topCandidates,
    detectedTopModule: analysis.detectedTopModule,
    diagnostics: [...diagnostics, ...analysis.diagnostics],
    auraConfigDetected,
    summary: {
      importedFileCount: normalizedFiles.length,
      totalBytes,
      rtlCount: categorizedFiles.rtl.length,
      testbenchCount: categorizedFiles.testbenches.length,
      constraintCount: categorizedFiles.constraints.length,
      technologyCount: categorizedFiles.technology.length,
      ipCount: categorizedFiles.ip.length,
      configurationCount: categorizedFiles.configuration.length,
      otherCount: categorizedFiles.other.length,
      unsupportedHdlCount: categorizedFiles.unsupportedHdl.length
    }
  };
}

export const hardwareProjectLimits = { maxFiles, maxFileBytes, maxTotalBytes };
