require('dotenv').config();
const pool = require('./src/config/db');
const nowPayments = require('./src/services/nowPayments');

(async () => {
  const { rows } = await pool.query(
    `SELECT id, user_id, amount, asset_code, currency_code, network, deposit_address,
            provider, provider_payment_id, status, credited_at, created_at, updated_at
     FROM deposits ORDER BY id DESC LIMIT 6`
  );
  for (const d of rows) {
    console.log(`\ndeposit #${d.id}  ${d.amount} ${d.currency_code}  asset=${d.asset_code} network=${d.network}`);
    console.log(`  status=${d.status}  provider=${d.provider}  providerPaymentId=${d.provider_payment_id}`);
    console.log(`  address=${d.deposit_address}`);
    console.log(`  created=${d.created_at}  updated=${d.updated_at}  credited=${d.credited_at || '-'}`);
    if (d.provider_payment_id && d.provider === 'nowpayments') {
      try {
        const p = await nowPayments.getPaymentStatus(d.provider_payment_id);
        console.log(`  PROVIDER SAYS: status=${p.payment_status} actually_paid=${p.actually_paid} pay_amount=${p.pay_amount} price_amount=${p.price_amount}`);
      } catch (e) {
        console.log(`  PROVIDER LOOKUP FAILED: ${e.message}`);
      }
    }
  }
  await pool.end();
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
