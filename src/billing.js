import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const featureSchema = z.object({
  rtlEditor: z.boolean(),
  auraIrCompiler: z.boolean(),
  projectFolderImport: z.boolean(),
  aiHardwareEngineer: z.boolean(),
  architectureGeneration: z.boolean(),
  simulation: z.boolean(),
  synthesis: z.boolean(),
  netlistInspection: z.boolean(),
  physicalDesign: z.boolean(),
  gdsii: z.boolean(),
  webgpuVisualization: z.boolean(),
  teamCollaboration: z.boolean(),
  priorityJobs: z.boolean(),
  prioritySupport: z.boolean(),
  enterpriseAccessControls: z.boolean()
}).strict();

const limitsSchema = z.object({
  projects: z.number().int().min(0).max(100000),
  compilerJobsMonthly: z.number().int().min(0).max(10000000),
  storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  aiRequestsMonthly: z.number().int().min(0).max(10000000),
  simulationJobsMonthly: z.number().int().min(0).max(10000000)
}).strict();

export const pricingConfigSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  baseCurrency: z.literal('USD'),
  usdToPkrRate: z.number().positive().max(1000000).nullable(),
  paymentProvider: z.literal('unconfigured'),
  plans: z.array(z.object({
    id: z.enum(['FREE', 'PRO', 'ULTRA_ENTERPRISE']),
    name: z.string().min(1).max(80),
    price: z.number().min(0).max(100000000),
    interval: z.literal('month'),
    limits: limitsSchema,
    features: featureSchema
  }).strict()).length(3)
}).strict().superRefine((config, context) => {
  const ids = config.plans.map((plan) => plan.id);
  for (const required of ['FREE', 'PRO', 'ULTRA_ENTERPRISE']) {
    if (!ids.includes(required)) context.addIssue({ code: 'custom', message: `Missing ${required} plan` });
  }
  if (ids.length !== new Set(ids).size) context.addIssue({ code: 'custom', message: 'Plan IDs must be unique' });
  const implementationSupported = new Set([
    'rtlEditor', 'auraIrCompiler', 'projectFolderImport', 'aiHardwareEngineer', 'simulation',
    'synthesis', 'netlistInspection', 'physicalDesign', 'gdsii'
  ]);
  for (const plan of config.plans) {
    for (const [feature, enabled] of Object.entries(plan.features)) {
      if (enabled && !implementationSupported.has(feature)) {
        context.addIssue({
          code: 'custom',
          path: ['plans', ids.indexOf(plan.id), 'features', feature],
          message: `${feature} cannot be enabled until its product capability is implemented`
        });
      }
    }
  }
});

const baseFeatures = {
  rtlEditor: true,
  auraIrCompiler: true,
  projectFolderImport: true,
  aiHardwareEngineer: false,
  architectureGeneration: false,
  simulation: false,
  synthesis: false,
  netlistInspection: false,
  physicalDesign: false,
  gdsii: false,
  webgpuVisualization: false,
  teamCollaboration: false,
  priorityJobs: false,
  prioritySupport: false,
  enterpriseAccessControls: false
};

const defaults = {
  version: 3,
  baseCurrency: 'USD',
  usdToPkrRate: null,
  paymentProvider: 'unconfigured',
  plans: [
    {
      id: 'FREE',
      name: 'Free',
      price: 0,
      interval: 'month',
      limits: { projects: 10, compilerJobsMonthly: 100, storageBytes: 5 * 1024 ** 3, aiRequestsMonthly: 20, simulationJobsMonthly: 20 },
      features: { ...baseFeatures, aiHardwareEngineer: true, simulation: true }
    },
    {
      id: 'PRO',
      name: 'Professional',
      price: 1500,
      interval: 'month',
      limits: { projects: 100, compilerJobsMonthly: 1000, storageBytes: 50 * 1024 ** 3, aiRequestsMonthly: 70, simulationJobsMonthly: 500 },
      features: { ...baseFeatures, aiHardwareEngineer: true, simulation: true, synthesis: true, netlistInspection: true, physicalDesign: true, gdsii: true }
    },
    {
      id: 'ULTRA_ENTERPRISE',
      name: 'Ultra Enterprise',
      price: 100000,
      interval: 'month',
      limits: { projects: 500, compilerJobsMonthly: 5000, storageBytes: 500 * 1024 ** 3, aiRequestsMonthly: 2000, simulationJobsMonthly: 2000 },
      features: { ...baseFeatures, aiHardwareEngineer: true, simulation: true, synthesis: true, netlistInspection: true, physicalDesign: true, gdsii: true }
    }
  ]
};

const configPath = () => path.resolve(process.env.AURA_DATA_DIR || path.join(process.cwd(), 'data'), 'billing-config.json');

export function getPricingConfig() {
  const filePath = configPath();
  if (!fs.existsSync(filePath)) {
    const validatedDefaults = pricingConfigSchema.parse(defaults);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(validatedDefaults, null, 2), { flag: 'wx' });
    return validatedDefaults;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Billing configuration at ${filePath} could not be read as valid JSON`, { cause: error });
  }
  const hasLegacyWebgpuEntitlement = Array.isArray(parsed?.plans) &&
    parsed.plans.some((plan) => plan.features?.webgpuVisualization === true);
  if (hasLegacyWebgpuEntitlement) {
    parsed.plans = parsed.plans.map((plan) => ({
      ...plan,
      features: { ...plan.features, webgpuVisualization: false }
    }));
  }
  const validated = pricingConfigSchema.safeParse(parsed);
  if (!validated.success) throw new Error(`Billing configuration at ${filePath} is invalid: ${validated.error.message}`);
  let current = validated.data;
  let needsWrite = hasLegacyWebgpuEntitlement;
  if (current.version === 1) {
    current = {
      ...current,
      version: 2,
      plans: current.plans.map((plan) => ({
        ...plan,
        features: {
          ...plan.features,
          synthesis: true,
          netlistInspection: true,
          physicalDesign: true,
          gdsii: true,
          webgpuVisualization: false
        }
      }))
    };
    needsWrite = true;
  }
  if (current.version < 3) {
    current = {
      ...current,
      version: 3,
      plans: current.plans.map((plan) => ({
        ...plan,
        price: plan.id === 'PRO' ? 1500 : plan.id === 'ULTRA_ENTERPRISE' ? 100000 : 0,
        limits: plan.id === 'PRO'
          ? { ...plan.limits, aiRequestsMonthly: 70 }
          : plan.limits,
        features: plan.id === 'FREE'
          ? {
              ...plan.features,
              synthesis: false,
              netlistInspection: false,
              physicalDesign: false,
              gdsii: false
            }
          : plan.id === 'ULTRA_ENTERPRISE'
            ? {
                ...plan.features,
                aiHardwareEngineer: true,
                simulation: true,
                synthesis: true,
                netlistInspection: true,
                physicalDesign: true,
                gdsii: true,
                architectureGeneration: false,
                webgpuVisualization: false,
                teamCollaboration: false,
                priorityJobs: false,
                prioritySupport: false,
                enterpriseAccessControls: false
              }
            : plan.features
      }))
    };
    needsWrite = true;
  }
  const upgraded = pricingConfigSchema.safeParse(current);
  if (!upgraded.success) throw new Error(`Billing configuration at ${filePath} could not be upgraded: ${upgraded.error.message}`);
  if (needsWrite) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(upgraded.data, null, 2));
    fs.renameSync(temporaryPath, filePath);
    return upgraded.data;
  }
  return upgraded.data;
}

export function updatePricingConfig(value) {
  if (value?.version !== 3) return { success: false, error: { formErrors: ['Pricing configuration version 3 is required'] } };
  const validated = pricingConfigSchema.safeParse(value);
  if (!validated.success) return { success: false, error: validated.error.flatten() };
  const filePath = configPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(validated.data, null, 2));
  fs.renameSync(temporaryPath, filePath);
  return { success: true, config: validated.data };
}

export function serializePricing(config, displayCurrency = 'USD') {
  return {
    version: config.version,
    baseCurrency: config.baseCurrency,
    displayCurrency,
    exchangeRate: displayCurrency === 'PKR' ? config.usdToPkrRate : null,
    paymentAvailable: false,
    plans: config.plans.map((plan) => ({
      ...plan,
      basePrice: plan.price,
      baseCurrency: config.baseCurrency,
      displayPrice: displayCurrency === 'USD'
        ? plan.price
        : config.usdToPkrRate === null ? null : Math.round(plan.price * config.usdToPkrRate)
    }))
  };
}

export function findPlan(config, id) {
  return config.plans.find((plan) => plan.id === id) || null;
}

export function currentPlanForOrganization(organization, config) {
  return findPlan(config, organization?.plan || 'FREE') || findPlan(config, 'FREE');
}
