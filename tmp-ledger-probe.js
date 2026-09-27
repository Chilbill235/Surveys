require('dotenv').config();
const pool = require('./src/config/db');
(async () => {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'balance_transactions' ORDER BY ordinal_position`
  );
  console.log('=== balance_transactions columns ===');
  console.log('  ' + cols.rows.map((r) => `${r.column_name} ${r.data_type}`).join(', '));

  const rows = await pool.query(
    `SELECT * FROM balance_transactions ORDER BY id DESC LIMIT 12`
  );
  console.log('\n=== recent balance_transactions ===');
  for (const r of rows.rows) console.log('  ' + JSON.stringify(r));

  const u = await pool.query(`SELECT id, email, balance, demo_balance FROM users ORDER BY id LIMIT 5`);
  console.log('\n=== users ===');
  for (const r of u.rows) console.log(`  id=${r.id} balance=${r.balance} demo=${r.demo_balance}`);

  const ev = await pool.query(
    `SELECT provider, event_id, created_at FROM payment_provider_events ORDER BY created_at DESC LIMIT 10`
  );
  console.log('\n=== payment_provider_events ===');
  for (const r of ev.rows) console.log(`  ${r.provider} ${r.event_id} @ ${r.created_at}`);
  await pool.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
