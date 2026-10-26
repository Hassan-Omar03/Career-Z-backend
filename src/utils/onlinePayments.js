// Card / JazzCash / Safepay / crypto checkouts are switched off while CareerZ runs on manual
// payments (bank transfer + receipts, checked by the CareerZ admin). The gateway code is kept;
// set ONLINE_PAYMENTS_ENABLED=true to turn it back on.
const onlinePaymentsEnabled = () => process.env.ONLINE_PAYMENTS_ENABLED === 'true';
module.exports = { onlinePaymentsEnabled };
