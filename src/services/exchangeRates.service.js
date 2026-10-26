const Currency = require('../models/Currency');

// Daily exchange rates from a free, keyless feed (open.er-api.com, "Rates by Exchange Rate API").
// Every currency CareerZ lists gets its USD rate from it, unless the Super Admin fixed a rate by
// hand (rateManual). Missing common currencies are added, so balances in EUR / INR / QAR … convert.
const FEED = 'https://open.er-api.com/v6/latest/USD';
const COMMON = {
  PKR: ['Pakistani Rupee', 'Rs'], USD: ['US Dollar', '$'], EUR: ['Euro', '€'], GBP: ['British Pound', '£'],
  SAR: ['Saudi Riyal', 'SAR'], AED: ['UAE Dirham', 'AED'], INR: ['Indian Rupee', '₹'], QAR: ['Qatari Riyal', 'QAR'],
  OMR: ['Omani Rial', 'OMR'], KWD: ['Kuwaiti Dinar', 'KWD'], CAD: ['Canadian Dollar', 'C$'], AUD: ['Australian Dollar', 'A$']
};
const REFRESH_MS = 12 * 60 * 60 * 1000;
let timer = null;

async function refresh() {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.result !== 'success' || !body.rates?.PKR) throw new Error('Exchange rate feed unavailable.');
  for (const [code, [name, symbol]] of Object.entries(COMMON)) {
    await Currency.updateOne({ code }, { $setOnInsert: { code, name, symbol } }, { upsert: true });
  }
  const currencies = await Currency.find({ rateManual: { $ne: true } }).select('code');
  let updated = 0;
  for (const c of currencies) {
    const perUsd = Number(body.rates[c.code]);
    if (!(perUsd > 0)) continue;
    await Currency.updateOne({ _id: c._id }, { $set: { exchangeRateToUSD: 1 / perUsd, rateUpdatedAt: new Date(), rateSource: 'open.er-api.com' } });
    updated += 1;
  }
  return { updated, feedTime: body.time_last_update_utc };
}

function startExchangeRates() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () => refresh().then((r) => console.log(`[rates] ${r.updated} exchange rates updated (${r.feedTime})`)).catch((e) => console.error('[rates] update failed:', e.message));
  run();
  timer = setInterval(run, REFRESH_MS);
  timer.unref?.();
}

module.exports = { refresh, startExchangeRates, COMMON };
