import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  getAiProviderStatus,
  requestHardwareAnalysis,
  requestHardwareProjectGeneration,
  requestHardwareProjectRepair,
  requestHardwareRepair,
  requestTestbenchGeneration
} from './ai-agent.js';
import { getSimulationStatus, getTestbenchModules, runIcarusSimulation } from './simulation.js';
import { getPhysicalDesignStatus, normalizeOpenLaneMetricsJson, runOpenLanePhysicalDesign } from './physical-design.js';
import { currentPlanForOrganization, findPlan, getPricingConfig, serializePricing, updatePricingConfig } from './billing.js';
import { getUsdToPkrRate } from './exchange-rate.js';
import { compileRtl } from './compiler.js';
import {
  analyzeHardwareProject,
  classifyProjectFileCategory,
  hardwareProjectLimits,
  validateProjectPath
} from './hardware-project.js';
import {
  appendAudit,
  createJob,
  createProject,
  createProjectVersion,
  createSession,
  createUser,
  getArtifactForOrganization,
  getAuditLog,
  getOnboarding,
  getProjectDesignBriefs,
  getProjectForOrganization,
  getProjectVersion,
  getUsageSnapshot,
  getUserByEmail,
  getUserByGithubId,
  getUserByGoogleId,
  getUserById,
  recordAiRequest,
  recordSimulationRequest,
  importHardwareProject,
  linkGithubAccount,
  listArtifactsForOrganization,
  listJobsForOrganization,
  listProjectsForUser,
  logSecurityEvent,
  linkGoogleAccount,
  readArtifact,
  readStore,
  replaceImportedHardwareProject,
  revokeSession,
  saveArtifact,
  saveProjectDesignBrief,
  setProjectTopModule,
  updateJob,
  updateProjectFile,
  upsertOnboarding
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const canonicalOriginValue = process.env.AURA_CANONICAL_ORIGIN?.trim();
const canonicalOrigin = canonicalOriginValue ? new URL(canonicalOriginValue).origin : null;
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'aura-development-only-secret-change-me';
const GITHUB_OAUTH_COOKIE = 'aura_github_oauth';
const GOOGLE_OAUTH_COOKIE = 'aura_google_oauth';

const SignupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  confirmPassword: z.string().min(8)
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword']
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const ProjectSchema = z.object({
  name: z.string().min(2)
});

const CompileSchema = z.object({
  title: z.string().min(2).max(120),
  projectId: z.string().min(1),
  versionId: z.string().min(1)
});

const FileSchema = z.object({
  name: z.string().min(1).max(500).refine(validateProjectPath, 'File name must be a safe project-relative path'),
  content: z.string().max(2_000_000)
});
const HardwareImportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    content: z.string().max(hardwareProjectLimits.maxFileBytes)
  })).min(1).max(hardwareProjectLimits.maxFiles),
  excludedFiles: z.array(z.object({
    path: z.string().min(1).max(500),
    code: z.string().max(80).optional(),
    message: z.string().max(300).optional()
  })).max(5000).optional()
});
const TopModuleSchema = z.object({ topModule: z.string().min(1).max(200).nullable() });
const CheckoutPreviewSchema = z.object({
  planId: z.enum(['FREE', 'PRO', 'ULTRA_ENTERPRISE']),
  displayCurrency: z.enum(['USD', 'PKR'])
});
const PhysicalDesignSchema = z.object({
  topModule: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(200),
  consentToExecute: z.literal(true)
});
let physicalDesignJobActive = false;

function apiError(res, code, message, details = {}, status = 400) {
  const requestId = res.locals.requestId || `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return res.status(status).json({
    error: {
      code,
      message,
      requestId,
      details
    }
  });
}

function configuredDesktopReleaseUrl(environmentKey, assetName) {
  const configuredUrl = process.env[environmentKey]?.trim();
  if (configuredUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(configuredUrl);
    } catch {
      throw new Error(`${environmentKey} must be a valid HTTPS download URL`);
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw new Error(`${environmentKey} must be a public HTTPS URL without embedded credentials`);
    }
    return parsedUrl.toString();
  }

  const repository = process.env.AURA_DESKTOP_GITHUB_REPOSITORY?.trim();
  if (!repository) return null;
  const [owner, name] = repository.split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new Error('AURA_DESKTOP_GITHUB_REPOSITORY must use the owner/repository format');
  }
  return `https://github.com/${repository}/releases/latest/download/${encodeURIComponent(assetName)}`;
}

function getLocalDesktopInstaller(environmentKey, extension, defaultPath = null) {
  const configuredPath = process.env[environmentKey]?.trim();
  if (!configuredPath && (!defaultPath || !fs.existsSync(defaultPath))) return null;

  const resolvedPath = path.resolve(configuredPath || defaultPath);
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!configuredPath) return null;
      throw new Error(`${environmentKey} does not point to an existing installer file`);
    }
    throw error;
  }
  if (!stat.isFile() || path.extname(resolvedPath).toLowerCase() !== extension) {
    throw new Error(`${environmentKey} must point to a valid ${extension} installer file`);
  }
  return { path: resolvedPath, bytes: stat.size };
}

function generateToken(user, sessionId) {
  return jwt.sign({ sub: user.id, email: user.email, org: user.organizationId, role: user.role }, JWT_SECRET, {
    expiresIn: '8h',
    jwtid: sessionId
  });
}

function isPricingAdministrator(user) {
  const administratorEmail = process.env.AURA_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(administratorEmail && user.email.toLowerCase() === administratorEmail);
}

function enforceUsageLimit(res, organizationId, metric, used, requested = 1) {
  let config;
  try {
    config = getPricingConfig();
  } catch (error) {
    console.error(`Pricing configuration could not be loaded: ${error.message}`);
    apiError(res, 'PRICING_CONFIGURATION_UNAVAILABLE', 'Pricing configuration could not be loaded. Check the server billing-config file and permissions.', {}, 503);
    return true;
  }
  const snapshot = getUsageSnapshot(organizationId);
  const plan = currentPlanForOrganization(snapshot.organization, config);
  const limit = plan.limits[metric];
  if (limit === undefined || used + requested <= limit) return false;
  apiError(res, 'USAGE_LIMIT_REACHED', `The ${plan.name} plan limit for ${metric} has been reached`, {
    metric,
    used,
    requested,
    limit,
    planId: plan.id,
    upgradeUrl: '/pricing'
  }, 429);
  return true;
}

function enforcePlanFeature(res, organizationId, feature) {
  const snapshot = getUsageSnapshot(organizationId);
  const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
  if (plan.features[feature]) return false;
  apiError(res, 'FEATURE_NOT_AVAILABLE', `The ${feature} capability is not enabled for this plan`, {
    feature,
    planId: plan.id,
    upgradeUrl: '/pricing'
  }, 403);
  return true;
}

function publicUser(user) {
  const { passwordHash, githubId, googleId, ...safeUser } = user;
  return safeUser;
}

function githubOAuthConfiguration() {
  const clientId = process.env.AURA_GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.AURA_GITHUB_CLIENT_SECRET?.trim();
  const publicUrl = process.env.AURA_PUBLIC_URL?.trim()?.replace(/\/+$/, '');
  if (!clientId || !clientSecret || !publicUrl) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') return null;
  return {
    clientId,
    clientSecret,
    publicUrl,
    callbackUrl: `${publicUrl}/api/v1/auth/github/callback`,
    secureCookie: parsedUrl.protocol === 'https:'
  };
}

function githubOAuthUnavailableReason() {
  if (!process.env.AURA_GITHUB_CLIENT_ID?.trim()) return 'Set AURA_GITHUB_CLIENT_ID in the local .env file.';
  if (!process.env.AURA_GITHUB_CLIENT_SECRET?.trim()) return 'Set AURA_GITHUB_CLIENT_SECRET in the local .env file.';
  const publicUrl = process.env.AURA_PUBLIC_URL?.trim();
  if (!publicUrl) return 'Set AURA_PUBLIC_URL in the local .env file.';
  let parsedUrl;
  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    return 'AURA_PUBLIC_URL must be a valid HTTP/HTTPS URL.';
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
    return 'AURA_PUBLIC_URL must use HTTPS, except for localhost development.';
  }
  return null;
}

function googleOAuthConfiguration() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const publicUrl = process.env.AURA_PUBLIC_URL?.trim()?.replace(/\/+$/, '');
  if (!clientId || !clientSecret || !publicUrl) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') return null;
  return {
    clientId,
    clientSecret,
    publicUrl,
    callbackUrl: `${publicUrl}/api/v1/auth/google/callback`,
    secureCookie: parsedUrl.protocol === 'https:'
  };
}

function googleOAuthUnavailableReason() {
  if (!process.env.GOOGLE_CLIENT_ID?.trim()) return 'Set GOOGLE_CLIENT_ID in the server .env file.';
  if (!process.env.GOOGLE_CLIENT_SECRET?.trim()) return 'Set GOOGLE_CLIENT_SECRET in the server .env file.';
  const publicUrl = process.env.AURA_PUBLIC_URL?.trim();
  if (!publicUrl) return 'Set AURA_PUBLIC_URL in the server .env file.';
  let parsedUrl;
  try {
    parsedUrl = new URL(publicUrl);
  } catch {
    return 'AURA_PUBLIC_URL must be a valid HTTP/HTTPS URL.';
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost') {
    return 'AURA_PUBLIC_URL must use HTTPS, except for localhost development.';
  }
  return null;
}

function parseCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

function setGithubOAuthCookie(res, value, secure) {
  res.setHeader('Set-Cookie', `${GITHUB_OAUTH_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/v1/auth/github/callback; Max-Age=600${secure ? '; Secure' : ''}`);
}

function setGoogleOAuthCookie(res, value, secure) {
  res.setHeader('Set-Cookie', `${GOOGLE_OAUTH_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/v1/auth/google/callback; Max-Age=600${secure ? '; Secure' : ''}`);
}

function clearGithubOAuthCookie(res, secure) {
  res.setHeader('Set-Cookie', `${GITHUB_OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/v1/auth/github/callback; Max-Age=0${secure ? '; Secure' : ''}`);
}

function clearGoogleOAuthCookie(res, secure) {
  res.setHeader('Set-Cookie', `${GOOGLE_OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/v1/auth/google/callback; Max-Age=0${secure ? '; Secure' : ''}`);
}

function publicImportAnalysis(analysis) {
  return {
    summary: analysis.summary,
    categories: Object.fromEntries(Object.entries(analysis.categorizedFiles).map(([category, files]) => [
      category,
      files.map(({ path: filePath, size }) => ({ path: filePath, size }))
    ])),
    modules: analysis.modules,
    dependencies: analysis.dependencies,
    topCandidates: analysis.topCandidates,
    detectedTopModule: analysis.detectedTopModule,
    auraConfigDetected: analysis.auraConfigDetected,
    diagnostics: analysis.diagnostics
  };
}

function publicProject(project) {
  return {
    ...project,
    sourceFiles: undefined,
    versions: undefined,
    designBriefs: undefined,
    sourceFileCount: project.sourceFiles.length,
    versionCount: project.versions.length
  };
}

function queueCompile(job, version) {
  const advance = (stage, progress) => {
    updateJob(job.id, job.organizationId, {
      status: 'running',
      stage,
      progress,
      log: `Stage: ${stage}`
    }, 'job.stage_changed');
  };
  setImmediate(() => {
    try {
      advance('Lexing and parsing RTL', 20);
      const result = compileRtl({
        files: version.sourceFiles.filter((file) => file.category === 'rtl' || !file.category),
        projectVersionId: version.id,
        compilerVersion: version.compilerVersion,
        topModule: version.topModule
      });
      updateJob(job.id, job.organizationId, {
        diagnostics: result.diagnostics,
        tokenCount: result.tokenCount
      });
      if (!result.ok) {
        updateJob(job.id, job.organizationId, {
          status: 'failed',
          stage: 'Failed',
          progress: 100,
          log: `Compilation failed with ${result.diagnostics.length} diagnostic(s)`
        }, 'job.failed');
        return;
      }
      advance('AURA IR serialization', 70);
      const artifact = saveArtifact({
        organizationId: job.organizationId,
        projectId: job.projectId,
        jobId: job.id,
        versionId: version.id,
        content: result.artifact,
        fileName: `design-${result.ir.designHash.slice(0, 12)}.aura.json`,
        type: 'AURA_IR_JSON'
      });
      updateJob(job.id, job.organizationId, { artifactIds: [artifact.id] }, 'job.artifact_created');
      updateJob(job.id, job.organizationId, {
        status: 'completed',
        stage: 'Complete',
        progress: 100,
        designHash: result.ir.designHash,
        log: 'Compilation completed; AURA IR artifact stored'
      }, 'job.completed');
    } catch (error) {
      updateJob(job.id, job.organizationId, {
        status: 'failed',
        stage: 'Failed',
        progress: 100,
        failureCode: 'COMPILER_INTERNAL_ERROR',
        log: `Compiler worker failed: ${error.message}`
      }, 'job.failed');
    }
  });
}

function queuePhysicalDesign(job, version, topModule, runner) {
  setImmediate(async () => {
    let output = '';
    try {
      updateJob(job.id, job.organizationId, {
        status: 'running',
        stage: 'Preparing isolated OpenLane workspace',
        progress: 5,
        log: 'Stage: Preparing isolated OpenLane workspace'
      }, 'job.stage_changed');
      updateJob(job.id, job.organizationId, {
        stage: 'Running OpenLane 2 + SKY130',
        progress: 10,
        log: 'Stage: Running OpenLane 2 + SKY130'
      }, 'job.stage_changed');
      const result = await runner({
        jobId: job.id,
        topModule,
        files: version.sourceFiles.filter((file) =>
          file.category === 'rtl' || (!file.category && ['.v', '.sv', '.vh', '.svh'].includes(path.extname(file.name).toLowerCase()))
        ),
        onOutput: (chunk) => { output = `${output}${chunk}`.slice(-16_000); }
      });
      const artifacts = result.artifacts || [];
      const expectedBytes = artifacts.reduce((sum, artifact) => sum + Buffer.byteLength(artifact.content), 0);
      const snapshot = getUsageSnapshot(job.organizationId);
      const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
      if (snapshot.usage.storageBytes + expectedBytes > plan.limits.storageBytes) {
        throw Object.assign(new Error('Physical-design artifacts exceed the organization storage limit; no artifacts were saved.'), {
          code: 'STORAGE_LIMIT_REACHED'
        });
      }
      updateJob(job.id, job.organizationId, {
        stage: 'Saving verified OpenLane artifacts',
        progress: 95,
        log: 'Stage: Saving verified OpenLane artifacts'
      }, 'job.stage_changed');
      const savedArtifacts = artifacts.map((artifact) => saveArtifact({
        organizationId: job.organizationId,
        projectId: job.projectId,
        jobId: job.id,
        versionId: version.id,
        content: artifact.content,
        fileName: artifact.name,
        type: artifact.type,
        mimeType: artifact.mimeType
      }));
      updateJob(job.id, job.organizationId, {
        status: 'completed',
        stage: 'OpenLane physical design complete',
        progress: 100,
        artifactIds: savedArtifacts.map((artifact) => artifact.id),
        physicalDesign: {
          toolchain: 'OpenLane 2 + SKY130',
          topModule,
          sourceHash: version.contentHash,
          artifacts: savedArtifacts.map(({ id, name, type, size, mimeType }) => ({ id, name, type, size, mimeType }))
        },
        log: `OpenLane completed successfully and stored ${savedArtifacts.length} real physical-design artifact(s)${output ? `\n${output.slice(-3000)}` : ''}`
      }, 'job.completed');
      appendAudit({
        type: 'PHYSICAL_DESIGN_COMPLETED',
        userId: job.userId,
        organizationId: job.organizationId,
        projectId: job.projectId,
        message: `OpenLane completed physical design for ${topModule}; GDSII and synthesized netlist artifacts were stored`
      });
    } catch (error) {
      updateJob(job.id, job.organizationId, {
        status: 'failed',
        stage: 'Physical design failed',
        progress: 100,
        failureCode: error.code || 'OPENLANE_FAILED',
        log: `OpenLane physical design failed: ${error.message}${error.output || output ? `\n${(error.output || output).slice(-3000)}` : ''}`
      }, 'job.failed');
      appendAudit({
        type: 'PHYSICAL_DESIGN_FAILED',
        userId: job.userId,
        organizationId: job.organizationId,
        projectId: job.projectId,
        message: `OpenLane physical design failed for ${topModule}: ${error.message}`
      });
    } finally {
      physicalDesignJobActive = false;
    }
  });
}

function isLoopbackRequest(req) {
  const remoteAddress = req.socket.remoteAddress || '';
  return remoteAddress === '::1' || remoteAddress === '127.0.0.1' ||
    remoteAddress.startsWith('::ffff:127.');
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return apiError(res, 'AUTH_REQUIRED', 'Authentication required', {}, 401);
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return apiError(res, 'INVALID_TOKEN', 'Token failed verification', {}, 401);
  }
  const user = getUserById(payload.sub);
  const activeSession = readStore().sessions.find((session) =>
    session.id === payload.jti &&
    session.userId === payload.sub &&
    session.organizationId === payload.org &&
    new Date(session.expiresAt).getTime() > Date.now()
  );
  if (!user || !activeSession || payload.org !== user.organizationId) {
    return apiError(res, 'INVALID_SESSION', 'Session is invalid or expired', {}, 401);
  }
  req.user = user;
  req.organization = user.organizationId;
  req.sessionId = payload.jti;
  next();
}

export function createApp({
  physicalDesignStatus = getPhysicalDesignStatus,
  physicalDesignRunner = runOpenLanePhysicalDesign
} = {}) {
  const app = express();
  const proxyHops = process.env.AURA_TRUST_PROXY_HOPS;
  if (proxyHops !== undefined) {
    const parsedProxyHops = Number(proxyHops);
    if (!Number.isSafeInteger(parsedProxyHops) || parsedProxyHops < 1 || parsedProxyHops > 5) {
      throw new Error('AURA_TRUST_PROXY_HOPS must be an integer from 1 to 5 when running behind trusted proxies');
    }
    app.set('trust proxy', parsedProxyHops);
  }
  const createAuthRateLimit = (limit, windowMs, code, message, skipSuccessfulRequests = false) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (_req, res) => apiError(res, code, message, {}, 429)
  });
  const signupRateLimit = createAuthRateLimit(
    5,
    60 * 60 * 1000,
    'SIGNUP_RATE_LIMITED',
    'Too many sign-up attempts from this network. Please try again later.'
  );
  const loginRateLimit = createAuthRateLimit(
    10,
    15 * 60 * 1000,
    'LOGIN_RATE_LIMITED',
    'Too many unsuccessful sign-in attempts from this network. Please try again later.',
    true
  );

  app.use(cors());
  app.use((req, _res, next) => {
    req.requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    _res.locals.requestId = req.requestId;
    next();
  });
  app.use((req, res, next) => {
    if (!canonicalOrigin || req.path.startsWith('/api/')) return next();
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    if (requestOrigin === canonicalOrigin) return next();
    const redirectTarget = new URL(req.originalUrl, `${canonicalOrigin}/`);
    if (redirectTarget.origin !== canonicalOrigin) return next();
    return res.redirect(308, redirectTarget.toString());
  });
  app.use(express.json({ limit: '12mb' }));
  app.use('/vendor/three', express.static(path.join(rootDir, 'node_modules', 'three'), {
    index: false,
    maxAge: '1d'
  }));
  app.use(express.static(publicDir));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true, service: 'AURA SILICON API', version: '0.1.0', timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/auth/providers', (_req, res) => {
    const githubReason = githubOAuthUnavailableReason();
    const googleReason = googleOAuthUnavailableReason();
    res.json({
      github: Boolean(githubOAuthConfiguration()),
      githubReason,
      google: Boolean(googleOAuthConfiguration()),
      googleReason,
      emailPassword: true
    });
  });

  app.get('/api/v1/auth/github', (_req, res) => {
    const config = githubOAuthConfiguration();
    if (!config) return res.redirect('/login?auth_error=github_unconfigured');
    const nonce = randomBytes(32).toString('hex');
    const stateCookie = jwt.sign({ purpose: 'github-oauth', nonce }, JWT_SECRET, { expiresIn: '10m' });
    setGithubOAuthCookie(res, stateCookie, config.secureCookie);
    const authorizationUrl = new URL('https://github.com/login/oauth/authorize');
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', config.callbackUrl);
    authorizationUrl.searchParams.set('scope', 'read:user user:email');
    authorizationUrl.searchParams.set('state', nonce);
    return res.redirect(authorizationUrl.toString());
  });

  app.get('/api/v1/auth/github/callback', async (req, res) => {
    const config = githubOAuthConfiguration();
    if (!config) return res.redirect('/login?auth_error=github_unconfigured');
    const stateCookie = parseCookie(req, GITHUB_OAUTH_COOKIE);
    clearGithubOAuthCookie(res, config.secureCookie);
    if (req.query.error || typeof req.query.code !== 'string' || typeof req.query.state !== 'string' || !stateCookie) {
      return res.redirect('/login?auth_error=github_cancelled');
    }

    let statePayload;
    try {
      statePayload = jwt.verify(stateCookie, JWT_SECRET);
      const suppliedState = Buffer.from(req.query.state);
      const expectedState = Buffer.from(typeof statePayload.nonce === 'string' ? statePayload.nonce : '');
      if (statePayload.purpose !== 'github-oauth' || suppliedState.length !== expectedState.length || !timingSafeEqual(suppliedState, expectedState)) {
        return res.redirect('/login?auth_error=github_state');
      }
    } catch {
      return res.redirect('/login?auth_error=github_state');
    }

    try {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: req.query.code,
          redirect_uri: config.callbackUrl,
          state: req.query.state
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!tokenResponse.ok) throw new Error(`GitHub token exchange returned ${tokenResponse.status}`);
      const tokenPayload = await tokenResponse.json();
      if (typeof tokenPayload.access_token !== 'string' || tokenPayload.error) {
        throw new Error('GitHub token exchange did not return an access token');
      }

      const githubHeaders = {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AURA-SILICON'
      };
      const [profileResponse, emailsResponse] = await Promise.all([
        fetch('https://api.github.com/user', { headers: githubHeaders, signal: AbortSignal.timeout(10000) }),
        fetch('https://api.github.com/user/emails', { headers: githubHeaders, signal: AbortSignal.timeout(10000) })
      ]);
      if (!profileResponse.ok || !emailsResponse.ok) {
        throw new Error(`GitHub identity lookup failed (${profileResponse.status}/${emailsResponse.status})`);
      }
      const profile = await profileResponse.json();
      const emails = await emailsResponse.json();
      if (!Number.isSafeInteger(profile.id) || !Array.isArray(emails)) {
        throw new Error('GitHub returned an invalid identity response');
      }
      const verifiedEmail = emails.find((item) => item.primary === true && item.verified === true && typeof item.email === 'string')?.email;
      if (!verifiedEmail) {
        logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: null, reason: 'github_verified_email_missing' });
        return res.redirect('/login?auth_error=github_email');
      }

      let user = getUserByGithubId(profile.id);
      if (!user) {
        const matchingEmailUser = getUserByEmail(verifiedEmail);
        if (matchingEmailUser) {
          user = linkGithubAccount(matchingEmailUser.id, profile.id);
          if (!user) {
            logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: verifiedEmail, reason: 'github_account_conflict' });
            return res.redirect('/login?auth_error=github_conflict');
          }
        } else {
          const name = typeof profile.name === 'string' && profile.name.trim()
            ? profile.name.trim().slice(0, 100)
            : (typeof profile.login === 'string' && profile.login.trim() ? profile.login.trim().slice(0, 100) : verifiedEmail.split('@')[0]);
          user = createUser({ name, email: verifiedEmail, githubId: profile.id });
        }
      }

      const session = createSession(user.id, user.organizationId);
      const token = generateToken(user, session.id);
      appendAudit({
        type: 'LOGIN',
        userId: user.id,
        organizationId: user.organizationId,
        message: 'User signed in with GitHub',
        userEmail: user.email
      });
      return res.redirect(`/auth/callback#token=${encodeURIComponent(token)}`);
    } catch (error) {
      console.error(`GitHub OAuth failed: ${error.message}`);
      logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: null, reason: 'github_provider_error' });
      return res.redirect('/login?auth_error=github_failed');
    }
  });

  app.get('/api/v1/auth/google', (_req, res) => {
    const config = googleOAuthConfiguration();
    if (!config) return res.redirect('/login?auth_error=google_unconfigured');
    const nonce = randomBytes(32).toString('hex');
    const stateCookie = jwt.sign({ purpose: 'google-oauth', nonce }, JWT_SECRET, { expiresIn: '10m' });
    setGoogleOAuthCookie(res, stateCookie, config.secureCookie);
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', config.callbackUrl);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', 'openid email profile');
    authorizationUrl.searchParams.set('state', nonce);
    authorizationUrl.searchParams.set('prompt', 'select_account');
    return res.redirect(authorizationUrl.toString());
  });

  app.get('/api/v1/auth/google/callback', async (req, res) => {
    const config = googleOAuthConfiguration();
    if (!config) return res.redirect('/login?auth_error=google_unconfigured');
    const stateCookie = parseCookie(req, GOOGLE_OAUTH_COOKIE);
    clearGoogleOAuthCookie(res, config.secureCookie);
    if (req.query.error || typeof req.query.code !== 'string' || typeof req.query.state !== 'string' || !stateCookie) {
      return res.redirect('/login?auth_error=google_cancelled');
    }

    try {
      const statePayload = jwt.verify(stateCookie, JWT_SECRET);
      const suppliedState = Buffer.from(req.query.state);
      const expectedState = Buffer.from(typeof statePayload.nonce === 'string' ? statePayload.nonce : '');
      if (statePayload.purpose !== 'google-oauth' || suppliedState.length !== expectedState.length || !timingSafeEqual(suppliedState, expectedState)) {
        return res.redirect('/login?auth_error=google_state');
      }
    } catch {
      return res.redirect('/login?auth_error=google_state');
    }

    try {
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: req.query.code,
          redirect_uri: config.callbackUrl,
          grant_type: 'authorization_code'
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!tokenResponse.ok) throw new Error(`Google token exchange returned ${tokenResponse.status}`);
      const tokenPayload = await tokenResponse.json();
      if (typeof tokenPayload.access_token !== 'string' || tokenPayload.error) {
        throw new Error('Google token exchange did not return an access token');
      }

      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: {
          Authorization: `Bearer ${tokenPayload.access_token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!profileResponse.ok) throw new Error(`Google identity lookup failed (${profileResponse.status})`);
      const profile = await profileResponse.json();
      if (typeof profile.sub !== 'string' || !profile.sub || typeof profile.email !== 'string' || profile.email_verified !== true) {
        logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: null, reason: 'google_verified_email_missing' });
        return res.redirect('/login?auth_error=google_email');
      }

      let user = getUserByGoogleId(profile.sub);
      if (!user) {
        const matchingEmailUser = getUserByEmail(profile.email);
        if (matchingEmailUser) {
          user = linkGoogleAccount(matchingEmailUser.id, profile.sub);
          if (!user) {
            logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: profile.email, reason: 'google_account_conflict' });
            return res.redirect('/login?auth_error=google_conflict');
          }
        } else {
          const name = typeof profile.name === 'string' && profile.name.trim()
            ? profile.name.trim().slice(0, 100)
            : profile.email.split('@')[0];
          user = createUser({ name, email: profile.email, googleId: profile.sub });
        }
      }

      const session = createSession(user.id, user.organizationId);
      const token = generateToken(user, session.id);
      appendAudit({
        type: 'LOGIN',
        userId: user.id,
        organizationId: user.organizationId,
        message: 'User signed in with Google',
        userEmail: user.email
      });
      return res.redirect(`/auth/callback#token=${encodeURIComponent(token)}`);
    } catch (error) {
      console.error(`Google OAuth failed: ${error.message}`);
      logSecurityEvent({ type: 'OAUTH_FAILURE', userEmail: null, reason: 'google_provider_error' });
      return res.redirect('/login?auth_error=google_failed');
    }
  });

  app.get('/api/v1/pricing', async (req, res) => {
    const displayCurrency = req.query.currency || 'USD';
    if (!['USD', 'PKR'].includes(displayCurrency)) {
      return apiError(res, 'INVALID_DISPLAY_CURRENCY', 'Choose USD or PKR for price display', {}, 400);
    }
    let config;
    try {
      config = getPricingConfig();
    } catch (error) {
      console.error(`Pricing configuration could not be loaded: ${error.message}`);
      return apiError(res, 'PRICING_CONFIGURATION_UNAVAILABLE', 'Pricing configuration could not be loaded. Check the server billing-config file and permissions.', {}, 503);
    }
    const exchangeRate = displayCurrency === 'PKR'
      ? await getUsdToPkrRate(config.usdToPkrRate)
      : null;
    const pricingConfig = exchangeRate ? { ...config, usdToPkrRate: exchangeRate.rate } : config;
    res.json({
      ...serializePricing(pricingConfig, displayCurrency),
      aiProviderAvailable: getAiProviderStatus().configured,
      simulationAvailable: getSimulationStatus().available,
      exchangeRateSource: exchangeRate?.source || null,
      exchangeRateUpdatedAt: exchangeRate?.updatedAt || null,
      exchangeRateStale: exchangeRate?.stale || false,
      message: displayCurrency === 'PKR'
        ? exchangeRate?.rate === null
          ? `${exchangeRate.reason}. Prices remain available in USD; no charge is made.`
          : `PKR is an indicative display conversion using ${exchangeRate.source}${exchangeRate.updatedAt ? ` rate data updated ${exchangeRate.updatedAt}` : ' configured rate'}.${exchangeRate.stale ? ` ${exchangeRate.reason}` : ''} Subscription base prices remain USD.`
        : 'Subscription base prices are in USD. PKR is display-only conversion; payment collection is not configured.'
    });
  });

  app.get('/api/v1/ai/status', authMiddleware, (_req, res) => {
    const provider = getAiProviderStatus();
    res.json({
      configured: provider.configured,
      provider: provider.provider,
      model: provider.model,
      reason: provider.reason,
      note: 'When you submit an AI request, the prompt and selected project RTL are sent to the configured provider. AI responses do not modify project files.'
    });
  });

  app.get('/api/v1/simulation/status', authMiddleware, (_req, res) => {
    const { available, simulator, reason } = getSimulationStatus();
    res.json({ available, simulator, reason, execution: 'local-only', requiresExplicitConsent: true });
  });

  app.get('/api/v1/physical-design/status', authMiddleware, async (req, res) => {
    const status = await physicalDesignStatus();
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    const enabledForPlan = plan.features.physicalDesign && plan.features.synthesis && plan.features.gdsii;
    const ready = status.available && enabledForPlan;
    res.json({
      ...status,
      enabledForPlan,
      implemented: true,
      ready,
      supports: {
        synthesis: ready,
        netlistInspection: ready && plan.features.netlistInspection,
        floorplanning: ready,
        placementAndRouting: ready,
        congestionAnalysis: false,
        physicalValidation: false,
        gdsii: ready,
        webgpuVisualization: false,
        webglGdsiiVisualization: ready
      },
      execution: 'local-only',
      requiresExplicitConsent: true,
      message: !status.available
        ? status.reason
        : !enabledForPlan
          ? 'OpenLane 2 + SKY130 is available locally, but synthesis, physical design, and GDSII are not enabled for this plan.'
          : 'Ready: jobs run locally through OpenLane 2 and SKY130. Results are shown only after real final GDSII and synthesized-netlist outputs are verified.'
    });
  });

  app.get('/api/v1/admin/pricing', authMiddleware, (req, res) => {
    if (!isPricingAdministrator(req.user)) return apiError(res, 'ADMIN_REQUIRED', 'Platform pricing administration is restricted', {}, 403);
    res.json({ config: getPricingConfig() });
  });

  app.put('/api/v1/admin/pricing', authMiddleware, (req, res) => {
    if (!isPricingAdministrator(req.user)) return apiError(res, 'ADMIN_REQUIRED', 'Platform pricing administration is restricted', {}, 403);
    const result = updatePricingConfig(req.body);
    if (!result.success) return apiError(res, 'INVALID_PRICING_CONFIG', 'Pricing configuration is invalid', result.error, 400);
    appendAudit({
      type: 'PRICING_CONFIGURATION_UPDATED',
      userId: req.user.id,
      organizationId: req.user.organizationId,
      message: 'Platform plan, usage-limit, feature, or display-rate configuration was updated'
    });
    res.json({ config: result.config });
  });

  app.post('/api/v1/billing/checkout-preview', authMiddleware, async (req, res) => {
    const parsed = CheckoutPreviewSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 'VALIDATION_ERROR', 'Invalid checkout selection', parsed.error.flatten(), 400);
    const config = getPricingConfig();
    const exchangeRate = parsed.data.displayCurrency === 'PKR'
      ? await getUsdToPkrRate(config.usdToPkrRate)
      : null;
    if (parsed.data.displayCurrency === 'PKR' && exchangeRate.rate === null) {
      return apiError(res, 'EXCHANGE_RATE_UNAVAILABLE', exchangeRate.reason, {
        fallbackCurrency: 'USD'
      }, 503);
    }
    const pricingConfig = exchangeRate ? { ...config, usdToPkrRate: exchangeRate.rate } : config;
    const pricing = serializePricing(pricingConfig, parsed.data.displayCurrency);
    const plan = findPlan(config, parsed.data.planId);
    const displayedPlan = pricing.plans.find((item) => item.id === parsed.data.planId);
    if (!plan || !displayedPlan) return apiError(res, 'PLAN_NOT_FOUND', 'The selected plan is not configured', {}, 404);
    const organization = readStore().organizations.find((item) => item.id === req.user.organizationId);
    res.json({
      checkout: {
        planId: plan.id,
        planName: plan.name,
        account: req.user.email,
        billingInterval: plan.interval,
        basePrice: plan.price,
        baseCurrency: config.baseCurrency,
        displayPrice: displayedPlan.displayPrice,
        displayCurrency: parsed.data.displayCurrency,
        exchangeRate: pricing.exchangeRate,
        exchangeRateSource: exchangeRate?.source || null,
        exchangeRateUpdatedAt: exchangeRate?.updatedAt || null,
        paymentMethod: 'unavailable',
        tax: null,
        total: displayedPlan.displayPrice,
        status: 'PREVIEW_ONLY',
        subscription: organization?.subscriptionRecord || null,
        paymentAvailable: false
      },
      message: 'Payment processing is not configured. This preview does not create a subscription or charge an account.'
    });
  });

  app.post('/api/v1/billing/checkout', authMiddleware, (_req, res) =>
    apiError(res, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Subscriptions cannot be purchased until a payment provider is configured', {}, 503)
  );

  app.get('/api/v1/desktop/releases/latest', (_req, res) => {
    const version = process.env.AURA_DESKTOP_VERSION || '0.1.0';
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
      return apiError(res, 'DESKTOP_RELEASE_INVALID', 'AURA_DESKTOP_VERSION must be a valid semantic version', {}, 503);
    }
    const installerPath = process.env.AURA_WINDOWS_INSTALLER_PATH;
    let windowsUrl;
    let macosUrl;
    let linuxUrl;
    let macosInstaller;
    let linuxInstaller;
    try {
      windowsUrl = configuredDesktopReleaseUrl(
        'AURA_WINDOWS_DOWNLOAD_URL',
        `AURA-SILICON-Setup-${version}-x64.exe`
      );
      macosUrl = configuredDesktopReleaseUrl(
        'AURA_MACOS_DOWNLOAD_URL',
        `AURA-SILICON-${version}-universal.dmg`
      );
      linuxUrl = configuredDesktopReleaseUrl(
        'AURA_LINUX_DOWNLOAD_URL',
        `AURA-SILICON-${version}-x64.AppImage`
      );
      macosInstaller = macosUrl ? null : getLocalDesktopInstaller(
        'AURA_MACOS_INSTALLER_PATH',
        '.dmg',
        path.join(rootDir, 'desktop', 'release', `AURA-SILICON-${version}-universal.dmg`)
      );
      linuxInstaller = linuxUrl ? null : getLocalDesktopInstaller(
        'AURA_LINUX_INSTALLER_PATH',
        '.appimage',
        path.join(rootDir, 'desktop', 'release', `AURA-SILICON-${version}-x64.AppImage`)
      );
    } catch (error) {
      return apiError(res, 'DESKTOP_RELEASE_INVALID', error.message, {}, 503);
    }

    let windowsRelease = windowsUrl
      ? {
          available: true,
          platform: 'Windows 10/11',
          architecture: 'x64',
          downloadUrl: windowsUrl
        }
      : {
          available: false,
          platform: 'Windows 10/11',
          architecture: 'x64',
          message: 'A signed Windows installer has not been published.'
        };
    if (!windowsUrl && installerPath) {
      try {
        const resolvedPath = path.resolve(installerPath);
        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile() || path.extname(resolvedPath).toLowerCase() !== '.exe') {
          return apiError(res, 'DESKTOP_RELEASE_INVALID', 'The configured Windows release is not a valid installer file', {}, 503);
        }
        windowsRelease = {
          ...windowsRelease,
          available: true,
          locallyConfigured: true,
          bytes: stat.size,
          downloadUrl: '/api/v1/desktop/releases/latest/download',
          message: undefined
        };
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'The Windows release could not be checked', {}, 503);
        }
      }
    }
    const macosRelease = macosUrl
      ? { available: true, platform: 'macOS 12+', architecture: 'universal', downloadUrl: macosUrl }
      : macosInstaller
        ? {
            available: true,
            platform: 'macOS 12+',
            architecture: 'universal',
            locallyConfigured: true,
            bytes: macosInstaller.bytes,
            downloadUrl: '/api/v1/desktop/releases/latest/download/macos'
          }
        : { available: false, platform: 'macOS 12+', architecture: 'universal', message: 'A signed and notarized release has not been published.' };
    const linuxRelease = linuxUrl
      ? { available: true, platform: 'Linux', architecture: 'x64', downloadUrl: linuxUrl }
      : linuxInstaller
        ? {
            available: true,
            platform: 'Linux',
            architecture: 'x64',
            locallyConfigured: true,
            bytes: linuxInstaller.bytes,
            downloadUrl: '/api/v1/desktop/releases/latest/download/linux'
          }
        : { available: false, platform: 'Linux', architecture: 'x64', message: 'A Linux release has not been published.' };
    return res.json({
      version,
      available: windowsRelease.available,
      platform: windowsRelease.platform,
      locallyConfigured: windowsRelease.locallyConfigured || false,
      ...(windowsRelease.bytes === undefined ? {} : { bytes: windowsRelease.bytes }),
      ...(windowsRelease.downloadUrl ? { downloadUrl: windowsRelease.downloadUrl } : {}),
      message: windowsRelease.message || null,
      platforms: {
        windows: windowsRelease,
        macos: macosRelease,
        linux: linuxRelease
      }
    });
  });

  app.get('/api/v1/desktop/releases/latest/download', (_req, res) => {
    const version = process.env.AURA_DESKTOP_VERSION || '0.1.0';
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
      return apiError(res, 'DESKTOP_RELEASE_INVALID', 'AURA_DESKTOP_VERSION must be a valid semantic version', {}, 503);
    }
    try {
      const downloadUrl = configuredDesktopReleaseUrl(
        'AURA_WINDOWS_DOWNLOAD_URL',
        `AURA-SILICON-Setup-${version}-x64.exe`
      );
      if (downloadUrl) return res.redirect(302, downloadUrl);
    } catch (error) {
      return apiError(res, 'DESKTOP_RELEASE_INVALID', error.message, {}, 503);
    }
    const installerPath = process.env.AURA_WINDOWS_INSTALLER_PATH;
    if (!installerPath) {
      return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'No Windows installer has been released yet', {}, 404);
    }
    try {
      const resolvedPath = path.resolve(installerPath);
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile() || path.extname(resolvedPath).toLowerCase() !== '.exe') {
        return apiError(res, 'DESKTOP_RELEASE_INVALID', 'The configured Windows release is not a valid installer file', {}, 503);
      }
      return res.download(resolvedPath, `AURA-SILICON-Setup-${process.env.AURA_DESKTOP_VERSION || '0.1.0'}.exe`);
    } catch (error) {
      if (error.code === 'ENOENT') return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'No Windows installer has been released yet', {}, 404);
      return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'The Windows installer could not be opened', {}, 503);
    }
  });

  app.get('/api/v1/desktop/releases/latest/download/:platform', (req, res) => {
    const version = process.env.AURA_DESKTOP_VERSION || '0.1.0';
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
      return apiError(res, 'DESKTOP_RELEASE_INVALID', 'AURA_DESKTOP_VERSION must be a valid semantic version', {}, 503);
    }
    const platform = req.params.platform;
    const releases = {
      macos: {
        urlKey: 'AURA_MACOS_DOWNLOAD_URL',
        pathKey: 'AURA_MACOS_INSTALLER_PATH',
        extension: '.dmg',
        filename: `AURA-SILICON-${version}-universal.dmg`
      },
      linux: {
        urlKey: 'AURA_LINUX_DOWNLOAD_URL',
        pathKey: 'AURA_LINUX_INSTALLER_PATH',
        extension: '.appimage',
        filename: `AURA-SILICON-${version}-x64.AppImage`
      }
    };
    const release = releases[platform];
    if (!release) {
      return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'No installer is available for this platform', {}, 404);
    }
    try {
      const downloadUrl = configuredDesktopReleaseUrl(release.urlKey, release.filename);
      if (downloadUrl) return res.redirect(302, downloadUrl);
      const defaultPath = path.join(rootDir, 'desktop', 'release', release.filename);
      const installer = getLocalDesktopInstaller(release.pathKey, release.extension, defaultPath);
      if (!installer) {
        return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'No installer has been released for this platform', {}, 404);
      }
      return res.download(installer.path, release.filename);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return apiError(res, 'DESKTOP_RELEASE_UNAVAILABLE', 'The configured installer could not be opened', {}, 404);
      }
      return apiError(res, 'DESKTOP_RELEASE_INVALID', error.message, {}, 503);
    }
  });

  app.post('/api/v1/auth/signup', signupRateLimit, (req, res) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Invalid sign-up payload', parsed.error.flatten(), 400);
    }

    const { name, email, password } = parsed.data;
    const existing = getUserByEmail(email);
    if (existing) {
      return apiError(res, 'USER_EXISTS', 'Account already exists for this email', { email }, 409);
    }

    bcrypt.hash(password, 10, (err, passwordHash) => {
      if (err) {
        return apiError(res, 'PASSWORD_HASH_FAILED', 'Failed to create password hash', {}, 500);
      }

      const createdUser = createUser({ name, email, passwordHash });
      const session = createSession(createdUser.id, createdUser.organizationId);
      const token = generateToken(createdUser, session.id);
      appendAudit({
        type: 'LOGIN',
        userId: createdUser.id,
        organizationId: createdUser.organizationId,
        message: 'User signed up',
        userEmail: createdUser.email
      });
      res.status(201).json({ user: publicUser(createdUser), token, organizationId: createdUser.organizationId });
    });
  });

  app.post('/api/v1/auth/login', loginRateLimit, (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Invalid login payload', parsed.error.flatten(), 400);
    }

    const { email, password } = parsed.data;
    const user = getUserByEmail(email);
    if (!user) {
      logSecurityEvent({ type: 'LOGIN_FAILURE', userEmail: email, reason: 'unknown_user' });
      return apiError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', {}, 401);
    }

    if (!user.passwordHash) {
      logSecurityEvent({ type: 'LOGIN_FAILURE', userId: user.id, userEmail: email, reason: 'password_login_unavailable' });
      return apiError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', {}, 401);
    }

    bcrypt.compare(password, user.passwordHash, (err, matches) => {
      if (err) {
        return apiError(res, 'PASSWORD_CHECK_FAILED', 'Failed to validate credentials', {}, 500);
      }

      if (!matches) {
        logSecurityEvent({ type: 'LOGIN_FAILURE', userId: user.id, userEmail: email, reason: 'bad_password' });
        return apiError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', {}, 401);
      }

      const session = createSession(user.id, user.organizationId);
      const token = generateToken(user, session.id);
      appendAudit({
        type: 'LOGIN',
        userId: user.id,
        organizationId: user.organizationId,
        message: 'User logged in',
        userEmail: user.email
      });
      res.json({ user: publicUser(user), token, organizationId: user.organizationId });
    });
  });

  app.get('/api/v1/auth/me', authMiddleware, (req, res) => {
    res.json({ user: publicUser(req.user), organizationId: req.user.organizationId });
  });

  app.post('/api/v1/auth/logout', authMiddleware, (req, res) => {
    revokeSession(req.sessionId, req.user.id);
    appendAudit({
      type: 'TOKEN_REVOKED',
      userId: req.user.id,
      organizationId: req.user.organizationId,
      message: 'User logged out'
    });
    res.json({ ok: true, message: 'Signed out' });
  });

  app.get('/api/v1/organizations', authMiddleware, (req, res) => {
    const state = readStore();
    const organizations = state.organizations.filter((org) => org.id === req.user.organizationId || org.members.includes(req.user.id));
    res.json({ organizations });
  });

  app.get('/api/v1/projects', authMiddleware, (req, res) => {
    const projects = listProjectsForUser(req.user.id);
    res.json({ projects });
  });

  const scanImportPayload = (req, res) => {
    const parsed = HardwareImportSchema.safeParse(req.body);
    if (!parsed.success) {
      apiError(res, 'VALIDATION_ERROR', 'Invalid hardware-project scan payload', parsed.error.flatten(), 400);
      return null;
    }
    try {
      return { parsed: parsed.data, analysis: analyzeHardwareProject(parsed.data) };
    } catch (error) {
      apiError(res, 'PROJECT_SCAN_REJECTED', error.message, {}, 400);
      return null;
    }
  };

  app.post('/api/v1/projects/import/scan', authMiddleware, (req, res) => {
    const scan = scanImportPayload(req, res);
    if (!scan) return;
    res.json({ analysis: publicImportAnalysis(scan.analysis) });
  });

  app.post('/api/v1/projects', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'rtlEditor')) return;
    const parsed = ProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Invalid project payload', parsed.error.flatten(), 400);
    }
    const usage = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'projects', usage.usage.projects)) return;

    const project = createProject({
      name: parsed.data.name,
      userId: req.user.id,
      organizationId: req.user.organizationId
    });
    res.status(201).json({ project });
  });

  app.post('/api/v1/projects/import', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'projectFolderImport')) return;
    const scan = scanImportPayload(req, res);
    if (!scan) return;
    const usage = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'projects', usage.usage.projects)) return;
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', usage.usage.storageBytes, scan.analysis.summary.totalBytes)) return;
    const project = importHardwareProject({
      name: scan.parsed.name,
      userId: req.user.id,
      organizationId: req.user.organizationId,
      analysis: scan.analysis
    });
    res.status(201).json({ project: publicProject(project), analysis: publicImportAnalysis(scan.analysis) });
  });

  app.post('/api/v1/projects/:projectId/rescan', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'projectFolderImport')) return;
    const scan = scanImportPayload(req, res);
    if (!scan) return;
    const currentProject = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!currentProject?.importedProject) return apiError(res, 'PROJECT_NOT_IMPORTED', 'Select an existing imported project to refresh its AURA workspace copy', {}, 404);
    const usage = getUsageSnapshot(req.user.organizationId);
    const currentProjectBytes = currentProject.sourceFiles.reduce((total, file) => total + (file.size || Buffer.byteLength(file.content || '', 'utf8')), 0);
    const storageIncrease = Math.max(0, scan.analysis.summary.totalBytes - currentProjectBytes);
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', usage.usage.storageBytes, storageIncrease)) return;
    const project = replaceImportedHardwareProject({
      projectId: req.params.projectId,
      userId: req.user.id,
      organizationId: req.user.organizationId,
      analysis: scan.analysis
    });
    if (!project) return apiError(res, 'PROJECT_NOT_IMPORTED', 'Select an existing imported project to refresh its AURA workspace copy', {}, 404);
    res.json({ project: publicProject(project), analysis: publicImportAnalysis(scan.analysis) });
  });

  app.get('/api/v1/projects/:projectId/import-analysis', authMiddleware, (req, res) => {
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    if (!project.importedProject) return apiError(res, 'PROJECT_NOT_IMPORTED', 'Project has no imported-folder analysis', {}, 409);
    res.json({ importAnalysis: project.importedProject });
  });

  app.put('/api/v1/projects/:projectId/top-module', authMiddleware, (req, res) => {
    const parsed = TopModuleSchema.safeParse(req.body);
    if (!parsed.success) return apiError(res, 'VALIDATION_ERROR', 'Invalid top-module selection', parsed.error.flatten(), 400);
    const result = setProjectTopModule(req.params.projectId, req.user.organizationId, parsed.data.topModule);
    if (result === null) return apiError(res, 'PROJECT_NOT_IMPORTED', 'Project has no imported-folder analysis', {}, 404);
    if (result === false) return apiError(res, 'TOP_MODULE_NOT_FOUND', 'Selected module is not among detected project modules', {}, 400);
    res.json({ topModule: result.importedProject.topModule });
  });

  app.get('/api/v1/projects/:projectId/design-brief', authMiddleware, (req, res) => {
    const briefs = getProjectDesignBriefs(req.params.projectId, req.user.organizationId);
    if (briefs === null) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const aiAvailable = getAiProviderStatus().configured;
    res.json({
      briefs,
      agentStatus: aiAvailable ? 'READY' : 'UNAVAILABLE',
      message: aiAvailable
        ? 'Saved project briefs are context only. Choose Ask AI Hardware or Generate Testbench with AI to send an explicit request.'
        : 'Saved project briefs are context only. Configure a rotated AI provider key on the server to enable Ask AI Hardware and AI testbench generation.'
    });
  });

  app.put('/api/v1/projects/:projectId/design-brief', authMiddleware, (req, res) => {
    const parsed = z.object({ request: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!parsed.success) return apiError(res, 'VALIDATION_ERROR', 'Invalid design brief', parsed.error.flatten(), 400);
    const brief = saveProjectDesignBrief(req.params.projectId, req.user.organizationId, req.user.id, parsed.data.request);
    if (!brief) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const aiAvailable = getAiProviderStatus().configured;
    res.json({
      brief,
      agentStatus: aiAvailable ? 'READY' : 'UNAVAILABLE',
      message: aiAvailable
        ? 'The design brief was saved only. It was not sent to AI or executed; choose an AI action separately.'
        : 'The design brief was saved only. It was not sent to AI or executed. Configure a rotated AI provider key on the server to enable AI actions.'
    });
  });

  app.post('/api/v1/projects/:projectId/ai/requests', authMiddleware, async (req, res) => {
    const parsed = z.object({
      request: z.string().trim().min(1).max(4000),
      consentToSendSource: z.literal(true)
    }).safeParse(req.body);
    if (!parsed.success) return apiError(res, 'VALIDATION_ERROR', 'Provide an AI request and confirm source sharing', parsed.error.flatten(), 400);
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.aiHardwareEngineer) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'AI hardware analysis is not enabled for this plan', {
        feature: 'aiHardwareEngineer',
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (enforceUsageLimit(res, req.user.organizationId, 'aiRequestsMonthly', snapshot.usage.aiRequestsThisMonth)) return;
    const provider = getAiProviderStatus();
    if (!provider.configured) {
      return apiError(res, 'AI_PROVIDER_UNAVAILABLE', provider.reason || 'No AI provider is configured on the AURA server', {}, 503);
    }
    const sourceFiles = (project.sourceFiles || [])
      .filter((file) => /\.(?:v|sv|vh|svh)$/i.test(file.name) && (file.category === 'rtl' || !file.category))
      .filter((file) => !/(?:secret|credential|password|token|\.env)/i.test(file.name));
    if (!sourceFiles.length) {
      return apiError(res, 'RTL_CONTEXT_EMPTY', 'This project has no eligible Verilog/SystemVerilog source files to analyze', {}, 400);
    }
    if (sourceFiles.length > 30 || sourceFiles.some((file) => Buffer.byteLength(file.content || '', 'utf8') > 100_000) ||
      sourceFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content || '', 'utf8'), 0) > 250_000) {
      return apiError(res, 'RTL_CONTEXT_TOO_LARGE', 'Selected RTL context exceeds the AI request limit (30 files, 100 KB per file, 250 KB total)', {}, 413);
    }

    try {
      const result = await requestHardwareAnalysis({
        request: parsed.data.request,
        files: sourceFiles.map(({ name, content }) => ({ name, content }))
      });
      recordAiRequest(req.user.organizationId, req.user.id, project.id);
      appendAudit({
        type: 'AI_HARDWARE_ANALYSIS',
        userId: req.user.id,
        organizationId: req.user.organizationId,
        projectId: project.id,
        message: `AI hardware analysis completed using ${result.provider}`
      });
      return res.json({
        provider: result.provider,
        model: result.model,
        answer: result.answer,
        sourceFileCount: sourceFiles.length,
        sourceModified: false,
        message: 'Analysis only. No project files were changed, and no compile, simulation, or synthesis was run.'
      });
    } catch (error) {
      if (error.code === 'AI_PROVIDER_UNAVAILABLE') {
        return apiError(res, error.code, error.message, {}, 503);
      }
      return apiError(res, error.code || 'AI_PROVIDER_REQUEST_FAILED', error.message, {}, 502);
    }
  });

  app.post('/api/v1/projects/:projectId/ai/designs', authMiddleware, async (req, res) => {
    const parsed = z.object({
      request: z.string().trim().min(1).max(4000),
      consentToSendSource: z.literal(true),
      consentToExecute: z.literal(true)
    }).safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Describe the hardware, approve sending the request to AI, and authorize local Icarus compilation and simulation', parsed.error.flatten(), 400);
    }
    const sourceProject = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!sourceProject) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const simulator = getSimulationStatus();
    if (!simulator.available) {
      return apiError(res, 'SIMULATOR_NOT_FOUND', simulator.reason || 'Icarus Verilog is not configured', {}, 503);
    }
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.aiHardwareEngineer || !plan.features.simulation) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'AI design generation requires AI hardware and simulation features on this plan', {
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (enforceUsageLimit(res, req.user.organizationId, 'projects', snapshot.usage.projects)) return;
    if (enforceUsageLimit(res, req.user.organizationId, 'aiRequestsMonthly', snapshot.usage.aiRequestsThisMonth)) return;
    if (enforceUsageLimit(res, req.user.organizationId, 'simulationJobsMonthly', snapshot.usage.simulationJobsThisMonth)) return;
    if (!getAiProviderStatus().configured) {
      const provider = getAiProviderStatus();
      return apiError(res, 'AI_PROVIDER_UNAVAILABLE', provider.reason || 'No AI provider is configured', {}, 503);
    }

    let candidate;
    let providerResult;
    try {
      providerResult = await requestHardwareProjectGeneration({ request: parsed.data.request });
    } catch (error) {
      const statusCode = error.code === 'AI_PROVIDER_UNAVAILABLE' ? 503 : 502;
      return apiError(res, error.code || 'AI_PROVIDER_REQUEST_FAILED', error.message, {}, statusCode);
    }
    recordAiRequest(req.user.organizationId, req.user.id, sourceProject.id);
    try {
      candidate = JSON.parse(providerResult.answer);
    } catch {
      return apiError(res, 'AI_DESIGN_INVALID_RESPONSE', 'AI did not return the required RTL/testbench project format. No project was created.', {}, 502);
    }

    const generatedSchema = z.object({
      topModule: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      rtl: z.string().min(1).max(100_000),
      testbenchModule: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      testbench: z.string().min(1).max(100_000)
    }).strict();
    let generated = generatedSchema.safeParse(candidate);
    if (!generated.success) {
      return apiError(res, 'AI_DESIGN_INVALID_RESPONSE', 'AI returned invalid RTL or testbench fields. No project was created.', {}, 502);
    }
    const requestedTopModule = generated.data.topModule;

    let simulation;
    let repairCount = 0;
    const makeCandidateProject = (design) => ({
      id: 'aura-generated-candidate',
      sourceFiles: [
        { id: 'candidate-rtl', name: 'top.sv', category: 'rtl', content: design.rtl },
        { id: 'candidate-testbench',         name: `tb/${design.topModule}_tb.sv`, category: 'testbenches', content: design.testbench }
      ]
    });
    while (true) {
      const currentUsage = getUsageSnapshot(req.user.organizationId);
      if (enforceUsageLimit(res, req.user.organizationId, 'simulationJobsMonthly', currentUsage.usage.simulationJobsThisMonth)) return;
      const candidateProject = makeCandidateProject(generated.data);
      const discoveredTestbench = getTestbenchModules(candidateProject).find((item) =>
        item.path === `tb/${generated.data.topModule}_tb.sv` &&
        item.module === generated.data.testbenchModule
      );
      const hasDut = new RegExp(`\\bmodule\\s+(?:automatic\\s+|static\\s+)?${generated.data.topModule}\\b`).test(generated.data.rtl);
      const testbenchWithoutComments = generated.data.testbench
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\r\n]*/g, ' ');
      const instantiatesDut = new RegExp(`\\b${generated.data.topModule}\\s*(?:#\\s*\\([\\s\\S]*?\\)\\s*)?[A-Za-z_][A-Za-z0-9_$]*\\s*\\(`)
        .test(testbenchWithoutComments);
      const hasSelfChecks = /\$fatal\s*\(/.test(testbenchWithoutComments);
      const hasCompletionMarker = /AURA_ALL_TESTS_PASS/.test(testbenchWithoutComments) &&
        /\$finish\b(?:\s*\()?\s*;/.test(testbenchWithoutComments);
      if (!discoveredTestbench || !hasDut || !instantiatesDut || !hasSelfChecks || !hasCompletionMarker) {
        return apiError(res, 'AI_DESIGN_INVALID_RESPONSE', 'AI output must declare and instantiate the requested DUT, include $fatal self-checks, and print AURA_ALL_TESTS_PASS before $finish. No project was created.', {}, 422);
      }
      try {
        simulation = await runIcarusSimulation({
          project: candidateProject,
          testbenchPath: discoveredTestbench.path,
          testbenchModule: discoveredTestbench.module,
          onStart: () => recordSimulationRequest(req.user.organizationId, req.user.id, sourceProject.id)
        });
        if (!/AURA_ALL_TESTS_PASS/.test(simulation.output) ||
          !/\bTEST\b.*\bPASS\b/i.test(simulation.output) ||
          /\b(?:FAIL|ERROR)\b/i.test(simulation.output)) {
          throw Object.assign(new Error(`Testbench did not report a clean pass.\n${simulation.output}`), {
            code: 'SIMULATION_ASSERTION_FAILED'
          });
        }
        break;
      } catch (error) {
        const isRepairable = [
          'SIMULATION_COMPILE_FAILED',
          'SIMULATION_FAILED',
          'SIMULATION_ASSERTION_FAILED'
        ].includes(error.code);
        if (!isRepairable || repairCount >= 2) {
          return apiError(res, error.code || 'AI_DESIGN_VERIFICATION_FAILED', `Generated design did not pass Icarus verification after ${repairCount} repair attempt(s): ${error.message}`, {
            repairCount,
            projectCreated: false
          }, 422);
        }
        if (enforceUsageLimit(res, req.user.organizationId, 'aiRequestsMonthly', getUsageSnapshot(req.user.organizationId).usage.aiRequestsThisMonth)) return;
        try {
          providerResult = await requestHardwareProjectRepair({
            request: parsed.data.request,
            topModule: generated.data.topModule,
            candidate: generated.data,
            diagnostics: error.message
          });
        } catch (providerError) {
          const statusCode = providerError.code === 'AI_PROVIDER_UNAVAILABLE' ? 503 : 502;
          return apiError(res, providerError.code || 'AI_PROVIDER_REQUEST_FAILED', providerError.message, {
            repairCount,
            projectCreated: false
          }, statusCode);
        }
        recordAiRequest(req.user.organizationId, req.user.id, sourceProject.id);
        try {
          candidate = JSON.parse(providerResult.answer);
        } catch {
          return apiError(res, 'AI_DESIGN_INVALID_RESPONSE', 'AI repair did not return valid JSON. No project was created.', {
            repairCount,
            projectCreated: false
          }, 502);
        }
        generated = generatedSchema.safeParse(candidate);
        if (!generated.success || generated.data.topModule !== requestedTopModule) {
          return apiError(res, 'AI_DESIGN_INVALID_RESPONSE', 'AI repair returned invalid RTL/testbench fields. No project was created.', {
            repairCount,
            projectCreated: false
          }, 502);
        }
        repairCount += 1;
      }
    }

    const storageIncrease = Math.max(0,
      Buffer.byteLength(generated.data.rtl, 'utf8') - Buffer.byteLength('module top;\nendmodule', 'utf8')) +
      Buffer.byteLength(generated.data.testbench, 'utf8');
    const latestSnapshot = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', latestSnapshot.usage.storageBytes, storageIncrease)) return;
    const generatedProject = createProject({
      name: `AI Design - ${generated.data.topModule}`,
      userId: req.user.id,
      organizationId: req.user.organizationId
    });
    updateProjectFile(generatedProject.id, req.user.organizationId, 'top.sv', generated.data.rtl);
    const testbenchFile = updateProjectFile(
      generatedProject.id,
      req.user.organizationId,
      `tb/${generated.data.topModule}_tb.sv`,
      generated.data.testbench
    );
    saveProjectDesignBrief(generatedProject.id, req.user.organizationId, req.user.id, parsed.data.request);
    appendAudit({
      type: 'AI_HARDWARE_PROJECT_GENERATED',
      userId: req.user.id,
      organizationId: req.user.organizationId,
      projectId: generatedProject.id,
      message: `AI-generated ${generated.data.topModule} passed Icarus compile and self-checking simulation`
    });
    return res.status(201).json({
      project: { id: generatedProject.id, name: generatedProject.name },
      rtl: { file: 'top.sv', topModule: generated.data.topModule },
      testbench: { file: testbenchFile.name, module: generated.data.testbenchModule },
      simulation,
      provider: providerResult.provider,
      model: providerResult.model,
      repairCount,
      message: `Created ${generatedProject.name}. Icarus compile and self-checking simulation passed${repairCount ? ` after ${repairCount} AI repair attempt(s)` : ''}.`
    });
  });

  app.post('/api/v1/projects/:projectId/ai/testbenches', authMiddleware, async (req, res) => {
    const parsed = z.object({
      request: z.string().trim().min(1).max(4000),
      consentToSendSource: z.literal(true)
    }).safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Describe the testbench and confirm that the prompt and RTL may be sent to the AI provider', parsed.error.flatten(), 400);
    }
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.aiHardwareEngineer) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'AI testbench generation is not enabled for this plan', {
        feature: 'aiHardwareEngineer',
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (enforceUsageLimit(res, req.user.organizationId, 'aiRequestsMonthly', snapshot.usage.aiRequestsThisMonth)) return;
    const provider = getAiProviderStatus();
    if (!provider.configured) {
      return apiError(res, 'AI_PROVIDER_UNAVAILABLE', provider.reason || 'No AI provider is configured on the AURA server', {}, 503);
    }
    const sourceFiles = (project.sourceFiles || [])
      .filter((file) => /\.(?:v|sv|vh|svh)$/i.test(file.name) && classifyProjectFileCategory(file.name) === 'rtl')
      .filter((file) => !/(?:secret|credential|password|token|\.env)/i.test(file.name));
    if (!sourceFiles.length) {
      return apiError(res, 'RTL_CONTEXT_EMPTY', 'Add and save design RTL before generating a testbench', {}, 400);
    }
    if (sourceFiles.length > 30 || sourceFiles.some((file) => Buffer.byteLength(file.content || '', 'utf8') > 100_000) ||
      sourceFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content || '', 'utf8'), 0) > 250_000) {
      return apiError(res, 'RTL_CONTEXT_TOO_LARGE', 'RTL context exceeds the AI request limit (30 files, 100 KB per file, 250 KB total)', {}, 413);
    }

    let result;
    try {
      result = await requestTestbenchGeneration({
        request: parsed.data.request,
        files: sourceFiles.map(({ name, content }) => ({ name, content }))
      });
    } catch (error) {
      const statusCode = error.code === 'AI_PROVIDER_UNAVAILABLE' ? 503 : 502;
      return apiError(res, error.code || 'AI_PROVIDER_REQUEST_FAILED', error.message, {}, statusCode);
    }
    recordAiRequest(req.user.organizationId, req.user.id, project.id);

    let responsePayload;
    try {
      responsePayload = JSON.parse(result.answer);
    } catch {
      return apiError(res, 'AI_TESTBENCH_INVALID_RESPONSE', 'The AI provider did not return the required JSON testbench. No files were saved.', {}, 502);
    }
    const generated = z.object({
      file: z.string().min(1).max(500),
      content: z.string().min(1).max(100_000)
    }).strict().safeParse(responsePayload);
    if (!generated.success || !validateProjectPath(generated.data?.file) ||
      classifyProjectFileCategory(generated.data?.file) !== 'testbenches' ||
      !/\.(?:v|sv)$/i.test(generated.data.file)) {
      return apiError(res, 'AI_TESTBENCH_INVALID_RESPONSE', 'The AI provider returned an unsafe or invalid testbench file. No files were saved.', {}, 502);
    }
    if (project.sourceFiles.some((file) => file.name === generated.data.file)) {
      return apiError(res, 'AI_TESTBENCH_FILE_EXISTS', 'The generated testbench path already exists. Rename or remove the existing file before generating another.', {
        file: generated.data.file
      }, 409);
    }
    if (/\$\s*(?:system|fopen|fclose|fseek|ftell|rewind|fgetc|fgets|fscanf|fread|fwrite|fdisplay|fmonitor|readmemh|readmemb|writememh|writememb|dumpfile)\b/i.test(generated.data.content)) {
      return apiError(res, 'AI_TESTBENCH_UNSAFE', 'The generated testbench contains a blocked system or file-access task. No files were saved.', {}, 422);
    }
    const modules = getTestbenchModules({
      ...project,
      sourceFiles: [...project.sourceFiles, {
        name: generated.data.file,
        content: generated.data.content,
        category: 'testbenches'
      }]
    }).filter((item) => item.path === generated.data.file);
    if (!modules.length) {
      return apiError(res, 'AI_TESTBENCH_INVALID_RESPONSE', 'Generated testbench did not contain a valid module declaration. No files were saved.', {}, 422);
    }
    const storageIncrease = Buffer.byteLength(generated.data.content, 'utf8');
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', snapshot.usage.storageBytes, storageIncrease)) return;
    const file = updateProjectFile(project.id, req.user.organizationId, generated.data.file, generated.data.content);
    if (!file) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    appendAudit({
      type: 'AI_TESTBENCH_GENERATED',
      userId: req.user.id,
      organizationId: req.user.organizationId,
      projectId: project.id,
      message: `AI generated testbench ${file.name} using ${result.provider}`
    });
    return res.status(201).json({
      provider: result.provider,
      model: result.model,
      file,
      testbenchModules: modules,
      message: `Generated and saved ${file.name}. Select its module and authorize local execution to run it; AI has not run or verified this testbench.`
    });
  });

  app.post('/api/v1/projects/:projectId/ai/auto-fix', authMiddleware, async (req, res) => {
    const parsed = z.object({
      jobId: z.string().min(1).max(100),
      consentToSendSource: z.literal(true)
    }).safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Select a failed compile job and confirm source sharing and automatic repair', parsed.error.flatten(), 400);
    }
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const job = listJobsForOrganization(req.user.organizationId).find((item) =>
      item.id === parsed.data.jobId && item.projectId === project.id
    );
    if (!job || job.status !== 'failed' || !job.diagnostics?.length) {
      return apiError(res, 'AUTO_FIX_JOB_UNAVAILABLE', 'Automatic repair requires a failed compile job from this project with compiler diagnostics', {}, 409);
    }
    const version = getProjectVersion(project.id, job.versionId, req.user.organizationId);
    if (!version) return apiError(res, 'PROJECT_VERSION_NOT_FOUND', 'The failed job source version is no longer available', {}, 404);
    const failedDiagnostics = job.diagnostics.filter((item) => item.severity === 'ERROR');
    const versionRtlFiles = (version.sourceFiles || []).filter((file) =>
      classifyProjectFileCategory(file.name) === 'rtl' &&
      /\.(?:v|sv|vh|svh)$/i.test(file.name) &&
      validateProjectPath(file.name) &&
      !/(?:secret|credential|password|token|\.env)/i.test(file.name)
    );
    if (!failedDiagnostics.length || !versionRtlFiles.length) {
      return apiError(res, 'AUTO_FIX_CONTEXT_UNAVAILABLE', 'The failed job has no eligible RTL file and compiler diagnostics to repair', {}, 400);
    }
    if (versionRtlFiles.length > 30 || versionRtlFiles.some((file) => Buffer.byteLength(file.content || '', 'utf8') > 100_000) ||
      versionRtlFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content || '', 'utf8'), 0) > 250_000) {
      return apiError(res, 'RTL_CONTEXT_TOO_LARGE', 'RTL repair context exceeds the AI request limit (30 files, 100 KB per file, 250 KB total)', {}, 413);
    }
    const targetFile = failedDiagnostics
      .map((item) => item.location?.file)
      .find((name) => versionRtlFiles.some((file) => file.name === name));
    if (!targetFile) {
      return apiError(res, 'AUTO_FIX_TARGET_UNAVAILABLE', 'Compiler diagnostics do not identify an editable RTL file to repair', {}, 422);
    }
    const failedSource = versionRtlFiles.find((file) => file.name === targetFile);
    const currentSource = project.sourceFiles.find((file) => file.name === targetFile);
    if (!currentSource || currentSource.content !== failedSource.content) {
      return apiError(res, 'AUTO_FIX_STALE_SOURCE', 'Project RTL changed after this compile. Compile the latest source before requesting an automatic repair.', {}, 409);
    }

    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.aiHardwareEngineer) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'AI hardware repair is not enabled for this plan', {
        feature: 'aiHardwareEngineer',
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (enforceUsageLimit(res, req.user.organizationId, 'aiRequestsMonthly', snapshot.usage.aiRequestsThisMonth)) return;
    const provider = getAiProviderStatus();
    if (!provider.configured) {
      return apiError(res, 'AI_PROVIDER_UNAVAILABLE', provider.reason || 'No AI provider is configured on the AURA server', {}, 503);
    }

    let result;
    try {
      result = await requestHardwareRepair({
        targetFile,
        files: versionRtlFiles.map(({ name, content }) => ({ name, content })),
        diagnostics: failedDiagnostics
      });
    } catch (error) {
      const statusCode = error.code === 'AI_PROVIDER_UNAVAILABLE' ? 503 : 502;
      return apiError(res, error.code || 'AI_PROVIDER_REQUEST_FAILED', error.message, {}, statusCode);
    }
    recordAiRequest(req.user.organizationId, req.user.id, project.id);

    let responsePayload;
    try {
      responsePayload = JSON.parse(result.answer);
    } catch {
      return apiError(res, 'AI_REPAIR_INVALID_RESPONSE', 'The AI provider did not return the required JSON repair. No project files were changed.', {}, 502);
    }
    const repair = z.object({
      file: z.string().min(1).max(500),
      content: z.string().min(1).max(100_000)
    }).strict().safeParse(responsePayload);
    if (!repair.success || repair.data.file !== targetFile) {
      return apiError(res, 'AI_REPAIR_INVALID_RESPONSE', 'The AI provider returned an invalid file repair. No project files were changed.', {}, 502);
    }
    if (repair.data.content === failedSource.content) {
      return apiError(res, 'AI_REPAIR_NO_CHANGE', 'The AI provider returned unchanged RTL. No project files were changed.', {}, 422);
    }

    const candidateFiles = versionRtlFiles.map((file) => file.name === targetFile
      ? { ...file, content: repair.data.content }
      : file
    );
    const validation = compileRtl({
      files: candidateFiles,
      projectVersionId: version.id,
      compilerVersion: version.compilerVersion,
      topModule: version.topModule
    });
    if (!validation.ok) {
      return apiError(res, 'AUTO_FIX_VALIDATION_FAILED', 'The suggested repair did not pass AURA RTL compiler validation. No project files were changed.', {
        diagnostics: validation.diagnostics
      }, 422);
    }
    const storageIncrease = Math.max(0, Buffer.byteLength(repair.data.content, 'utf8') -
      Buffer.byteLength(currentSource.content || '', 'utf8'));
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', snapshot.usage.storageBytes, storageIncrease)) return;
    const repairedFile = updateProjectFile(project.id, req.user.organizationId, targetFile, repair.data.content);
    if (!repairedFile) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    appendAudit({
      type: 'AI_HARDWARE_AUTO_FIX',
      userId: req.user.id,
      organizationId: req.user.organizationId,
      projectId: project.id,
      message: `AI repaired ${targetFile}; AURA RTL compiler validation passed`
    });
    return res.json({
      provider: result.provider,
      model: result.model,
      file: repairedFile,
      validation: 'AURA_RTL_COMPILER_PASSED',
      message: `AI repair applied to ${targetFile} after AURA RTL compiler validation. Create a new version and compile to continue.`
    });
  });

  app.get('/api/v1/projects/:projectId/simulation/testbenches', authMiddleware, (req, res) => {
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const status = getSimulationStatus();
    res.json({
      available: status.available,
      simulator: status.simulator,
      reason: status.reason,
      testbenches: getTestbenchModules(project)
    });
  });

  app.post('/api/v1/projects/:projectId/simulation/run', authMiddleware, async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return apiError(res, 'SIMULATION_LOCAL_ONLY', 'Simulation execution is restricted to the local AURA computer', {}, 403);
    }
    const parsed = z.object({
      testbenchPath: z.string().min(1).max(500),
      testbenchModule: z.string().min(1).max(200),
      consentToExecute: z.literal(true)
    }).safeParse(req.body);
    if (!parsed.success) return apiError(res, 'VALIDATION_ERROR', 'Select a testbench and confirm local execution', parsed.error.flatten(), 400);
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.simulation) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'Simulation is not enabled for this plan', {
        feature: 'simulation',
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (enforceUsageLimit(res, req.user.organizationId, 'simulationJobsMonthly', snapshot.usage.simulationJobsThisMonth)) return;
    const simulatorStatus = getSimulationStatus();
    if (!simulatorStatus.available) {
      return apiError(res, 'SIMULATOR_NOT_FOUND', simulatorStatus.reason, {}, 503);
    }
    const availableTestbenches = getTestbenchModules(project);
    if (!availableTestbenches.some((item) =>
      item.path === parsed.data.testbenchPath && item.module === parsed.data.testbenchModule
    )) {
      return apiError(res, 'INVALID_TESTBENCH', 'The selected testbench module was not found in the selected project file', {}, 400);
    }
    try {
      const result = await runIcarusSimulation({
        project,
        testbenchPath: parsed.data.testbenchPath,
        testbenchModule: parsed.data.testbenchModule,
        onStart: () => recordSimulationRequest(req.user.organizationId, req.user.id, project.id)
      });
      appendAudit({
        type: 'SIMULATION',
        userId: req.user.id,
        organizationId: req.user.organizationId,
        projectId: project.id,
        message: `Local ${result.simulator} simulation completed`
      });
      return res.json({
        simulation: result,
        message: 'Simulation completed locally. Project files were not changed.'
      });
    } catch (error) {
      const statusCode = error.code === 'SIMULATOR_NOT_FOUND' ? 503
        : error.code === 'SIMULATION_TIMEOUT' || error.code === 'SIMULATION_COMPILE_TIMEOUT' ? 408
          : error.code === 'SIMULATION_INPUT_TOO_LARGE' || error.code === 'UNSAFE_SIMULATION_SOURCE' ||
            error.code === 'UNSAFE_SIMULATION_INCLUDE' || error.code === 'UNSAFE_SIMULATION_PATH' ? 400
              : error.code === 'INVALID_TESTBENCH' ? 400 : 422;
      return apiError(res, error.code || 'SIMULATION_FAILED', error.message, {}, statusCode);
    }
  });

  app.post('/api/v1/projects/:projectId/physical-design', authMiddleware, async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return apiError(res, 'PHYSICAL_DESIGN_LOCAL_ONLY', 'OpenLane execution is restricted to the local AURA computer', {}, 403);
    }
    const parsed = PhysicalDesignSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Select a top module and confirm local OpenLane execution', parsed.error.flatten(), 400);
    }
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, getPricingConfig());
    if (!plan.features.physicalDesign || !plan.features.synthesis || !plan.features.gdsii) {
      return apiError(res, 'FEATURE_NOT_AVAILABLE', 'Synthesis, physical design, and GDSII are not enabled for this plan', {
        planId: plan.id,
        upgradeUrl: '/pricing'
      }, 403);
    }
    if (physicalDesignJobActive) {
      return apiError(res, 'PHYSICAL_DESIGN_BUSY', 'Another local OpenLane job is already running', {}, 409);
    }
    const status = await physicalDesignStatus();
    if (!status.available) {
      return apiError(res, 'OPENLANE_NOT_READY', status.reason, { toolchain: status.toolchain }, 503);
    }
    const rtlFiles = project.sourceFiles.filter((file) =>
      file.category === 'rtl' && ['.v', '.sv', '.vh', '.svh'].includes(path.extname(file.name).toLowerCase())
    );
    if (!rtlFiles.some((file) => ['.v', '.sv'].includes(path.extname(file.name).toLowerCase()))) {
      return apiError(res, 'RTL_SOURCE_REQUIRED', 'Add at least one Verilog or SystemVerilog design source before running OpenLane', {}, 400);
    }
    let analysis;
    try {
      analysis = analyzeHardwareProject({
        files: rtlFiles.map((file) => ({ path: file.name, content: file.content }))
      });
    } catch (error) {
      return apiError(res, 'RTL_ANALYSIS_FAILED', error.message, {}, 400);
    }
    const topModule = analysis.modules.find((module) => module.name === parsed.data.topModule && !module.testbench);
    if (!topModule) return apiError(res, 'TOP_MODULE_NOT_FOUND', 'Selected top module was not found in the project RTL sources', {}, 400);
    if (analysis.dependencies.length) {
      return apiError(res, 'UNRESOLVED_RTL_DEPENDENCIES', 'Resolve all referenced RTL modules before starting OpenLane', {
        dependencies: analysis.dependencies
      }, 400);
    }
    if (snapshot.usage.storageBytes >= plan.limits.storageBytes) {
      return apiError(res, 'USAGE_LIMIT_REACHED', 'Organization storage limit reached', {
        metric: 'storageBytes',
        limit: plan.limits.storageBytes,
        used: snapshot.usage.storageBytes,
        planId: plan.id
      }, 429);
    }
    const version = createProjectVersion({
      projectId: project.id,
      organizationId: req.user.organizationId,
      userId: req.user.id
    });
    if (!version) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const job = createJob({
      userId: req.user.id,
      organizationId: req.user.organizationId,
      projectId: project.id,
      title: `OpenLane physical design · ${topModule.name}`,
      versionId: version.id,
      sourceHash: version.contentHash,
      jobType: 'physical_design',
      topModule: topModule.name
    });
    physicalDesignJobActive = true;
    queuePhysicalDesign(job, version, topModule.name, physicalDesignRunner);
    res.status(202).json({
      job: { ...job, versionId: version.id, sourceHash: version.contentHash },
      message: 'Local OpenLane 2 + SKY130 job accepted. No physical result exists until the run finishes and its GDSII/netlist outputs are verified.'
    });
  });

  app.get('/api/v1/project-versions', authMiddleware, (req, res) => {
    const projectId = String(req.query.projectId || '');
    const project = getProjectForOrganization(projectId, req.user.organizationId);
    if (!project) {
      return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', { projectId }, 404);
    }
    res.json({ versions: project.versions || [] });
  });

  app.get('/api/v1/files', authMiddleware, (req, res) => {
    const projectId = String(req.query.projectId || '');
    const project = getProjectForOrganization(projectId, req.user.organizationId);
    if (!project) {
      return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', { projectId }, 404);
    }
    res.json({ files: project.sourceFiles || [] });
  });

  app.put('/api/v1/projects/:projectId/files', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'rtlEditor')) return;
    const parsed = FileSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Invalid source file payload', parsed.error.flatten(), 400);
    }
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const oldFile = project.sourceFiles.find((item) => item.name === parsed.data.name);
    const oldBytes = oldFile ? oldFile.size ?? Buffer.byteLength(oldFile.content || '', 'utf8') : 0;
    const requestedBytes = Buffer.byteLength(parsed.data.content, 'utf8') - oldBytes;
    const usage = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', usage.usage.storageBytes, requestedBytes)) return;
    const file = updateProjectFile(req.params.projectId, req.user.organizationId, parsed.data.name, parsed.data.content);
    if (!file) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    res.json({ file });
  });

  app.post('/api/v1/projects/:projectId/versions', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'rtlEditor')) return;
    const project = getProjectForOrganization(req.params.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const versionBytes = project.sourceFiles.reduce((sum, file) => sum + (file.size || Buffer.byteLength(file.content || '', 'utf8')), 0);
    const usage = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'storageBytes', usage.usage.storageBytes, versionBytes)) return;
    const version = createProjectVersion({
      projectId: req.params.projectId,
      organizationId: req.user.organizationId,
      userId: req.user.id
    });
    if (!version) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    res.status(201).json({ version });
  });

  app.post('/api/v1/compiler/compile', authMiddleware, (req, res) => {
    if (enforcePlanFeature(res, req.user.organizationId, 'auraIrCompiler')) return;
    const parsed = CompileSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 'VALIDATION_ERROR', 'Invalid compile payload', parsed.error.flatten(), 400);
    }

    const project = getProjectForOrganization(parsed.data.projectId, req.user.organizationId);
    if (!project) return apiError(res, 'PROJECT_NOT_FOUND', 'Project not found', {}, 404);
    const version = getProjectVersion(parsed.data.projectId, parsed.data.versionId, req.user.organizationId);
    if (!version) return apiError(res, 'PROJECT_VERSION_NOT_FOUND', 'Immutable project version not found', {}, 404);
    const usage = getUsageSnapshot(req.user.organizationId);
    if (enforceUsageLimit(res, req.user.organizationId, 'compilerJobsMonthly', usage.usage.compilerJobsThisMonth)) return;

    const job = createJob({
      userId: req.user.id,
      organizationId: req.user.organizationId,
      projectId: parsed.data.projectId,
      title: parsed.data.title,
      versionId: version.id,
      sourceHash: version.contentHash
    });
    updateJob(job.id, req.user.organizationId, {}, 'job.started');
    queueCompile(job, version);
    res.status(202).json({ job: { ...job, versionId: version.id, sourceHash: version.contentHash }, message: 'Compile job accepted' });
  });

  app.get('/api/v1/jobs', authMiddleware, (req, res) => {
    const jobs = listJobsForOrganization(req.user.organizationId);
    res.json({ jobs });
  });

  app.get('/api/v1/jobs/:jobId', authMiddleware, (req, res) => {
    const job = listJobsForOrganization(req.user.organizationId).find((item) => item.id === req.params.jobId);
    if (!job) return apiError(res, 'JOB_NOT_FOUND', 'Job not found', {}, 404);
    res.json({ job });
  });

  app.get('/api/v1/artifacts', authMiddleware, (req, res) => {
    const artifacts = listArtifactsForOrganization(req.user.organizationId);
    res.json({ artifacts });
  });

  app.get('/api/v1/artifacts/:artifactId/download', authMiddleware, (req, res) => {
    const artifact = getArtifactForOrganization(req.params.artifactId, req.user.organizationId);
    if (!artifact) return apiError(res, 'ARTIFACT_NOT_FOUND', 'Artifact not found', {}, 404);
    try {
      const content = readArtifact(artifact);
      const downloadContent = artifact.type === 'OPENLANE_METRICS'
        ? normalizeOpenLaneMetricsJson(content)
        : content;
      res.type(artifact.mimeType).attachment(artifact.name).send(downloadContent);
    } catch {
      apiError(res, 'ARTIFACT_STORAGE_ERROR', 'Artifact could not be read from storage', {}, 500);
    }
  });

  app.get('/api/v1/visualization', authMiddleware, async (req, res) => {
    const status = await physicalDesignStatus();
    res.json({
      status: 'VERIFIED_GDSII_LAYOUT_AVAILABLE',
      code: 'KLAYOUT_GDSII_MASK_GEOMETRY',
      toolchain: status.toolchain,
      renderer: 'Interactive Three.js WebGL exploded layer view and 2D SVG top-down view of polygons extracted from verified GDSII with KLayout',
      message: 'After a completed OpenLane run for generated RTL produces real GDSII, the viewer shows its measured X/Y polygons in an interactive 3D exploded-layer view and a 2D top-down view. Z spacing is expanded for visibility because GDSII does not encode fabricated layer thicknesses. A separately labeled i7-1165G7-inspired educational concept is not Intel design data or a physical-design result.',
      webgpuImplemented: false,
      webglFallbackSupported: true,
      physicalLayoutRenderingImplemented: true,
      physicalLayoutView: '3D exploded view of real GDSII X/Y polygons with nonphysical Z spacing; 2D top-down view also available; not congestion or signoff',
      physicalLayoutExtractor: 'KLayout',
      requiresCompletedGdsiiArtifact: true,
      requiresBrowserWebGpu: false,
      physicalDesignToolchainAvailable: status.available
    });
  });

  app.get('/api/v1/billing', authMiddleware, (req, res) => {
    const config = getPricingConfig();
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const plan = currentPlanForOrganization(snapshot.organization, config);
    const price = serializePricing(config, 'USD').plans.find((item) => item.id === plan.id);
    const subscription = snapshot.organization?.subscriptionRecord || {
      plan: plan.id,
      baseCurrency: config.baseCurrency,
      displayCurrency: 'USD',
      basePrice: plan.price,
      billingInterval: 'month',
      subscriptionStatus: plan.id === 'FREE' ? 'active' : 'inactive',
      subscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      paymentStatus: plan.id === 'FREE' ? 'not_required' : 'unconfigured'
    };
    const complimentaryPreview = subscription.complimentaryPreview === true;
    const accountPrice = complimentaryPreview && price
      ? { ...price, listPrice: price.basePrice, basePrice: 0, displayPrice: 0 }
      : price;
    res.json({
      plan: plan.id,
      planDetails: plan,
      subscription: {
        ...subscription,
        basePrice: complimentaryPreview ? 0 : plan.price,
        listPrice: complimentaryPreview ? plan.price : undefined,
        baseCurrency: config.baseCurrency
      },
      price: accountPrice,
      billingHistory: snapshot.organization?.billingHistory || [],
      paymentProvider: 'unconfigured',
      paymentAvailable: false,
      complimentaryPreview,
      message: complimentaryPreview
        ? 'Ultra Enterprise is enabled as a complimentary local preview. No paid subscription exists, no payment was taken, and no renewal is scheduled.'
        : 'Plan display and usage limits are active. No payment provider is connected, so no subscription can be charged or changed.'
    });
  });

  app.get('/api/v1/usage', authMiddleware, (req, res) => {
    const snapshot = getUsageSnapshot(req.user.organizationId);
    const config = getPricingConfig();
    const plan = currentPlanForOrganization(snapshot.organization, config);
    const aiProviderConfigured = getAiProviderStatus().configured;
    const meters = [
      { id: 'projects', label: 'Projects', used: snapshot.usage.projects, limit: plan.limits.projects, enabled: true },
      { id: 'compilerJobsMonthly', label: 'Compiler jobs this month', used: snapshot.usage.compilerJobsThisMonth, limit: plan.limits.compilerJobsMonthly, enabled: plan.features.auraIrCompiler },
      { id: 'storageBytes', label: 'Project and artifact storage', used: snapshot.usage.storageBytes, limit: plan.limits.storageBytes, enabled: true },
      {
        id: 'aiRequestsMonthly',
        label: 'AI hardware requests',
        used: snapshot.usage.aiRequestsThisMonth,
        limit: plan.limits.aiRequestsMonthly,
        enabled: plan.features.aiHardwareEngineer,
        providerConfigured: aiProviderConfigured
      },
      {
        id: 'simulationJobsMonthly',
        label: 'Simulation jobs',
        used: snapshot.usage.simulationJobsThisMonth,
        limit: plan.limits.simulationJobsMonthly,
        enabled: plan.features.simulation,
        simulatorAvailable: getSimulationStatus().available
      }
    ].map((meter) => ({
      ...meter,
      percent: meter.limit > 0 ? Math.min(100, Math.round((meter.used / meter.limit) * 100)) : 0
    }));
    res.json({ ...snapshot, limits: plan.limits, features: plan.features, meters });
  });

  app.get('/api/v1/settings', authMiddleware, (req, res) => {
    const state = readStore();
    res.json({
      userId: req.user.id,
      organizationId: req.user.organizationId,
      appVersion: state.system.version,
      workspace: { theme: 'dark', panels: ['project', 'inspector', 'console'] },
      integrations: {
        googleOAuthImplemented: true,
        githubOAuthImplemented: true,
        samlImplemented: false,
        stripeImplemented: false
      }
    });
  });

  app.get('/api/v1/audit', authMiddleware, (req, res) => {
    const logs = getAuditLog(req.user.organizationId);
    res.json({ logs });
  });

  app.post('/api/v1/onboarding', authMiddleware, (req, res) => {
    const payload = req.body || {};
    const result = upsertOnboarding(req.user.id, payload);
    res.json({ onboarding: result });
  });

  app.get('/api/v1/onboarding', authMiddleware, (req, res) => {
    const state = getOnboarding(req.user.id);
    res.json({ onboarding: state });
  });

  app.get('/login', (_req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.get('/auth/callback', (_req, res) => {
    res.sendFile(path.join(publicDir, 'auth-callback.html'));
  });

  app.get('/signup', (_req, res) => {
    res.sendFile(path.join(publicDir, 'signup.html'));
  });

  app.get('/onboarding', (_req, res) => {
    res.sendFile(path.join(publicDir, 'onboarding.html'));
  });

  app.get('/workspace', (_req, res) => {
    res.sendFile(path.join(publicDir, 'workspace.html'));
  });

  app.get('/visualizer', (_req, res) => {
    res.sendFile(path.join(publicDir, 'visualizer.html'));
  });

  app.get('/download', (_req, res) => {
    res.sendFile(path.join(publicDir, 'download.html'));
  });

  app.get('/pricing', (_req, res) => {
    res.sendFile(path.join(publicDir, 'pricing.html'));
  });

  app.get('/checkout', (_req, res) => {
    res.sendFile(path.join(publicDir, 'checkout.html'));
  });

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return apiError(res, 'ROUTE_NOT_FOUND', 'API route not found', {}, 404);
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
      return apiError(res, 'REQUEST_TOO_LARGE', 'Request body exceeds the 2 MB limit', {}, 413);
    }
    if (error.type === 'entity.parse.failed') {
      return apiError(res, 'INVALID_JSON', 'Request body must contain valid JSON', {}, 400);
    }
    return apiError(res, 'INTERNAL_ERROR', 'An unexpected server error occurred', {}, 500);
  });

  return app;
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const app = createApp();
  const choosePortAutomatically = process.env.PORT === undefined;
  let selectedPort = port;
  const server = app.listen(selectedPort, () => {
    console.log(`AURA SILICON server listening on http://localhost:${selectedPort}`);
  });
  server.on('error', (error) => {
    if (choosePortAutomatically && error.code === 'EADDRINUSE' && selectedPort < 3100) {
      selectedPort += 1;
      server.listen(selectedPort, () => {
        console.log(`AURA SILICON server listening on http://localhost:${selectedPort}`);
      });
      return;
    }
    console.error(`AURA SILICON could not listen on port ${selectedPort}: ${error.message}`);
    process.exitCode = 1;
  });
  return server;
}
