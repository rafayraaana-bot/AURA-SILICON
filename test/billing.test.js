import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPricingConfig, serializePricing } from '../src/billing.js';

test('migrates saved pricing to the three-tier USD/PKR plan defaults', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-billing-'));
  const previousDataDir = process.env.AURA_DATA_DIR;
  process.env.AURA_DATA_DIR = dataDir;
  try {
    const initial = getPricingConfig();
    const filePath = path.join(dataDir, 'billing-config.json');
    const legacy = {
      ...initial,
      version: 2,
      usdToPkrRate: 280,
      plans: initial.plans.map((plan) => ({
        ...plan,
        price: plan.id === 'PRO' ? 5000 : plan.id === 'ULTRA_ENTERPRISE' ? 10000 : 0,
        limits: plan.id === 'PRO' ? { ...plan.limits, aiRequestsMonthly: 500 } : plan.limits,
        features: {
          ...plan.features,
          synthesis: true,
          netlistInspection: true,
          physicalDesign: true,
          gdsii: true
        }
      }))
    };
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const upgraded = getPricingConfig();
    const free = upgraded.plans.find((plan) => plan.id === 'FREE');
    const pro = upgraded.plans.find((plan) => plan.id === 'PRO');
    const ultra = upgraded.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE');

    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.usdToPkrRate, 280);
    assert.equal(free.features.physicalDesign, false);
    assert.equal(free.features.gdsii, false);
    assert.equal(pro.price, 1500);
    assert.equal(pro.limits.aiRequestsMonthly, 70);
    assert.equal(pro.features.physicalDesign, true);
    assert.equal(ultra.price, 100000);
    assert.equal(ultra.features.physicalDesign, true);
    assert.equal(ultra.features.teamCollaboration, false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).version, 3);

    const converted = serializePricing(upgraded, 'PKR');
    assert.equal(converted.plans.find((plan) => plan.id === 'PRO').displayPrice, 420000);
    assert.equal(converted.plans.find((plan) => plan.id === 'ULTRA_ENTERPRISE').displayPrice, 28000000);
  } finally {
    if (previousDataDir === undefined) delete process.env.AURA_DATA_DIR;
    else process.env.AURA_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
