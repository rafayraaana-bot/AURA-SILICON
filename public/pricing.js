const featureLabels = {
  rtlEditor: 'RTL source editor',
  auraIrCompiler: 'AURA IR subset compiler',
  projectFolderImport: 'Protected hardware-project import',
  aiHardwareEngineer: 'AI hardware engineer',
  architectureGeneration: 'Processor architecture generation',
  simulation: 'Simulation jobs',
  synthesis: 'Synthesis jobs',
  netlistInspection: 'Netlist inspection',
  physicalDesign: 'Physical-design jobs',
  gdsii: 'GDSII generation',
  webgpuVisualization: 'WebGPU chip visualization',
  teamCollaboration: 'Team collaboration',
  priorityJobs: 'Priority job execution',
  prioritySupport: 'Priority support',
  enterpriseAccessControls: 'Enterprise access controls'
};

const planSummaries = {
  FREE: 'Starter access with monthly project, compile, AI, and simulation limits. Synthesis and physical-design jobs are not included.',
  PRO: 'Full standard design workflow with 70 AI hardware requests each month and higher project, compile, and simulation limits.',
  ULTRA_ENTERPRISE: 'All currently implemented workflow capabilities with the highest configured usage limits. Features not yet implemented are not included.'
};

const formatPrice = (amount, currency) => new Intl.NumberFormat(
  currency === 'PKR' ? 'en-PK' : 'en-US',
  { style: 'currency', currency, maximumFractionDigits: 0 }
).format(amount);

const formatStorage = (bytes) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
  return `${bytes.toLocaleString()} bytes`;
};

document.addEventListener('DOMContentLoaded', () => {
  const cards = document.getElementById('pricing-cards');
  if (!cards) return;
  const message = document.getElementById('pricing-message');
  let selectedCurrency = 'USD';

  const render = async (currency) => {
    selectedCurrency = currency;
    for (const button of document.querySelectorAll('[data-currency]')) {
      const selected = button.dataset.currency === currency;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    cards.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Loading current plan configuration…' }));
    message.textContent = '';
    try {
      const response = await fetch(`/api/v1/pricing?currency=${encodeURIComponent(currency)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `Plan configuration request failed (${response.status})`);
      cards.replaceChildren();
      for (const plan of payload.plans) {
        const card = document.createElement('article');
        card.className = `card price-card${plan.id === 'PRO' ? ' featured' : ''}`;
        const name = document.createElement('div');
        name.className = 'plan-name';
        name.textContent = plan.name;
        const summary = document.createElement('p');
        summary.className = 'plan-summary';
        summary.textContent = planSummaries[plan.id] || '';
        const price = document.createElement('div');
        price.className = 'price';
        price.textContent = plan.displayPrice === null ? 'Rate unavailable' : formatPrice(plan.displayPrice, currency);
        const interval = document.createElement('span');
        interval.className = 'price-period';
        interval.textContent = plan.interval === 'month' ? '/ month' : '';
        price.append(interval);
        const basePrice = document.createElement('p');
        basePrice.className = 'base-price-note';
        basePrice.textContent = currency === 'PKR'
          ? `Billing base: ${formatPrice(plan.basePrice, 'USD')} · USD`
          : 'Subscription base currency: USD';
        const list = document.createElement('ul');
        list.className = 'clean-list plan-features';
        const featureRows = Object.entries(plan.features)
          .filter(([, enabled]) => enabled)
          .filter(([key]) => key !== 'aiHardwareEngineer' || payload.aiProviderAvailable)
          .filter(([key]) => key !== 'simulation' || payload.simulationAvailable)
          .map(([key]) => featureLabels[key] || key);
        const limitRows = [
          `${plan.limits.projects.toLocaleString()} projects`,
          `${plan.limits.compilerJobsMonthly.toLocaleString()} compiler jobs / month`,
          `${formatStorage(plan.limits.storageBytes)} storage`,
          plan.features.aiHardwareEngineer && payload.aiProviderAvailable
            ? `${plan.limits.aiRequestsMonthly.toLocaleString()} AI requests / month`
            : plan.features.aiHardwareEngineer ? 'AI requests require the server administrator to configure a provider' : 'AI hardware agent not available in this release',
          plan.features.simulation && payload.simulationAvailable
            ? `${plan.limits.simulationJobsMonthly.toLocaleString()} simulations / month`
            : plan.features.simulation ? 'Simulation requires Icarus Verilog configured on the server' : 'Simulation not available in this release'
        ];
        for (const text of [...featureRows, ...limitRows]) {
          const item = document.createElement('li');
          item.textContent = text;
          list.append(item);
        }
        const action = document.createElement('a');
        action.className = `button ${plan.id === 'PRO' ? 'primary' : 'secondary'} plan-action`;
        action.href = plan.id === 'FREE'
          ? '/signup'
          : `/checkout?plan=${encodeURIComponent(plan.id)}&currency=${encodeURIComponent(currency)}`;
        action.textContent = plan.id === 'FREE' ? 'Get Started' : 'Subscribe';
        if (plan.displayPrice === null) {
          action.setAttribute('aria-disabled', 'true');
          action.title = 'Set the display currency exchange rate in backend administration before continuing.';
        }
        card.append(name, summary, price, basePrice, list, action);
        cards.append(card);
      }
      if (payload.message) message.textContent = payload.message;
      else if (!payload.paymentAvailable) message.textContent = 'Plan prices and limits are configured by AURA backend administration. Payment processing is not configured; subscribe actions open a non-purchasing checkout preview.';
    } catch (error) {
      cards.replaceChildren();
      message.textContent = `Could not load current plan configuration: ${error.message}`;
    }
  };

  document.querySelectorAll('[data-currency]').forEach((button) => {
    button.addEventListener('click', () => render(button.dataset.currency));
  });
  render(selectedCurrency);
});
