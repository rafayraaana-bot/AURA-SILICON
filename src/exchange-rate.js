const rateEndpoint = 'https://open.er-api.com/v6/latest/USD';
const refreshIntervalMs = 12 * 60 * 60 * 1000;
const requestTimeoutMs = 5000;
let cachedRate = null;
let pendingRefresh = null;

export async function getUsdToPkrRate(configuredRate = null) {
  if (configuredRate !== null) {
    return { rate: configuredRate, source: 'administrator', updatedAt: null, stale: false, reason: null };
  }
  const now = Date.now();
  if (cachedRate && now - cachedRate.fetchedAt < refreshIntervalMs) {
    return { ...cachedRate, stale: false, reason: null };
  }
  if (!pendingRefresh) {
    pendingRefresh = (async () => {
      const response = await fetch(rateEndpoint, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) throw new Error(`Exchange-rate provider returned HTTP ${response.status}`);
      const payload = await response.json();
      const rate = payload?.rates?.PKR;
      const providerTimestamp = Date.parse(payload?.time_last_update_utc);
      if (payload?.result !== 'success' || payload?.base_code !== 'USD' ||
        !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000 ||
        !Number.isFinite(providerTimestamp)) {
        throw new Error('Exchange-rate provider returned invalid USD/PKR data');
      }
      cachedRate = {
        rate,
        source: 'ExchangeRate-API',
        updatedAt: new Date(providerTimestamp).toISOString(),
        fetchedAt: Date.now()
      };
      return cachedRate;
    })().finally(() => {
      pendingRefresh = null;
    });
  }
  try {
    const result = await pendingRefresh;
    return { ...result, stale: false, reason: null };
  } catch (error) {
    if (cachedRate) {
      return {
        ...cachedRate,
        stale: true,
        reason: `Could not refresh the cached exchange rate: ${error.message}`
      };
    }
    return {
      rate: null,
      source: null,
      updatedAt: null,
      stale: false,
      reason: `Could not load an exchange rate: ${error.message}`
    };
  }
}
