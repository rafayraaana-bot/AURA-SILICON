document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('checkout-status');
  const signIn = document.getElementById('checkout-signin');
  const parameters = new URLSearchParams(window.location.search);
  const planId = parameters.get('plan');
  const displayCurrency = parameters.get('currency') || 'USD';
  const token = window.auraDesktop
    ? await window.auraDesktop.getAuthToken()
    : localStorage.getItem('aura-token');
  if (!planId || !['FREE', 'PRO', 'ULTRA_ENTERPRISE'].includes(planId) || !['USD', 'PKR'].includes(displayCurrency)) {
    status.textContent = 'The requested plan selection is invalid. Return to plans and choose an available option.';
    return;
  }
  if (!token) {
    status.textContent = 'Sign in to review this plan with your AURA account. No subscription is started from this page.';
    signIn.classList.remove('hidden');
    return;
  }
  try {
    const response = await fetch('/api/v1/billing/checkout-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ planId, displayCurrency })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `Checkout preview failed (${response.status})`);
    const checkout = payload.checkout;
    const format = (amount, currency) => amount === null
      ? 'Exchange rate not configured'
      : new Intl.NumberFormat(currency === 'PKR' ? 'en-PK' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
    document.getElementById('checkout-plan').textContent = checkout.planName;
    document.getElementById('checkout-period').textContent = `Billed monthly · ${checkout.billingInterval}`;
    document.getElementById('checkout-account').textContent = checkout.account;
    document.getElementById('checkout-base-price').textContent = `${format(checkout.basePrice, checkout.baseCurrency)} / month`;
    document.getElementById('checkout-display-price').textContent = format(checkout.displayPrice, checkout.displayCurrency);
    document.getElementById('checkout-payment-method').textContent = 'Unavailable — payment provider not configured';
    document.getElementById('checkout-tax').textContent = 'Not calculated — provider unavailable';
    document.getElementById('checkout-total').textContent = format(checkout.total, checkout.displayCurrency);
    status.textContent = payload.message;
  } catch (error) {
    status.textContent = error.message;
    if (/sign in|authentication/i.test(error.message)) signIn.classList.remove('hidden');
  }
});
