import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { getAiProviderStatus } from '../src/ai-agent.js';
import { getSimulationStatus } from '../src/simulation.js';

function withServer(testFn, appOptions) {
  return async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
    const originalDataDir = process.env.AURA_DATA_DIR;
    const providerEnvironment = [
      'AURA_AI_PROVIDER',
      'DEEPSEEK_API_KEY',
      'GROQ_API_KEY',
      'AURA_DEEPSEEK_MODEL',
      'AURA_GROQ_MODEL',
      'AURA_GITHUB_CLIENT_ID',
      'AURA_GITHUB_CLIENT_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'AURA_PUBLIC_URL',
      'AURA_DESKTOP_VERSION',
      'AURA_DESKTOP_GITHUB_REPOSITORY',
      'AURA_WINDOWS_DOWNLOAD_URL',
      'AURA_MACOS_DOWNLOAD_URL',
      'AURA_LINUX_DOWNLOAD_URL',
      'AURA_WINDOWS_INSTALLER_PATH',
      'AURA_MACOS_INSTALLER_PATH',
      'AURA_LINUX_INSTALLER_PATH'
    ];
    const originalProviderEnvironment = Object.fromEntries(
      providerEnvironment.map((key) => [key, process.env[key]])
    );
    for (const key of providerEnvironment) delete process.env[key];
    process.env.AURA_DATA_DIR = dataDir;
    const app = createApp(appOptions);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      await testFn(port);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (originalDataDir === undefined) delete process.env.AURA_DATA_DIR;
      else process.env.AURA_DATA_DIR = originalDataDir;
      for (const key of providerEnvironment) {
        if (originalProviderEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = originalProviderEnvironment[key];
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test('health endpoint returns service status', withServer(async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, 'AURA SILICON API');
  const missingRoute = await fetch(`http://127.0.0.1:${port}/api/v1/not-implemented`);
  assert.equal(missingRoute.status, 404);
  const error = await missingRoute.json();
  assert.equal(error.error.code, 'ROUTE_NOT_FOUND');
  assert.ok(error.error.requestId);
}));

test('provider status explains missing local secrets without exposing secret values', withServer(async (port) => {
  const keys = [
    'AURA_GITHUB_CLIENT_ID',
    'AURA_GITHUB_CLIENT_SECRET',
    'AURA_PUBLIC_URL',
    'AURA_AI_PROVIDER',
    'DEEPSEEK_API_KEY',
    'GROQ_API_KEY'
  ];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AURA_GITHUB_CLIENT_ID = 'test-client-id';
    delete process.env.AURA_GITHUB_CLIENT_SECRET;
    process.env.AURA_PUBLIC_URL = 'http://localhost:3001';
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/providers`);
    const providers = await response.json();
    assert.deepEqual(providers, {
      github: false,
      githubReason: 'Set AURA_GITHUB_CLIENT_SECRET in the local .env file.',
      google: false,
      googleReason: 'Set GOOGLE_CLIENT_ID in the server .env file.',
      emailPassword: true
    });

    delete process.env.AURA_AI_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    const ai = getAiProviderStatus();
    assert.equal(ai.configured, false);
    assert.match(ai.reason, /DEEPSEEK_API_KEY or GROQ_API_KEY/);
    assert.equal(ai.reason.includes('test-client-id'), false);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}));

test('desktop download metadata never advertises an installer that has not been released', withServer(async (port) => {
  const previousInstaller = process.env.AURA_WINDOWS_INSTALLER_PATH;
  const previousVersion = process.env.AURA_DESKTOP_VERSION;
  delete process.env.AURA_WINDOWS_INSTALLER_PATH;
  process.env.AURA_DESKTOP_VERSION = '99.0.0';
  try {
    const metadataResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.available, false);
    assert.match(metadata.message, /has not been published/i);
    assert.deepEqual(Object.keys(metadata.platforms), ['windows', 'macos', 'linux']);
    for (const platform of Object.values(metadata.platforms)) {
      assert.equal(platform.available, false);
      assert.equal(platform.downloadUrl, undefined);
    }

    const downloadResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest/download`);
    assert.equal(downloadResponse.status, 404);
    const error = await downloadResponse.json();
    assert.equal(error.error.code, 'DESKTOP_RELEASE_UNAVAILABLE');

    const pageResponse = await fetch(`http://127.0.0.1:${port}/download`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /Download AURA SILICON/);
    assert.match(page, /id="windows-download-button"/);
    assert.match(page, /id="macos-download-button"/);
    assert.match(page, /id="linux-download-button"/);
    assert.match(page, /macOS 12 or later/);
    assert.match(page, /AppImage/);
  } finally {
    if (previousInstaller === undefined) delete process.env.AURA_WINDOWS_INSTALLER_PATH;
    else process.env.AURA_WINDOWS_INSTALLER_PATH = previousInstaller;
    if (previousVersion === undefined) delete process.env.AURA_DESKTOP_VERSION;
    else process.env.AURA_DESKTOP_VERSION = previousVersion;
  }
}));

test('desktop release metadata exposes only configured HTTPS macOS and Linux releases', withServer(async (port) => {
  const keys = ['AURA_MACOS_DOWNLOAD_URL', 'AURA_LINUX_DOWNLOAD_URL'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AURA_MACOS_DOWNLOAD_URL = 'https://releases.example.test/aura.dmg';
  process.env.AURA_LINUX_DOWNLOAD_URL = 'https://releases.example.test/aura.AppImage';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.platforms.windows.available, false);
    assert.equal(metadata.platforms.macos.available, true);
    assert.equal(metadata.platforms.macos.downloadUrl, 'https://releases.example.test/aura.dmg');
    assert.equal(metadata.platforms.linux.available, true);
    assert.equal(metadata.platforms.linux.downloadUrl, 'https://releases.example.test/aura.AppImage');

    process.env.AURA_LINUX_DOWNLOAD_URL = 'http://untrusted.example.test/aura.AppImage';
    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
    assert.equal(invalidResponse.status, 503);
    assert.equal((await invalidResponse.json()).error.code, 'DESKTOP_RELEASE_INVALID');
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}));

test('desktop release metadata builds versioned cloud links from the configured GitHub repository', withServer(async (port) => {
  process.env.AURA_DESKTOP_GITHUB_REPOSITORY = 'aura-silicon/aura-app';
  process.env.AURA_DESKTOP_VERSION = '1.2.3';
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.version, '1.2.3');
  assert.equal(metadata.platforms.windows.downloadUrl,
    'https://github.com/aura-silicon/aura-app/releases/latest/download/AURA-SILICON-Setup-1.2.3-x64.exe');
  assert.equal(metadata.platforms.macos.downloadUrl,
    'https://github.com/aura-silicon/aura-app/releases/latest/download/AURA-SILICON-1.2.3-universal.dmg');
  assert.equal(metadata.platforms.linux.downloadUrl,
    'https://github.com/aura-silicon/aura-app/releases/latest/download/AURA-SILICON-1.2.3-x64.AppImage');

  const downloadResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest/download`, {
    redirect: 'manual'
  });
  assert.equal(downloadResponse.status, 302);
  assert.equal(downloadResponse.headers.get('location'), metadata.platforms.windows.downloadUrl);

  process.env.AURA_DESKTOP_GITHUB_REPOSITORY = 'invalid owner/repo';
  const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
  assert.equal(invalidResponse.status, 503);
  assert.equal((await invalidResponse.json()).error.code, 'DESKTOP_RELEASE_INVALID');
}));

test('desktop download serves the configured local Windows installer', withServer(async (port) => {
  const installerPath = path.join(process.env.AURA_DATA_DIR, 'AURA-SILICON-Test-x64.exe');
  const installerBytes = Buffer.from('AURA-SILICON-TEST-INSTALLER');
  fs.writeFileSync(installerPath, installerBytes);
  process.env.AURA_WINDOWS_INSTALLER_PATH = installerPath;
  process.env.AURA_DESKTOP_VERSION = '1.0.0';

  const metadataResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.platforms.windows.available, true);
  assert.equal(metadata.platforms.windows.bytes, installerBytes.length);
  assert.equal(metadata.platforms.windows.downloadUrl, '/api/v1/desktop/releases/latest/download');

  const downloadResponse = await fetch(`http://127.0.0.1:${port}${metadata.platforms.windows.downloadUrl}`);
  assert.equal(downloadResponse.status, 200);
  assert.match(downloadResponse.headers.get('content-disposition'), /AURA-SILICON-Setup-1\.0\.0\.exe/);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), installerBytes);
}));

test('desktop downloads serve configured local macOS and Linux installers', withServer(async (port) => {
  const macosBytes = Buffer.from('AURA-SILICON-TEST-DMG');
  const linuxBytes = Buffer.from('AURA-SILICON-TEST-APPIMAGE');
  const macosPath = path.join(process.env.AURA_DATA_DIR, 'AURA-SILICON-Test-universal.dmg');
  const linuxPath = path.join(process.env.AURA_DATA_DIR, 'AURA-SILICON-Test-x64.AppImage');
  fs.writeFileSync(macosPath, macosBytes);
  fs.writeFileSync(linuxPath, linuxBytes);
  process.env.AURA_MACOS_INSTALLER_PATH = macosPath;
  process.env.AURA_LINUX_INSTALLER_PATH = linuxPath;
  process.env.AURA_DESKTOP_VERSION = '1.0.0';

  const metadataResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.platforms.macos.available, true);
  assert.equal(metadata.platforms.macos.bytes, macosBytes.length);
  assert.equal(metadata.platforms.macos.downloadUrl, '/api/v1/desktop/releases/latest/download/macos');
  assert.equal(metadata.platforms.linux.available, true);
  assert.equal(metadata.platforms.linux.bytes, linuxBytes.length);
  assert.equal(metadata.platforms.linux.downloadUrl, '/api/v1/desktop/releases/latest/download/linux');

  for (const [platform, expectedFilename, expectedBytes] of [
    ['macos', 'AURA-SILICON-1.0.0-universal.dmg', macosBytes],
    ['linux', 'AURA-SILICON-1.0.0-x64.AppImage', linuxBytes]
  ]) {
    const downloadResponse = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/releases/latest/download/${platform}`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get('content-disposition'), new RegExp(expectedFilename.replaceAll('.', '\\.')));
    assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), expectedBytes);
  }
}));

test('pricing uses server configuration, admin controls the PKR rate, and checkout never fakes a charge', withServer(async (port) => {
  const previousAdminEmail = process.env.AURA_ADMIN_EMAIL;
  const originalFetch = globalThis.fetch;
  const email = `aura.admin.${randomUUID()}@example.com`;
  process.env.AURA_ADMIN_EMAIL = email;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://open.er-api.com/v6/latest/USD') {
      return new Response(JSON.stringify({
        result: 'success',
        base_code: 'USD',
        time_last_update_utc: 'Thu, 01 Oct 2026 00:02:31 +0000',
        rates: { PKR: 278.5 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, options);
  };
  try {
    const pricingResponse = await fetch(`http://127.0.0.1:${port}/api/v1/pricing?currency=USD`);
    assert.equal(pricingResponse.status, 200);
    const pricing = await pricingResponse.json();
    assert.equal(pricing.baseCurrency, 'USD');
    assert.equal(pricing.plans.find((plan) => plan.id === 'PRO').basePrice, 1500);
    assert.equal(pricing.plans.find((plan) => plan.id === 'PRO').limits.aiRequestsMonthly, 70);
    assert.equal(pricing.plans.find((plan) => plan.id === 'FREE').features.physicalDesign, false);
    assert.equal(pricing.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE').basePrice, 100000);
    assert.equal(pricing.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE').features.physicalDesign, true);
    assert.equal(pricing.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE').features.teamCollaboration, false);
    assert.equal(pricing.plans.find((plan) => plan.id === 'PRO').features.webgpuVisualization, false);

    const pkrResponse = await fetch(`http://127.0.0.1:${port}/api/v1/pricing?currency=PKR`);
    const pkr = await pkrResponse.json();
    assert.equal(pkr.plans.find((plan) => plan.id === 'PRO').displayPrice, 417750);
    assert.equal(pkr.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE').displayPrice, 27850000);
    assert.equal(pkr.exchangeRate, 278.5);
    assert.equal(pkr.exchangeRateSource, 'ExchangeRate-API');

    const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pricing Admin', email, password: 'StrongPass123', confirmPassword: 'StrongPass123' })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const configResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/pricing`, { headers });
    assert.equal(configResponse.status, 200);
    const config = (await configResponse.json()).config;
    assert.equal(config.plans.find((plan) => plan.id === 'PRO').features.webgpuVisualization, false);
    const unsupportedConfig = structuredClone(config);
    unsupportedConfig.plans.find((plan) => plan.id === 'PRO').features.teamCollaboration = true;
    const unsupportedUpdate = await fetch(`http://127.0.0.1:${port}/api/v1/admin/pricing`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(unsupportedConfig)
    });
    assert.equal(unsupportedUpdate.status, 400);
    const unimplementedVisualizationConfig = structuredClone(config);
    unimplementedVisualizationConfig.plans.find((plan) => plan.id === 'PRO').features.webgpuVisualization = true;
    const visualizationUpdate = await fetch(`http://127.0.0.1:${port}/api/v1/admin/pricing`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(unimplementedVisualizationConfig)
    });
    assert.equal(visualizationUpdate.status, 400);
    config.usdToPkrRate = 280;
    config.plans.find((plan) => plan.id === 'FREE').limits.projects = 0;
    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/pricing`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(config)
    });
    assert.equal(updateResponse.status, 200);
    const converted = await fetch(`http://127.0.0.1:${port}/api/v1/pricing?currency=PKR`);
    const convertedPricing = await converted.json();
    assert.equal(convertedPricing.exchangeRate, 280);
    assert.equal(convertedPricing.plans.find((plan) => plan.id === 'PRO').displayPrice, 420000);

    const usage = await fetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
    const usageBody = await usage.json();
    assert.ok(Array.isArray(usageBody.meters));
    assert.equal(usageBody.meters.find((meter) => meter.id === 'projects').limit, 0);
    const createProject = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Over project limit' })
    });
    assert.equal(createProject.status, 429);
    const limitError = await createProject.json();
    assert.equal(limitError.error.code, 'USAGE_LIMIT_REACHED');

    const preview = await fetch(`http://127.0.0.1:${port}/api/v1/billing/checkout-preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ planId: 'PRO', displayCurrency: 'PKR' })
    });
    const previewBody = await preview.json();
    assert.equal(previewBody.checkout.baseCurrency, 'USD');
    assert.equal(previewBody.checkout.basePrice, 1500);
    assert.equal(previewBody.checkout.displayPrice, 420000);
    assert.equal(previewBody.checkout.paymentAvailable, false);
    assert.equal(previewBody.checkout.status, 'PREVIEW_ONLY');

    const chargeAttempt = await fetch(`http://127.0.0.1:${port}/api/v1/billing/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ planId: 'PRO' })
    });
    assert.equal(chargeAttempt.status, 503);
    const bill = await fetch(`http://127.0.0.1:${port}/api/v1/billing`, { headers });
    const billBody = await bill.json();
    assert.equal(billBody.paymentAvailable, false);
    assert.equal(billBody.plan, 'FREE');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousAdminEmail === undefined) delete process.env.AURA_ADMIN_EMAIL;
    else process.env.AURA_ADMIN_EMAIL = previousAdminEmail;
  }
}));

test('physical design queues a real-result-shaped OpenLane job and scopes GDSII artifacts to its organization', withServer(async (port) => {
  const email = `openlane.${randomUUID()}@example.test`;
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'OpenLane Test',
      email,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const { token } = await signup.json();
  const storePath = path.join(process.env.AURA_DATA_DIR, 'aura-store.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const testUser = store.users.find((user) => user.email === email);
  const organization = store.organizations.find((item) => item.id === testUser.organizationId);
  organization.plan = 'PRO';
  organization.subscriptionRecord.plan = 'PRO';
  fs.writeFileSync(storePath, JSON.stringify(store));
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const { project } = await (await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'OpenLane AND gate' })
  })).json();
  const rtl = 'module top(input wire a, input wire b, output wire y); assign y = a & b; endmodule';
  const save = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: 'rtl/top.sv', content: rtl })
  });
  assert.equal(save.status, 200);

  const status = await fetch(`http://127.0.0.1:${port}/api/v1/physical-design/status`, { headers });
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusBody.available, true);
  assert.equal(statusBody.ready, true);
  assert.equal(statusBody.supports.gdsii, true);
  assert.equal(statusBody.supports.webgpuVisualization, false);
  assert.equal(statusBody.supports.webglGdsiiVisualization, true);

  const visualization = await fetch(`http://127.0.0.1:${port}/api/v1/visualization`, { headers });
  const visualizationBody = await visualization.json();
  assert.equal(visualization.status, 200);
  assert.equal(visualizationBody.status, 'VERIFIED_GDSII_LAYOUT_AVAILABLE');
  assert.match(visualizationBody.renderer, /Three\.js WebGL.*polygons extracted from verified GDSII/i);
  assert.equal(visualizationBody.webgpuImplemented, false);
  assert.equal(visualizationBody.webglFallbackSupported, true);
  assert.equal(visualizationBody.physicalLayoutRenderingImplemented, true);
  assert.equal(visualizationBody.physicalLayoutExtractor, 'KLayout');
  assert.match(visualizationBody.message, /After a completed OpenLane run.*real GDSII/i);
  assert.match(visualizationBody.message, /Z spacing is expanded for visibility/i);
  assert.match(visualizationBody.message, /i7-1165G7-inspired educational concept/i);
  assert.match(visualizationBody.message, /not Intel design data/i);

  const visualizerPage = await fetch(`http://127.0.0.1:${port}/visualizer`);
  assert.equal(visualizerPage.status, 200);
  const visualizerHtml = await visualizerPage.text();
  assert.match(visualizerHtml, /Physical Layout Viewer/);
  assert.match(visualizerHtml, /physical-layout-fullscreen/);
  assert.match(visualizerHtml, /physical-layout-reset-view/);
  assert.match(visualizerHtml, /physical-layout-auto-rotate/);
  assert.match(visualizerHtml, /physical-results\.js/);
  assert.match(visualizerHtml, /verified results and labeled concepts/);
  assert.match(visualizerHtml, /View i7-1165G7-inspired concept/);
  assert.match(visualizerHtml, /NOT INTEL GDSII/);
  assert.match(visualizerHtml, /physical-concept-3d/);
  assert.match(visualizerHtml, /physical-concept-reset-view/);
  assert.match(visualizerHtml, /physical-concept-auto-rotate/);
  assert.match(visualizerHtml, /physical-layout-3d/);
  assert.match(visualizerHtml, /3D exploded layers/);
  assert.match(visualizerHtml, /GDSII does not provide the fabricated Z thicknesses/);
  assert.match(visualizerHtml, /physical-results-signin[^>]*hidden/);
  assert.match(visualizerHtml, /Nothing is rendered here until a real result exists/);
  assert.doesNotMatch(visualizerHtml, /soc-3d\.js/);
  const workspaceHtml = await (await fetch(`http://127.0.0.1:${port}/workspace`)).text();
  const workspaceScript = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
  assert.match(workspaceHtml, /href="\/visualizer" title="View physical layout only/);
  assert.match(workspaceHtml, /View physical layout · GDSII required/);
  assert.doesNotMatch(workspaceHtml, /<script type="module" src="\/soc-3d\.js"><\/script>/);
  assert.match(workspaceHtml, /ai-source-consent-help/);
  assert.match(workspaceHtml, /checkbox starts unchecked for every session/i);
  assert.match(workspaceHtml, /also check “I trust the selected or AI-generated HDL/);
  assert.match(workspaceHtml, /Hardware specification and RTL-generation instructions/);
  assert.match(workspaceHtml, /auto-run-physical-design-after-generation/);
  assert.match(workspaceScript, /aiSourceConsent\.focus\(\)/);
  assert.match(workspaceScript, /candidate RTL plus diagnostics/);
  assert.match(workspaceScript, /openViewerWhenReady: true/);
  assert.match(workspaceScript, /physical layout automatically next time/);
  const resultsScript = await fetch(`http://127.0.0.1:${port}/physical-results.js`);
  assert.equal(resultsScript.status, 200);
  assert.match(resultsScript.headers.get('content-type'), /javascript/);
  const rendererModule = await fetch(`http://127.0.0.1:${port}/gds-3d-renderer.js`);
  assert.equal(rendererModule.status, 200);
  const conceptRendererModule = await fetch(`http://127.0.0.1:${port}/i7-concept-renderer.js`);
  assert.equal(conceptRendererModule.status, 200);
  assert.match(conceptRendererModule.headers.get('content-type'), /javascript/);
  const threeModule = await fetch(`http://127.0.0.1:${port}/vendor/three/build/three.module.js`);
  assert.equal(threeModule.status, 200);
  assert.match(threeModule.headers.get('content-type'), /javascript/);

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/physical-design`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ topModule: 'top', consentToExecute: true })
  });
  assert.equal(response.status, 202);
  const { job: acceptedJob } = await response.json();
  assert.equal(acceptedJob.jobType, 'physical_design');
  assert.equal(acceptedJob.topModule, 'top');
  assert.ok(acceptedJob.versionId);

  let finished;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${acceptedJob.id}`, { headers });
    finished = (await result.json()).job;
    if (finished.status === 'completed' || finished.status === 'failed') break;
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.physicalDesign.toolchain, 'OpenLane 2 + SKY130');
  assert.match(finished.physicalDesign.sourceHash, /^[a-f0-9]{64}$/i);
  assert.deepEqual(finished.physicalDesign.artifacts.map((item) => item.type), ['GDSII', 'SYNTHESIZED_NETLIST', 'OPENLANE_METRICS', 'GDSII_LAYOUT_PREVIEW']);
  const jobsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/jobs`, { headers });
  const accountJobs = await jobsResponse.json();
  assert.ok(accountJobs.jobs.some((job) => job.id === finished.id && job.physicalDesign.artifacts.some((artifact) => artifact.type === 'GDSII')));

  const gds = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${finished.physicalDesign.artifacts[0].id}/download`, { headers });
  assert.equal(gds.status, 200);
  assert.equal(gds.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await gds.text(), 'test-gds');
  const previewArtifact = finished.physicalDesign.artifacts.find((item) => item.type === 'GDSII_LAYOUT_PREVIEW');
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${previewArtifact.id}/download`, { headers });
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get('content-type'), /application\/json/);
  assert.equal((await previewResponse.json()).format, 'AURA_GDSII_LAYOUT_PREVIEW');

  const otherSignup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Other Lab',
      email: `other.openlane.${randomUUID()}@example.test`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const other = await otherSignup.json();
  const forbiddenArtifact = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${finished.physicalDesign.artifacts[0].id}/download`, {
    headers: { Authorization: `Bearer ${other.token}` }
  });
  assert.equal(forbiddenArtifact.status, 404);
  const otherJobs = await fetch(`http://127.0.0.1:${port}/api/v1/jobs`, {
    headers: { Authorization: `Bearer ${other.token}` }
  });
  assert.deepEqual((await otherJobs.json()).jobs, []);
}, {
  physicalDesignStatus: async () => ({
    available: true,
    toolchain: 'OpenLane 2 + SKY130',
    version: 'OpenLane v2.test',
    reason: null
  }),
  physicalDesignRunner: async ({ topModule, files }) => {
    assert.equal(topModule, 'top');
    assert.ok(files.some((file) => file.name === 'rtl/top.sv'));
    return {
      artifacts: [
        { name: 'layout.gds', type: 'GDSII', mimeType: 'application/octet-stream', content: Buffer.from('test-gds') },
        { name: 'final-netlist.v', type: 'SYNTHESIZED_NETLIST', mimeType: 'text/plain', content: Buffer.from('module top; endmodule') },
        { name: 'openlane-metrics.json', type: 'OPENLANE_METRICS', mimeType: 'application/json', content: Buffer.from('{"design__instance__count":1}') },
        {
          name: 'layout-preview.json',
          type: 'GDSII_LAYOUT_PREVIEW',
          mimeType: 'application/json',
          content: Buffer.from('{"format":"AURA_GDSII_LAYOUT_PREVIEW","units":"um","topCell":"top","bounds":[0,0,10,10],"polygonCount":1,"truncated":false,"layers":[{"layer":1,"datatype":0,"polygons":[[[1,1],[9,1],[9,9],[1,9]]]}]}')
        }
      ],
      output: 'OpenLane test run'
    };
  }
}));

test('signup creates a new account and JWT', withServer(async (port) => {
  const email = `ada.compiler.${randomUUID()}@example.com`;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Ada Compiler',
      email,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.ok(body.token);
  assert.ok(body.user.id);
  assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
}));

test('limits repeated authentication attempts and returns a standard API error', withServer(async (port) => {
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Rate limit test',
      email: `rate-limit.${randomUUID()}@example.test`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  assert.equal(signup.status, 201);
  const account = await signup.json();

  const successfulLogin = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.user.email, password: 'StrongPass123' })
  });
  assert.equal(successfulLogin.status, 200);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `missing.${attempt}@example.test`, password: 'WrongPass123' })
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'INVALID_CREDENTIALS');
  }

  const limitedLogin = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'another.missing@example.test', password: 'WrongPass123' })
  });
  assert.equal(limitedLogin.status, 429);
  assert.ok(limitedLogin.headers.get('ratelimit'));
  assert.ok(Number(limitedLogin.headers.get('retry-after')) > 0);
  const loginError = await limitedLogin.json();
  assert.equal(loginError.error.code, 'LOGIN_RATE_LIMITED');
  assert.ok(loginError.error.requestId);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Signup ${attempt}`,
        email: `signup.${attempt}.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    assert.equal(response.status, 201);
  }

  const limitedSignup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Signup blocked',
      email: `signup.blocked.${randomUUID()}@example.test`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  assert.equal(limitedSignup.status, 429);
  assert.equal((await limitedSignup.json()).error.code, 'SIGNUP_RATE_LIMITED');
}));

test('an immutable source version is compiled and its real AURA IR artifact can be downloaded', withServer(async (port) => {
  const email = `compiler.user.${randomUUID()}@example.com`;
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Compiler User',
      email,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const signupBody = await signup.json();
  const token = signupBody.token;
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const createProject = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Compiler test design' })
  });
  assert.equal(createProject.status, 201);
  const { project } = await createProject.json();

  const source = `module top(input logic clk, input logic rst, output logic done);
logic state;
assign done = state & clk;
endmodule
`;
  const saveFile = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ name: 'top.sv', content: source })
  });
  assert.equal(saveFile.status, 200);
  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/versions`, {
    method: 'POST',
    headers: authHeaders
  });
  assert.equal(versionResponse.status, 201);
  const { version } = await versionResponse.json();

  await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ name: 'top.sv', content: 'module changed; endmodule' })
  });
  const versionsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/project-versions?projectId=${project.id}`, { headers: authHeaders });
  const { versions } = await versionsResponse.json();
  assert.equal(versions[0].sourceFiles[0].content, source);

  const compile = await fetch(`http://127.0.0.1:${port}/api/v1/compiler/compile`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ title: 'compile immutable snapshot', projectId: project.id, versionId: version.id })
  });

  assert.equal(compile.status, 202);
  const { job: acceptedJob } = await compile.json();
  assert.equal(acceptedJob.versionId, version.id);

  let completedJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${acceptedJob.id}`, { headers: authHeaders });
    completedJob = (await response.json()).job;
    if (completedJob.status === 'completed' || completedJob.status === 'failed') break;
  }
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.versionId, version.id);
  assert.ok(completedJob.designHash);

  const artifactResponse = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${completedJob.artifactIds[0]}/download`, { headers: authHeaders });
  assert.equal(artifactResponse.status, 200);
  const ir = await artifactResponse.json();
  assert.equal(ir.projectVersionId, version.id);
  assert.equal(ir.modules[0].name, 'top');

  const otherSignup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Different Organization',
      email: `other.${randomUUID()}@example.com`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const otherAccount = await otherSignup.json();
  const unauthorizedDownload = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${completedJob.artifactIds[0]}/download`, {
    headers: { Authorization: `Bearer ${otherAccount.token}` }
  });
  assert.equal(unauthorizedDownload.status, 404);
}));

test('unsupported RTL syntax fails with diagnostics and does not create a fake artifact', withServer(async (port) => {
  const email = `invalid.rtl.${randomUUID()}@example.com`;
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RTL Test', email, password: 'StrongPass123', confirmPassword: 'StrongPass123' })
  });
  const { token } = await signup.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const usageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
  const usage = await usageResponse.json();
  const aiMeter = usage.meters.find((meter) => meter.id === 'aiRequestsMonthly');
  assert.equal(aiMeter.enabled, true);
  assert.equal(aiMeter.providerConfigured, false);
  assert.equal(aiMeter.limit, 20);
  assert.equal(aiMeter.used, 0);

  const projectResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Invalid RTL design' })
  });
  const { project } = await projectResponse.json();
  await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: 'bad.sv', content: 'module top; assign missing = ; endmodule' })
  });
  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/versions`, {
    method: 'POST',
    headers
  });
  const { version } = await versionResponse.json();
  const compileResponse = await fetch(`http://127.0.0.1:${port}/api/v1/compiler/compile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'invalid input', projectId: project.id, versionId: version.id })
  });
  const { job } = await compileResponse.json();

  let terminalJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${job.id}`, { headers });
    terminalJob = (await response.json()).job;
    if (terminalJob.status === 'failed' || terminalJob.status === 'completed') break;
  }
  assert.equal(terminalJob.status, 'failed');
  assert.ok(terminalJob.diagnostics.length > 0);
  const artifacts = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts`, { headers });
  assert.deepEqual((await artifacts.json()).artifacts, []);
}));

test('GitHub OAuth validates state, requires a verified email, and creates a normal AURA session', withServer(async (port) => {
  const env = {
    clientId: process.env.AURA_GITHUB_CLIENT_ID,
    clientSecret: process.env.AURA_GITHUB_CLIENT_SECRET,
    publicUrl: process.env.AURA_PUBLIC_URL
  };
  const originalFetch = globalThis.fetch;
  process.env.AURA_GITHUB_CLIENT_ID = 'test-github-client-id';
  process.env.AURA_GITHUB_CLIENT_SECRET = 'test-github-client-secret';
  process.env.AURA_PUBLIC_URL = 'https://aura.example.test';
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      const body = JSON.parse(options.body);
      assert.equal(body.client_secret, 'test-github-client-secret');
      return Response.json({ access_token: 'test-provider-access-token' });
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/user') {
      return Response.json({ id: 24680, login: 'aura-test-user', name: 'AURA Test User' });
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/user/emails') {
      return Response.json([
        { email: 'unverified@example.test', primary: true, verified: false },
        { email: 'aura.github@example.test', primary: true, verified: true }
      ]);
    }
    return originalFetch(input, options);
  };

  try {
    const providersResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/providers`);
    assert.deepEqual(await providersResponse.json(), {
      github: true,
      githubReason: null,
      google: false,
      googleReason: 'Set GOOGLE_CLIENT_ID in the server .env file.',
      emailPassword: true
    });

    const startResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/github`, { redirect: 'manual' });
    assert.equal(startResponse.status, 302);
    const authorizeUrl = new URL(startResponse.headers.get('location'));
    assert.equal(authorizeUrl.hostname, 'github.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-github-client-id');
    const cookie = startResponse.headers.get('set-cookie').split(';', 1)[0];
    const state = authorizeUrl.searchParams.get('state');

    const invalidStateResponse = await originalFetch(
      `http://127.0.0.1:${port}/api/v1/auth/github/callback?code=test-code&state=invalid`,
      { headers: { Cookie: cookie }, redirect: 'manual' }
    );
    assert.equal(invalidStateResponse.headers.get('location'), '/login?auth_error=github_state');

    const validStartResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/github`, { redirect: 'manual' });
    const validAuthorizeUrl = new URL(validStartResponse.headers.get('location'));
    const validCookie = validStartResponse.headers.get('set-cookie').split(';', 1)[0];
    const callbackResponse = await originalFetch(
      `http://127.0.0.1:${port}/api/v1/auth/github/callback?code=test-code&state=${encodeURIComponent(validAuthorizeUrl.searchParams.get('state'))}`,
      { headers: { Cookie: validCookie }, redirect: 'manual' }
    );
    assert.equal(callbackResponse.status, 302);
    const callbackLocation = callbackResponse.headers.get('location');
    assert.match(callbackLocation, /^\/auth\/callback#token=/);
    const sessionToken = new URLSearchParams(callbackLocation.split('#')[1]).get('token');
    const meResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.user.email, 'aura.github@example.test');
    assert.equal(me.user.name, 'AURA Test User');
    assert.equal(me.user.githubId, undefined);

    const passwordLogin = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aura.github@example.test', password: 'StrongPass123' })
    });
    assert.equal(passwordLogin.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (env.clientId === undefined) delete process.env.AURA_GITHUB_CLIENT_ID;
    else process.env.AURA_GITHUB_CLIENT_ID = env.clientId;
    if (env.clientSecret === undefined) delete process.env.AURA_GITHUB_CLIENT_SECRET;
    else process.env.AURA_GITHUB_CLIENT_SECRET = env.clientSecret;
    if (env.publicUrl === undefined) delete process.env.AURA_PUBLIC_URL;
    else process.env.AURA_PUBLIC_URL = env.publicUrl;
  }
}));

test('Google OAuth validates state and verified identity without exposing provider credentials', withServer(async (port) => {
  const env = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    publicUrl: process.env.AURA_PUBLIC_URL
  };
  const originalFetch = globalThis.fetch;
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  process.env.AURA_PUBLIC_URL = 'https://aura.example.test';
  let emailVerified = true;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_id'), 'test-google-client-id');
      assert.equal(body.get('client_secret'), 'test-google-client-secret');
      assert.equal(body.get('redirect_uri'), 'https://aura.example.test/api/v1/auth/google/callback');
      return Response.json({ access_token: 'test-google-access-token' });
    }
    if (url.hostname === 'openidconnect.googleapis.com' && url.pathname === '/v1/userinfo') {
      assert.equal(options.headers.Authorization, 'Bearer test-google-access-token');
      return Response.json({
        sub: 'google-sub-13579',
        email: 'aura.google@example.test',
        email_verified: emailVerified,
        name: 'AURA Google User'
      });
    }
    return originalFetch(input, options);
  };

  try {
    const providersResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/providers`);
    const providers = await providersResponse.json();
    assert.equal(providers.google, true);
    assert.equal(providers.googleReason, null);

    const startResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/google`, { redirect: 'manual' });
    assert.equal(startResponse.status, 302);
    const authorizeUrl = new URL(startResponse.headers.get('location'));
    assert.equal(authorizeUrl.hostname, 'accounts.google.com');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-google-client-id');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://aura.example.test/api/v1/auth/google/callback');
    assert.match(authorizeUrl.searchParams.get('scope'), /openid/);
    const invalidCookie = startResponse.headers.get('set-cookie').split(';', 1)[0];
    const invalidState = await originalFetch(
      `http://127.0.0.1:${port}/api/v1/auth/google/callback?code=test-code&state=invalid`,
      { headers: { Cookie: invalidCookie }, redirect: 'manual' }
    );
    assert.equal(invalidState.headers.get('location'), '/login?auth_error=google_state');

    const unverifiedStart = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/google`, { redirect: 'manual' });
    const unverifiedUrl = new URL(unverifiedStart.headers.get('location'));
    const unverifiedCookie = unverifiedStart.headers.get('set-cookie').split(';', 1)[0];
    emailVerified = false;
    const unverifiedResponse = await originalFetch(
      `http://127.0.0.1:${port}/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(unverifiedUrl.searchParams.get('state'))}`,
      { headers: { Cookie: unverifiedCookie }, redirect: 'manual' }
    );
    assert.equal(unverifiedResponse.headers.get('location'), '/login?auth_error=google_email');
    emailVerified = true;

    const validStart = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/google`, { redirect: 'manual' });
    const validUrl = new URL(validStart.headers.get('location'));
    const validCookie = validStart.headers.get('set-cookie').split(';', 1)[0];
    const callback = await originalFetch(
      `http://127.0.0.1:${port}/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(validUrl.searchParams.get('state'))}`,
      { headers: { Cookie: validCookie }, redirect: 'manual' }
    );
    assert.equal(callback.status, 302);
    const callbackLocation = callback.headers.get('location');
    assert.match(callbackLocation, /^\/auth\/callback#token=/);
    const sessionToken = new URLSearchParams(callbackLocation.split('#')[1]).get('token');
    const meResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.user.email, 'aura.google@example.test');
    assert.equal(me.user.name, 'AURA Google User');
    assert.equal(me.user.googleId, undefined);
    assert.equal(JSON.stringify(providers).includes('test-google-client-secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (env.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = env.clientId;
    if (env.clientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = env.clientSecret;
    if (env.publicUrl === undefined) delete process.env.AURA_PUBLIC_URL;
    else process.env.AURA_PUBLIC_URL = env.publicUrl;
  }
}));

test('AI hardware analysis sends approved RTL only to the configured provider and records measured usage', withServer(async (port) => {
  const env = {
    provider: process.env.AURA_AI_PROVIDER,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    groqKey: process.env.GROQ_API_KEY
  };
  const originalFetch = globalThis.fetch;
  process.env.AURA_AI_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-secret';
  delete process.env.GROQ_API_KEY;
  let providerRequest;
  globalThis.fetch = async (input, options) => {
    if (String(input) === 'https://api.deepseek.com/chat/completions') {
      providerRequest = { headers: options.headers, body: JSON.parse(options.body) };
      return Response.json({ choices: [{ message: { content: 'Analysis: inspect the combinational path. No files were changed.' } }] });
    }
    return originalFetch(input, options);
  };

  try {
    const signup = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AI Test User',
        email: `aura.ai.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const status = await originalFetch(`http://127.0.0.1:${port}/api/v1/ai/status`, { headers });
    const statusBody = await status.json();
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.provider, 'deepseek');
    assert.equal(JSON.stringify(statusBody).includes('test-deepseek-secret'), false);

    const projectResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'AI source project' })
    });
    const { project } = await projectResponse.json();
    const request = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: 'Review this RTL for power optimization opportunities.', consentToSendSource: true })
    });
    assert.equal(request.status, 200);
    const result = await request.json();
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.sourceModified, false);
    assert.match(result.answer, /combinational path/);
    assert.equal(providerRequest.headers.Authorization, 'Bearer test-deepseek-secret');
    assert.match(providerRequest.body.messages[1].content, /module top/);
    assert.equal(JSON.stringify(result).includes('test-deepseek-secret'), false);

    const usageResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
    const usage = await usageResponse.json();
    assert.equal(usage.usage.aiRequestsThisMonth, 1);
    assert.equal(usage.meters.find((meter) => meter.id === 'aiRequestsMonthly').enabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (env.provider === undefined) delete process.env.AURA_AI_PROVIDER;
    else process.env.AURA_AI_PROVIDER = env.provider;
    if (env.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env.deepseekKey;
    if (env.groqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = env.groqKey;
  }
}));

test('AI analysis requires explicit source-sharing consent and an available provider', withServer(async (port) => {
  const env = {
    provider: process.env.AURA_AI_PROVIDER,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    groqKey: process.env.GROQ_API_KEY
  };
  delete process.env.AURA_AI_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AI Consent User',
        email: `aura.consent.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const projectResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Consent project' })
    });
    const { project } = await projectResponse.json();

    const noConsent = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: 'Review the RTL.', consentToSendSource: false })
    });
    assert.equal(noConsent.status, 400);

    const unavailable = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: 'Review the RTL.', consentToSendSource: true })
    });
    assert.equal(unavailable.status, 503);
    const unavailableBody = await unavailable.json();
    assert.match(unavailableBody.error.message, /DEEPSEEK_API_KEY or GROQ_API_KEY/);
  } finally {
    if (env.provider === undefined) delete process.env.AURA_AI_PROVIDER;
    else process.env.AURA_AI_PROVIDER = env.provider;
    if (env.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env.deepseekKey;
    if (env.groqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = env.groqKey;
  }
}));

test('AI writes a self-checking testbench into the project and exposes its runnable module', withServer(async (port) => {
  const env = {
    provider: process.env.AURA_AI_PROVIDER,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    groqKey: process.env.GROQ_API_KEY
  };
  const originalFetch = globalThis.fetch;
  delete process.env.AURA_AI_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const signup = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Testbench Generator User',
        email: `aura.testbench.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const projectResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'AI-generated testbench project' })
    });
    const { project } = await projectResponse.json();
    const source = 'module top(input wire a, input wire b, output wire y); assign y = a & b; endmodule';
    const sourceResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name: 'top.sv', content: source })
    });
    assert.equal(sourceResponse.status, 200);
    const consentResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/testbenches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: 'Test every combination of the AND gate.', consentToSendSource: false })
    });
    assert.equal(consentResponse.status, 400);

    process.env.AURA_AI_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'test-only-provider-key';
    let providerCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}/`)) return originalFetch(url, options);
      providerCalls += 1;
      const providerRequest = JSON.parse(options.body);
      assert.match(providerRequest.messages[1].content, /Test every combination/);
      assert.match(providerRequest.messages[1].content, /module top/);
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              file: 'tb/top_tb.sv',
              content: 'module top_tb; reg a; reg b; wire y; top dut(.a(a), .b(b), .y(y)); initial begin a=0; b=0; #1; if (y !== 0) $fatal(1, "00"); a=1; b=1; #1; if (y !== 1) $fatal(1, "11"); $display("PASS"); $finish; end endmodule'
            })
          }
        }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const generateResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/testbenches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: 'Test every combination of the AND gate.', consentToSendSource: true })
    });
    const generated = await generateResponse.json();
    assert.equal(generateResponse.status, 201, JSON.stringify(generated));
    assert.equal(generated.file.name, 'tb/top_tb.sv');
    assert.equal(generated.file.category, 'testbenches');
    assert.equal(generated.testbenchModules[0].module, 'top_tb');
    assert.match(generated.file.content, /\$fatal/);
    assert.equal(providerCalls, 1);
    const testbenchListResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/simulation/testbenches`, { headers });
    const testbenchList = await testbenchListResponse.json();
    assert.ok(testbenchList.testbenches.some((item) => item.path === 'tb/top_tb.sv' && item.module === 'top_tb'));
  } finally {
    globalThis.fetch = originalFetch;
    if (env.provider === undefined) delete process.env.AURA_AI_PROVIDER;
    else process.env.AURA_AI_PROVIDER = env.provider;
    if (env.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env.deepseekKey;
    if (env.groqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = env.groqKey;
  }
}));

test('AI hardware request creates a new project only after Icarus self-check passes', {
  skip: !getSimulationStatus().available
}, withServer(async (port) => {
  const env = {
    provider: process.env.AURA_AI_PROVIDER,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    groqKey: process.env.GROQ_API_KEY
  };
  const originalFetch = globalThis.fetch;
  delete process.env.AURA_AI_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  const passingDesign = {
    topModule: 'counter',
    rtl: "module counter(input wire clk, input wire reset, output reg [3:0] count); always @(posedge clk or posedge reset) begin if (reset) count <= 4'b0000; else count <= count + 1'b1; end endmodule",
    testbenchModule: 'counter_tb',
    testbench: 'module counter_tb; reg clk=0; always #5 clk=~clk; reg reset; wire [3:0] count; integer errors=0; counter dut(.clk(clk),.reset(reset),.count(count)); task check(input [3:0] expected,input [8*24-1:0] name); begin if(count !== expected) begin errors=errors+1; $display("TEST %0s FAIL expected=%0d got=%0d",name,expected,count); $fatal(1,"counter mismatch"); end else $display("TEST %0s PASS",name); end endtask initial begin reset=1; #1; check(0,"RESET"); reset=0; @(posedge clk); #1; check(1,"INCREMENT"); repeat(14) begin @(posedge clk); #1; end check(15,"BOUNDARY"); @(posedge clk); #1; check(0,"ROLLOVER"); reset=1; #1; check(0,"RESET_AGAIN"); if(errors==0) $display("AURA_ALL_TESTS_PASS"); $finish; end endmodule'
  };
  const failingDesign = {
    ...passingDesign,
    testbench: 'module counter_tb; reg clk=0; always #5 clk=~clk; reg reset; wire [3:0] count; counter dut(.clk(clk),.reset(reset),.count(count)); initial begin reset=1; #1; $fatal(1,"TEST RESET FAIL"); $display("AURA_ALL_TESTS_PASS"); $finish; end endmodule'
  };
  try {
    const signup = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AI RTL Generator User',
        email: `aura.design.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const projectResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Hardware request workspace' })
    });
    const { project } = await projectResponse.json();
    process.env.AURA_AI_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'test-only-provider-key';
    let providerCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}/`)) return originalFetch(url, options);
      providerCalls += 1;
      const providerRequest = JSON.parse(options.body);
      assert.match(providerRequest.messages[1].content, /4-bit counter/);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(providerCalls === 1 ? failingDesign : passingDesign) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const noConsent = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/designs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        request: 'Make a 4-bit counter with reset, rollover and a self-checking testbench.',
        consentToSendSource: false,
        consentToExecute: true
      })
    });
    assert.equal(noConsent.status, 400);
    assert.equal(providerCalls, 0);
    const noExecutionConsent = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/designs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        request: 'Make a 4-bit counter with reset, rollover and a self-checking testbench.',
        consentToSendSource: true,
        consentToExecute: false
      })
    });
    assert.equal(noExecutionConsent.status, 400);
    assert.equal(providerCalls, 0);

    const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/designs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        request: 'Make a 4-bit counter with reset, rollover and a self-checking testbench.',
        consentToSendSource: true,
        consentToExecute: true
      })
    });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    assert.equal(result.repairCount, 1);
    assert.match(result.simulation.output, /AURA_ALL_TESTS_PASS/);
    assert.equal(result.rtl.topModule, 'counter');
    assert.equal(result.testbench.module, 'counter_tb');
    assert.equal(providerCalls, 2);

    const filesResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${result.project.id}`, { headers });
    const files = (await filesResponse.json()).files;
    assert.equal(files.find((file) => file.name === 'top.sv').content, passingDesign.rtl);
    assert.equal(files.find((file) => file.name === 'tb/counter_tb.sv').category, 'testbenches');
    const briefResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${result.project.id}/design-brief`, { headers });
    assert.match((await briefResponse.json()).briefs[0].request, /4-bit counter/);
    const usageResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
    const usage = await usageResponse.json();
    assert.equal(usage.usage.aiRequestsThisMonth, 2);
    assert.equal(usage.usage.simulationJobsThisMonth, 2);
    const benchesResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${result.project.id}/simulation/testbenches`, { headers });
    assert.ok((await benchesResponse.json()).testbenches.some((item) => item.module === 'counter_tb'));
  } finally {
    globalThis.fetch = originalFetch;
    if (env.provider === undefined) delete process.env.AURA_AI_PROVIDER;
    else process.env.AURA_AI_PROVIDER = env.provider;
    if (env.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env.deepseekKey;
    if (env.groqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = env.groqKey;
  }
}));

test('AI auto-fix applies only a compiler-validated repair after explicit consent', withServer(async (port) => {
  const env = {
    provider: process.env.AURA_AI_PROVIDER,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
    groqKey: process.env.GROQ_API_KEY
  };
  const originalFetch = globalThis.fetch;
  delete process.env.AURA_AI_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const signup = await originalFetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AI Repair User',
        email: `aura.repair.${randomUUID()}@example.test`,
        password: 'StrongPass123',
        confirmPassword: 'StrongPass123'
      })
    });
    const { token } = await signup.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const projectResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'AI repair project' })
    });
    const { project } = await projectResponse.json();
    await originalFetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name: 'top.sv', content: 'module top; @; endmodule' })
    });
    const versionResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/versions`, {
      method: 'POST',
      headers
    });
    const { version } = await versionResponse.json();
    const compileResponse = await originalFetch(`http://127.0.0.1:${port}/api/v1/compiler/compile`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Expected RTL compile error', projectId: project.id, versionId: version.id })
    });
    const { job } = await compileResponse.json();
    let failedJob;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await originalFetch(`http://127.0.0.1:${port}/api/v1/jobs/${job.id}`, { headers });
      failedJob = (await response.json()).job;
      if (['completed', 'failed'].includes(failedJob.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(failedJob.status, 'failed');

    process.env.AURA_AI_PROVIDER = 'deepseek';
    process.env.DEEPSEEK_API_KEY = 'test-only-provider-key';
    let providerCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(`http://127.0.0.1:${port}/`)) return originalFetch(url, options);
      providerCalls += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
              content: JSON.stringify({
                file: 'top.sv',
                content: providerCalls === 1
                  ? 'module top; wire x; assign x = missing; endmodule'
                  : 'module top; endmodule'
              })
            }
          }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const noConsent = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/auto-fix`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: failedJob.id, consentToSendSource: false })
    });
    assert.equal(noConsent.status, 400);
    assert.equal(providerCalls, 0);

    const rejectedRepair = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/auto-fix`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: failedJob.id, consentToSendSource: true })
    });
    assert.equal(rejectedRepair.status, 422);
    assert.equal((await rejectedRepair.json()).error.code, 'AUTO_FIX_VALIDATION_FAILED');
    assert.equal(providerCalls, 1);
    const unchangedFiles = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${project.id}`, { headers });
    assert.equal((await unchangedFiles.json()).files.find((file) => file.name === 'top.sv').content, 'module top; @; endmodule');

    const repairResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/ai/auto-fix`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: failedJob.id, consentToSendSource: true })
    });
    const repair = await repairResponse.json();
    assert.equal(repairResponse.status, 200, JSON.stringify(repair));
    assert.equal(repair.file.content, 'module top; endmodule');
    assert.equal(repair.validation, 'AURA_RTL_COMPILER_PASSED');
    assert.equal(providerCalls, 2);

    const filesResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${project.id}`, { headers });
    const files = (await filesResponse.json()).files;
    assert.equal(files.find((file) => file.name === 'top.sv').content, 'module top; endmodule');
    const usageResponse = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
    assert.equal((await usageResponse.json()).usage.aiRequestsThisMonth, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (env.provider === undefined) delete process.env.AURA_AI_PROVIDER;
    else process.env.AURA_AI_PROVIDER = env.provider;
    if (env.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = env.deepseekKey;
    if (env.groqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = env.groqKey;
  }
}));

test('local Icarus simulation executes a selected trusted testbench and meters completed jobs', {
  skip: !getSimulationStatus().available
}, withServer(async (port) => {
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Simulation Test User',
      email: `aura.sim.${randomUUID()}@example.test`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const { token } = await signup.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const createdProject = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Icarus smoke test' })
  });
  const { project } = await createdProject.json();
  const dutSource = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: 'top.sv',
      content: 'module top(input wire a, output wire y); assign y = a; endmodule'
    })
  });
  assert.equal(dutSource.status, 200);
  const testbenchSource = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: 'tb/top_tb.sv',
      content: 'module top_tb; reg a; wire y; top dut(.a(a), .y(y)); initial begin a = 1; #1; if (y !== 1) $fatal(1, "expected y=1"); $display("AURA_SIM_PASS y=%b", y); $finish; end endmodule'
    })
  });
  assert.equal(testbenchSource.status, 200);
  const savedFilesResponse = await fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${project.id}`, { headers });
  const savedFiles = (await savedFilesResponse.json()).files;
  assert.equal(savedFiles.find((file) => file.name === 'tb/top_tb.sv').category, 'testbenches');

  const testbenchesResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/simulation/testbenches`, { headers });
  const testbenches = await testbenchesResponse.json();
  assert.equal(testbenches.available, true);
  assert.ok(testbenches.testbenches.some((item) => item.path === 'tb/top_tb.sv' && item.module === 'top_tb'));

  const simulationResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/simulation/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      testbenchPath: 'tb/top_tb.sv',
      testbenchModule: 'top_tb',
      consentToExecute: true
    })
  });
  const result = await simulationResponse.json();
  assert.equal(simulationResponse.status, 200, JSON.stringify(result));
  assert.equal(result.simulation.status, 'completed');
  assert.match(result.simulation.output, /AURA_SIM_PASS y=1/);
  assert.equal(result.simulation.sourceFiles, 2);

  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/versions`, {
    method: 'POST',
    headers
  });
  assert.equal(versionResponse.status, 201);
  const { version } = await versionResponse.json();
  const compileResponse = await fetch(`http://127.0.0.1:${port}/api/v1/compiler/compile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Compile design with testbench', projectId: project.id, versionId: version.id })
  });
  assert.equal(compileResponse.status, 202);
  const { job } = await compileResponse.json();
  let compileJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${job.id}`, { headers });
    compileJob = (await response.json()).job;
    if (['completed', 'failed'].includes(compileJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(compileJob.status, 'completed', JSON.stringify(compileJob.diagnostics));

  const unsafeTestbench = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/files`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      name: 'tb/top_tb.sv',
      content: 'module top_tb; initial begin $system("whoami"); $finish; end endmodule'
    })
  });
  assert.equal(unsafeTestbench.status, 200);
  const blockedSimulation = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/simulation/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      testbenchPath: 'tb/top_tb.sv',
      testbenchModule: 'top_tb',
      consentToExecute: true
    })
  });
  assert.equal(blockedSimulation.status, 400);
  assert.equal((await blockedSimulation.json()).error.code, 'UNSAFE_SIMULATION_SOURCE');

  const usageResponse = await fetch(`http://127.0.0.1:${port}/api/v1/usage`, { headers });
  const usage = await usageResponse.json();
  assert.equal(usage.usage.simulationJobsThisMonth, 1);
  assert.equal(usage.meters.find((meter) => meter.id === 'simulationJobsMonthly').enabled, true);
}));

test('logout revokes the bearer session', withServer(async (port) => {
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Revocation Test',
      email: `revoke.${randomUUID()}@example.com`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const { token } = await signup.json();
  const headers = { Authorization: `Bearer ${token}` };
  const logout = await fetch(`http://127.0.0.1:${port}/api/v1/auth/logout`, { method: 'POST', headers });
  assert.equal(logout.status, 200);
  const me = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, { headers });
  assert.equal(me.status, 401);
}));

test('folder import scans files, protects original inputs, and starts compilation from its copied workspace', withServer(async (port) => {
  const signup = await fetch(`http://127.0.0.1:${port}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Folder Import Test',
      email: `folder.${randomUUID()}@example.com`,
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123'
    })
  });
  const { token } = await signup.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const source = 'module cpu(input wire data, output wire result); assign result = data; endmodule\n';
  const payload = {
    name: 'processor-source',
    files: [
      { path: 'rtl/cpu.sv', content: source },
      { path: 'tb/cpu_tb.sv', content: 'module cpu_tb; endmodule\n' },
      { path: 'constraints/timing.sdc', content: 'create_clock -period 10 [get_ports clk]\n' },
      { path: 'technology/stdcells.lib', content: 'library(stdcells) {}\n' },
      { path: 'ip/boot.hex', content: '00ff\n' },
      { path: 'config/aura.project.json', content: '{\"top\":\"cpu\"}\n' },
      { path: 'legacy/boot.vhd', content: 'entity boot is end;\n' },
      { path: 'config/.env', content: 'AURA_TEST_SECRET=must-not-be-imported\n' }
    ],
    excludedFiles: [
      { path: 'images/layout.png', code: 'UNSUPPORTED_FILE', message: 'Binary file not imported.' }
    ]
  };
  const traversal = await fetch(`http://127.0.0.1:${port}/api/v1/projects/import/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, files: [{ path: '../secret.sv', content: source }] })
  });
  assert.equal(traversal.status, 400);

  const scanResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/import/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  assert.equal(scanResponse.status, 200);
  const { analysis } = await scanResponse.json();
  assert.equal(analysis.summary.rtlCount, 1);
  assert.equal(analysis.summary.testbenchCount, 1);
  assert.equal(analysis.summary.constraintCount, 1);
  assert.equal(analysis.summary.technologyCount, 1);
  assert.equal(analysis.summary.ipCount, 1);
  assert.equal(analysis.summary.unsupportedHdlCount, 1);
  assert.equal(analysis.detectedTopModule, 'cpu');
  assert.equal(analysis.auraConfigDetected, true);
  assert.ok(analysis.diagnostics.some((item) => item.code === 'SENSITIVE_FILE_EXCLUDED'));
  assert.ok(analysis.diagnostics.some((item) => item.code === 'VHDL_UNSUPPORTED'));
  assert.equal(JSON.stringify(analysis).includes(source), false);

  const aluRtl = fs.readFileSync(path.join(process.cwd(), 'examples', 'alu-128', 'rtl', 'alu_128.sv'), 'utf8');
  const aluTestbench = fs.readFileSync(path.join(process.cwd(), 'examples', 'alu-128', 'tb', 'alu_128_tb.sv'), 'utf8');
  const aluScanResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/import/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'alu-128',
      files: [
        { path: 'rtl/alu_128.sv', content: aluRtl },
        { path: 'tb/alu_128_tb.sv', content: aluTestbench }
      ]
    })
  });
  assert.equal(aluScanResponse.status, 200);
  const { analysis: aluAnalysis } = await aluScanResponse.json();
  assert.equal(aluAnalysis.detectedTopModule, 'alu_128');
  assert.deepEqual(aluAnalysis.dependencies, []);
  assert.deepEqual(aluAnalysis.diagnostics.filter((item) => item.code === 'UNRESOLVED_MODULE'), []);

  const importResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/import`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  assert.equal(importResponse.status, 201);
  const { project } = await importResponse.json();
  assert.equal(project.name, 'processor-source');
  assert.equal(Object.hasOwn(project, 'sourceFiles'), false);
  assert.equal(project.importedProject.sourcePreserved, true);
  assert.equal(project.importedProject.topModule, 'cpu');
  const invalidTop = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/top-module`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ topModule: 'not_a_module' })
  });
  assert.equal(invalidTop.status, 400);
  assert.equal((await invalidTop.json()).error.code, 'TOP_MODULE_NOT_FOUND');

  const sourceResponse = await fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${project.id}`, { headers });
  const { files } = await sourceResponse.json();
  assert.equal(files.find((file) => file.name === 'rtl/cpu.sv').content, source);
  assert.equal(files.find((file) => file.name === 'tb/cpu_tb.sv').category, 'testbenches');
  assert.equal(files.some((file) => file.name === 'config/.env'), false);
  assert.equal(files.find((file) => file.name === 'legacy/boot.vhd').category, 'unsupported-hdl');
  assert.equal(files.some((file) => file.name === 'images/layout.png'), false);

  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/versions`, {
    method: 'POST',
    headers
  });
  const { version } = await versionResponse.json();
  assert.equal(version.topModule, 'cpu');
  assert.equal(version.sourceFiles.length, 7);
  const compileResponse = await fetch(`http://127.0.0.1:${port}/api/v1/compiler/compile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Compile imported CPU', projectId: project.id, versionId: version.id })
  });
  assert.equal(compileResponse.status, 202);
  const { job } = await compileResponse.json();
  let finished;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/${job.id}`, { headers });
    finished = (await result.json()).job;
    if (finished.status === 'completed' || finished.status === 'failed') break;
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished));

  const updatedSource = 'module cpu(input wire data, output wire result); assign result = ~data; endmodule\n';
  const rescanResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/rescan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: payload.name,
      files: payload.files.map((file) => file.path === 'rtl/cpu.sv' ? { ...file, content: updatedSource } : file),
      excludedFiles: payload.excludedFiles
    })
  });
  assert.equal(rescanResponse.status, 200);
  const refreshed = await fetch(`http://127.0.0.1:${port}/api/v1/files?projectId=${project.id}`, { headers });
  assert.equal((await refreshed.json()).files.find((file) => file.name === 'rtl/cpu.sv').content, updatedSource);
  const oldVersion = await fetch(`http://127.0.0.1:${port}/api/v1/project-versions?projectId=${project.id}`, { headers });
  assert.equal((await oldVersion.json()).versions[0].sourceFiles.find((file) => file.name === 'rtl/cpu.sv').content, source);

  const briefResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/design-brief`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ request: 'Analyze this processor for lower power.' })
  });
  assert.equal(briefResponse.status, 200);
  const brief = await briefResponse.json();
  assert.equal(brief.agentStatus, 'UNAVAILABLE');
  assert.match(brief.message, /not sent to AI or executed/);
  const savedBriefs = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${project.id}/design-brief`, { headers });
  assert.equal((await savedBriefs.json()).briefs[0].request, 'Analyze this processor for lower power.');
}));
