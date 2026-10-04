const fs = require('node:fs/promises');
const path = require('node:path');

const textExtensions = new Set([
  '.v', '.sv', '.vh', '.svh', '.vhd', '.vhdl', '.sdc', '.xdc', '.tcl', '.lib', '.liberty',
  '.lef', '.def', '.tf', '.tech', '.json', '.yaml', '.yml', '.toml', '.xml', '.ini',
  '.cfg', '.conf', '.mem', '.hex', '.mif', '.coe', '.csv', '.txt', '.md', '.f', '.flist', '.mk'
]);
const ignoredDirectories = new Set(['.git', 'node_modules', 'vendor', 'build', 'dist', 'out', 'obj_dir']);
const secretPath = /(^|\/)(\.env(?:\..*)?|.*(?:credential|secret|private[-_.]?key|id_rsa).*)$/i;
const limits = { files: 250, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024, excluded: 5000 };

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.length <= 20 && parts.every((part) =>
    part && part !== '.' && part !== '..' && !/[<>:"|?*\u0000-\u001f]/.test(part) && !/[. ]$/.test(part)
  );
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function excluded(excludedFiles, filePath, code, message) {
  if (excludedFiles.length >= limits.excluded) throw new Error('Folder contains too many excluded files. Select a narrower project folder.');
  excludedFiles.push({ path: filePath, code, message });
}

async function scanProjectFolder(root) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Choose a real project folder, not a file or symbolic link.');
  const rootPath = await fs.realpath(root);
  const files = [];
  const excludedFiles = [];
  let totalBytes = 0;

  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');
      if (!validateRelativePath(relativePath)) {
        excluded(excludedFiles, relativePath.slice(0, 500), 'UNSAFE_PATH', 'Unsafe path excluded.');
        continue;
      }
      if (entry.isSymbolicLink()) {
        excluded(excludedFiles, relativePath, 'SYMLINK_EXCLUDED', 'Symbolic links are not followed.');
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (secretPath.test(relativePath)) {
        excluded(excludedFiles, relativePath, 'SENSITIVE_FILE_EXCLUDED', 'Potential credentials or private-key files are never imported.');
        continue;
      }
      const baseName = entry.name.toLowerCase();
      const extension = path.extname(baseName);
      if (!textExtensions.has(extension) && !['makefile', 'cmakelists.txt', 'platformio.ini'].includes(baseName)) {
        excluded(excludedFiles, relativePath, 'UNSUPPORTED_FILE', 'Binary or unsupported file type; not imported.');
        continue;
      }
      const stat = await fs.stat(absolutePath);
      if (stat.size > limits.fileBytes) {
        excluded(excludedFiles, relativePath, 'FILE_SIZE_LIMIT', 'File exceeds the 512 KiB per-file import limit.');
        continue;
      }
      if (files.length >= limits.files) throw new Error('Project import is limited to 250 supported text files. Select a narrower folder.');
      totalBytes += stat.size;
      if (totalBytes > limits.totalBytes) throw new Error('Project import is limited to 8 MiB of text files. Select a narrower folder.');
      const content = await fs.readFile(absolutePath, 'utf8');
      if (content.includes('\0')) {
        totalBytes -= stat.size;
        excluded(excludedFiles, relativePath, 'BINARY_CONTENT_EXCLUDED', 'File contains binary data and was not imported.');
        continue;
      }
      files.push({ path: relativePath, content });
    }
  };

  await visit(rootPath);
  if (!files.length) throw new Error('No eligible text project files were found in the selected folder.');
  return { name: path.basename(rootPath), files, excludedFiles };
}

function validateExportFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > limits.files) {
    throw new Error('Export must contain between 1 and 250 project files.');
  }
  let totalBytes = 0;
  for (const file of files) {
    if (!file || !validateRelativePath(file.path) || typeof file.content !== 'string') {
      throw new Error('Export contains an invalid project-relative file.');
    }
    if (secretPath.test(file.path)) throw new Error('Potential credential files cannot be exported by this operation.');
    const size = Buffer.byteLength(file.content, 'utf8');
    if (size > limits.fileBytes) throw new Error(`${file.path} exceeds the 512 KiB file limit.`);
    totalBytes += size;
    if (totalBytes > limits.totalBytes) throw new Error('Export exceeds the 8 MiB total project file limit.');
  }
}

async function writeExportDirectory(parentDirectory, projectName, files) {
  validateExportFiles(files);
  const folderName = `${String(projectName || 'aura-project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'aura-project'}-aura-export-${Date.now()}`;
  const root = path.resolve(parentDirectory, folderName);
  if (!isWithin(path.resolve(parentDirectory), root)) throw new Error('The export destination is not safe.');
  await fs.mkdir(root, { recursive: false });
  try {
    for (const file of files) {
      const outputPath = path.resolve(root, ...file.path.split('/'));
      if (!isWithin(root, outputPath) || outputPath === root) throw new Error('An export path is outside the selected destination.');
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, file.content, { encoding: 'utf8', flag: 'wx' });
    }
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { limits, scanProjectFolder, validateRelativePath, validateExportFiles, writeExportDirectory };
