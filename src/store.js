import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { classifyProjectFileCategory } from './hardware-project.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const getDataDir = () => path.resolve(process.env.AURA_DATA_DIR || path.join(rootDir, 'data'));
const getDbPath = () => path.join(getDataDir(), 'aura-store.json');

const defaultState = {
  users: [],
  organizations: [],
  sessions: [],
  projects: [],
  jobs: [],
  artifacts: [],
  usageRecords: [],
  auditLogs: [],
  securityEvents: [],
  onboarding: {
    users: {}
  },
  settings: { billing: { tier: 'FREE' } },
  system: {
    version: '0.1.0',
    environment: 'development'
  }
};

function ensureStore() {
  const dataDir = getDataDir();
  const dbPath = getDbPath();
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultState, null, 2));
  }
}

export function readStore() {
  ensureStore();
  const dbPath = getDbPath();
  const raw = fs.readFileSync(dbPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`AURA store at ${dbPath} contains invalid JSON; refusing to overwrite it`, { cause: error });
  }
}

export function writeStore(state) {
  ensureStore();
  const dbPath = getDbPath();
  const temporaryPath = `${dbPath}.${process.pid}.${uuidv4()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryPath, dbPath);
}

export function createSession(userId, organizationId) {
  const session = {
    id: uuidv4(),
    userId,
    organizationId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 8).toISOString()
  };
  const state = readStore();
  state.sessions.push(session);
  writeStore(state);
  return session;
}

export function revokeSession(sessionId, userId) {
  const state = readStore();
  const previousLength = state.sessions.length;
  state.sessions = state.sessions.filter((session) => !(session.id === sessionId && session.userId === userId));
  if (state.sessions.length !== previousLength) writeStore(state);
}

export function getUserByEmail(email) {
  const state = readStore();
  return state.users.find((user) => user.email.toLowerCase() === email.toLowerCase());
}

export function getUserById(userId) {
  const state = readStore();
  return state.users.find((user) => user.id === userId);
}

export function getUserByGithubId(githubId) {
  const state = readStore();
  return state.users.find((user) => user.githubId === String(githubId));
}

export function getUserByGoogleId(googleId) {
  const state = readStore();
  return state.users.find((user) => user.googleId === String(googleId));
}

export function linkGithubAccount(userId, githubId) {
  const state = readStore();
  const existing = state.users.find((user) => user.githubId === String(githubId));
  if (existing && existing.id !== userId) return null;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return null;
  user.githubId = String(githubId);
  writeStore(state);
  return user;
}

export function linkGoogleAccount(userId, googleId) {
  const state = readStore();
  const existing = state.users.find((user) => user.googleId === String(googleId));
  if (existing && existing.id !== userId) return null;
  const user = state.users.find((item) => item.id === userId);
  if (!user) return null;
  user.googleId = String(googleId);
  writeStore(state);
  return user;
}

export function createUser({ name, email, passwordHash = null, githubId = null, googleId = null }) {
  const state = readStore();
  const organizationId = `org-${uuidv4().slice(0, 8)}`;
  const user = {
    id: `user-${uuidv4().slice(0, 8)}`,
    name,
    email,
    passwordHash,
    ...(githubId ? { githubId: String(githubId) } : {}),
    ...(googleId ? { googleId: String(googleId) } : {}),
    role: 'owner',
    organizationId,
    createdAt: new Date().toISOString(),
    subscription: 'FREE',
    usage: { jobs: 0, storageMb: 0 }
  };
  const organization = {
    id: organizationId,
    name: `${name.split(' ')[0]}'s Lab`,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-lab`,
    ownerId: user.id,
    members: [user.id],
    subscription: 'FREE',
    plan: 'FREE',
    subscriptionRecord: {
      plan: 'FREE',
      baseCurrency: 'USD',
      displayCurrency: 'USD',
      basePrice: 0,
      billingInterval: 'month',
      subscriptionStatus: 'active',
      subscriptionId: null,
      currentPeriodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      currentPeriodEnd: null,
      paymentStatus: 'not_required'
    },
    billingHistory: [],
    createdAt: user.createdAt,
    settings: { samlEnabled: false }
  };
  state.users.push(user);
  state.organizations.push(organization);
  state.auditLogs.push({
    id: uuidv4(),
    type: 'USER_CREATED',
    userId: user.id,
    organizationId,
    message: 'User created account',
    createdAt: new Date().toISOString()
  });
  writeStore(state);
  return user;
}

export function listProjectsForUser(userId) {
  const state = readStore();
  const user = getUserById(userId);
  if (!user) return [];
  return state.projects
    .filter((project) => project.ownerId === userId || project.organizationId === user.organizationId)
    .map((project) => ({
      ...project,
      sourceFiles: undefined,
      versions: undefined,
      designBriefs: undefined,
      sourceFileCount: project.sourceFiles.length,
      versionCount: project.versions.length
    }));
}

export function createProject({ name, userId, organizationId }) {
  const state = readStore();
  const project = {
    id: `project-${uuidv4().slice(0, 8)}`,
    name,
    organizationId,
    ownerId: userId,
    createdAt: new Date().toISOString(),
    versions: [],
    sourceFiles: [{ id: `file-${uuidv4().slice(0, 8)}`, name: 'top.sv', language: 'systemverilog', content: 'module top;\nendmodule' }],
    compilerConfig: { target: 'cpu', optimize: 'speed' },
    technologyConfig: { units: 'nm', layers: 8 }
  };
  state.projects.push(project);
  state.auditLogs.push({
    id: uuidv4(),
    type: 'PROJECT_CREATED',
    userId,
    organizationId,
    projectId: project.id,
    message: `Created project ${name}`,
    createdAt: new Date().toISOString()
  });
  writeStore(state);
  return project;
}

export function importHardwareProject({ name, userId, organizationId, analysis }) {
  const state = readStore();
  const project = {
    id: `project-${uuidv4().slice(0, 8)}`,
    name,
    organizationId,
    ownerId: userId,
    createdAt: new Date().toISOString(),
    versions: [],
    sourceFiles: analysis.files.map((file) => ({
      id: `file-${uuidv4().slice(0, 8)}`,
      name: file.path,
      language: file.language,
      category: file.category,
      size: file.size,
      content: file.content
    })),
    compilerConfig: { target: 'cpu', optimize: 'speed' },
    technologyConfig: { units: 'nm', layers: null },
    importedProject: {
      summary: analysis.summary,
      modules: analysis.modules,
      dependencies: analysis.dependencies,
      topCandidates: analysis.topCandidates,
      topModule: analysis.detectedTopModule,
      auraConfigDetected: analysis.auraConfigDetected,
      diagnostics: analysis.diagnostics,
      importedAt: new Date().toISOString(),
      sourcePreserved: true
    },
    designBriefs: []
  };
  state.projects.push(project);
  state.auditLogs.push({
    id: uuidv4(),
    type: 'HARDWARE_PROJECT_IMPORTED',
    userId,
    organizationId,
    projectId: project.id,
    message: `Imported ${analysis.summary.importedFileCount} copied project files as a new AURA workspace`,
    createdAt: project.createdAt
  });
  writeStore(state);
  return project;
}

export function replaceImportedHardwareProject({ projectId, userId, organizationId, analysis }) {
  const state = readStore();
  const project = state.projects.find((item) =>
    item.id === projectId && item.organizationId === organizationId && item.importedProject
  );
  if (!project) return null;
  project.sourceFiles = analysis.files.map((file) => ({
    id: `file-${uuidv4().slice(0, 8)}`,
    name: file.path,
    language: file.language,
    category: file.category,
    size: file.size,
    content: file.content
  }));
  project.importedProject = {
    summary: analysis.summary,
    modules: analysis.modules,
    dependencies: analysis.dependencies,
    topCandidates: analysis.topCandidates,
    topModule: analysis.detectedTopModule,
    auraConfigDetected: analysis.auraConfigDetected,
    diagnostics: analysis.diagnostics,
    importedAt: new Date().toISOString(),
    sourcePreserved: true
  };
  state.auditLogs.push({
    id: uuidv4(),
    type: 'HARDWARE_PROJECT_RESCANNED',
    userId,
    organizationId,
    projectId,
    message: `Refreshed the AURA workspace copy with ${analysis.summary.importedFileCount} scanned files; immutable versions were retained`,
    createdAt: new Date().toISOString()
  });
  writeStore(state);
  return project;
}

export function setProjectTopModule(projectId, organizationId, topModule) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  if (!project?.importedProject) return null;
  const availableModules = project.importedProject.modules
    .filter((module) => !module.testbench)
    .map((module) => module.name);
  if (topModule && !availableModules.includes(topModule)) return false;
  project.importedProject.topModule = topModule || null;
  writeStore(state);
  return project;
}

export function saveProjectDesignBrief(projectId, organizationId, userId, request) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  if (!project) return null;
  project.designBriefs ??= [];
  const brief = {
    id: `brief-${uuidv4()}`,
    request,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    executionStatus: 'NOT_EXECUTED',
    reason: 'Saved to this project only. It has not been sent to an AI provider or executed.'
  };
  project.designBriefs.push(brief);
  writeStore(state);
  return brief;
}

export function getProjectDesignBriefs(projectId, organizationId) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  return project ? [...(project.designBriefs || [])] : null;
}

export function recordAiRequest(organizationId, userId, projectId) {
  const state = readStore();
  state.usageRecords ??= [];
  const record = {
    id: uuidv4(),
    type: 'ai_request',
    organizationId,
    userId,
    projectId,
    createdAt: new Date().toISOString()
  };
  state.usageRecords.push(record);
  writeStore(state);
  return record;
}

export function recordSimulationRequest(organizationId, userId, projectId) {
  const state = readStore();
  state.usageRecords ??= [];
  const record = {
    id: uuidv4(),
    type: 'simulation_job',
    organizationId,
    userId,
    projectId,
    createdAt: new Date().toISOString()
  };
  state.usageRecords.push(record);
  writeStore(state);
  return record;
}

export function createJob({ userId, organizationId, projectId, title, versionId, sourceHash, jobType = 'compiler', topModule = null }) {
  const state = readStore();
  const job = {
    id: `job-${uuidv4().slice(0, 8)}`,
    userId,
    organizationId,
    projectId,
    title,
    jobType,
    ...(topModule ? { topModule } : {}),
    versionId,
    sourceHash,
    status: 'queued',
    stage: 'Queued',
    progress: 0,
    logs: ['Queueing job'],
    events: [{ type: 'job.created', timestamp: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.jobs.push(job);
  state.auditLogs.push({
    id: uuidv4(),
    type: jobType === 'physical_design' ? 'PHYSICAL_DESIGN' : 'COMPILE',
    userId,
    organizationId,
    projectId,
    message: jobType === 'physical_design'
      ? `Started OpenLane physical-design job ${job.id}`
      : `Started compile job ${job.id}`,
    createdAt: new Date().toISOString()
  });
  writeStore(state);
  return job;
}

export function listJobsForOrganization(organizationId) {
  const state = readStore();
  return state.jobs.filter((job) => job.organizationId === organizationId);
}

export function getProjectForOrganization(projectId, organizationId) {
  const state = readStore();
  return state.projects.find((project) => project.id === projectId && project.organizationId === organizationId);
}

export function updateProjectFile(projectId, organizationId, fileName, content) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  if (!project) return null;
  const extension = path.extname(fileName).toLowerCase();
  const category = classifyProjectFileCategory(fileName);
  const file = project.sourceFiles.find((item) => item.name === fileName);
  if (file) {
    file.content = content;
    file.size = Buffer.byteLength(content, 'utf8');
    file.category = category;
  } else {
    project.sourceFiles.push({
      id: `file-${uuidv4().slice(0, 8)}`,
      name: fileName,
      language: ['.sv', '.svh'].includes(extension) ? 'systemverilog' :
        ['.v', '.vh'].includes(extension) ? 'verilog' : 'text',
      category,
      size: Buffer.byteLength(content, 'utf8'),
      content
    });
  }
  writeStore(state);
  return project.sourceFiles.find((item) => item.name === fileName);
}

export function createProjectVersion({ projectId, organizationId, userId }) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  if (!project) return null;
  const snapshot = {
    sourceFiles: [...project.sourceFiles]
      .map(({ name, language, category, content }) => ({ name, language, category, content }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    compilerConfig: project.compilerConfig,
    technologyConfig: project.technologyConfig,
    topModule: project.importedProject?.topModule || null,
    importSummary: project.importedProject?.summary || null
  };
  const contentHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const version = {
    id: `version-${uuidv4()}`,
    projectId,
    organizationId,
    createdBy: userId,
    createdAt: new Date().toISOString(),
    contentHash,
    compilerVersion: '0.1.0',
    seed: 0,
    ...snapshot
  };
  project.versions.push(version);
  state.auditLogs.push({
    id: uuidv4(),
    type: 'PROJECT_VERSION_CREATED',
    userId,
    organizationId,
    projectId,
    versionId: version.id,
    message: `Created immutable project version ${version.id}`,
    createdAt: version.createdAt
  });
  writeStore(state);
  return version;
}

export function getProjectVersion(projectId, versionId, organizationId) {
  const state = readStore();
  const project = state.projects.find((item) => item.id === projectId && item.organizationId === organizationId);
  return project?.versions.find((version) => version.id === versionId) || null;
}

export function updateJob(jobId, organizationId, patch, eventType) {
  const state = readStore();
  const job = state.jobs.find((item) => item.id === jobId && item.organizationId === organizationId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (patch.log) {
    job.logs.push(patch.log);
    delete job.log;
  }
  if (eventType) {
    job.events ??= [];
    job.events.push({ type: eventType, timestamp: job.updatedAt, stage: job.stage, progress: job.progress });
  }
  writeStore(state);
  return job;
}

export function saveArtifact({ organizationId, projectId, jobId, versionId, content, fileName, type, mimeType = 'application/json' }) {
  const dataDir = getDataDir();
  const artifactsDir = path.join(dataDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const hash = createHash('sha256').update(content).digest('hex');
  const storageKey = path.join('artifacts', hash);
  const storagePath = path.join(dataDir, storageKey);
  if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, content, { flag: 'wx' });
  const artifact = {
    id: `artifact-${uuidv4()}`,
    organizationId,
    projectId,
    jobId,
    versionId,
    name: fileName,
    type,
    hash,
    size: Buffer.byteLength(content),
    mimeType,
    storageKey,
    createdAt: new Date().toISOString()
  };
  const state = readStore();
  state.artifacts.push(artifact);
  writeStore(state);
  return artifact;
}

export function getArtifactForOrganization(artifactId, organizationId) {
  const state = readStore();
  return state.artifacts.find((item) => item.id === artifactId && item.organizationId === organizationId);
}

export function readArtifact(artifact) {
  const dataDir = getDataDir();
  const storagePath = path.resolve(dataDir, artifact.storageKey);
  if (!storagePath.startsWith(`${dataDir}${path.sep}`)) throw new Error('Invalid artifact storage key');
  return fs.readFileSync(storagePath);
}

export function listArtifactsForOrganization(organizationId) {
  const state = readStore();
  return state.artifacts.filter((artifact) => artifact.organizationId === organizationId);
}

export function getUsageSnapshot(organizationId) {
  const state = readStore();
  const organization = state.organizations.find((org) => org.id === organizationId);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const projects = state.projects.filter((project) => project.organizationId === organizationId);
  const projectFileBytes = projects.reduce((sum, project) => sum +
    (project.sourceFiles || []).reduce((total, file) => total + (file.size ?? Buffer.byteLength(file.content || '', 'utf8')), 0) +
    (project.versions || []).reduce((versionTotal, version) => versionTotal +
      (version.sourceFiles || []).reduce((fileTotal, file) => fileTotal + Buffer.byteLength(file.content || '', 'utf8'), 0), 0), 0);
  const artifactBytes = state.artifacts
    .filter((artifact) => artifact.organizationId === organizationId)
    .reduce((sum, artifact) => sum + (artifact.size || 0), 0);
  return {
    organization,
    usage: {
      compilerJobs: state.jobs.filter((job) => job.organizationId === organizationId && (job.jobType || 'compiler') === 'compiler').length,
      compilerJobsThisMonth: state.jobs.filter((job) =>
        job.organizationId === organizationId && (job.jobType || 'compiler') === 'compiler' && new Date(job.createdAt) >= monthStart
      ).length,
      storageBytes: projectFileBytes + artifactBytes,
      storageMb: (projectFileBytes + artifactBytes) / 1024 / 1024,
      projects: projects.length,
      aiRequestsThisMonth: (state.usageRecords || []).filter((record) =>
        record.organizationId === organizationId && record.type === 'ai_request' && new Date(record.createdAt) >= monthStart
      ).length,
      simulationJobsThisMonth: (state.usageRecords || []).filter((record) =>
        record.organizationId === organizationId && record.type === 'simulation_job' && new Date(record.createdAt) >= monthStart
      ).length
    },
    plan: organization?.plan || 'FREE'
  };
}

export function upsertOnboarding(userId, onboardingState) {
  const state = readStore();
  state.onboarding.users[userId] = onboardingState;
  writeStore(state);
  return state.onboarding.users[userId];
}

export function getOnboarding(userId) {
  const state = readStore();
  return state.onboarding.users[userId] || { step: 1, selections: [], nextAction: 'Create Project' };
}

export function logSecurityEvent(event) {
  const state = readStore();
  state.securityEvents.push({
    id: uuidv4(),
    ...event,
    createdAt: new Date().toISOString()
  });
  writeStore(state);
}

export function appendAudit(log) {
  const state = readStore();
  state.auditLogs.push({ id: uuidv4(), ...log, createdAt: new Date().toISOString() });
  writeStore(state);
}

export function getAuditLog(organizationId) {
  const state = readStore();
  return state.auditLogs.filter((log) => log.organizationId === organizationId || !log.organizationId).slice(-20);
}
