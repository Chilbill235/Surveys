require('dotenv').config();
const pool = require('./src/config/db');
(async () => {
  const c = await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'deposits'::regclass ORDER BY conname`
  );
  console.log('=== deposits constraints ===');
  for (const r of c.rows) console.log(`  ${r.conname}: ${r.def}`);

  const inv = await pool.query(
    `SELECT id, status, credited_at, amount FROM deposits
     WHERE (status = 'confirmed' AND credited_at IS NULL) OR (credited_at IS NOT NULL AND status <> 'confirmed')`
  );
  console.log('\n=== rows where status and credit disagree ===');
  console.log(inv.rows.length ? inv.rows : '  none');

  const led = await pool.query(
    `SELECT source_id, amount, created_at FROM balance_ledger
     WHERE source_id LIKE 'nowpayments:%' ORDER BY created_at DESC LIMIT 10`
  ).catch(() => ({ rows: [] }));
  console.log('\n=== balance_ledger rows crediting a nowpayments deposit ===');
  console.log(led.rows.length ? led.rows : '  none (table name may differ)');

  const tbl = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
  );
  console.log('\n=== tables ===');
  console.log('  ' + tbl.rows.map((r) => r.table_name).join(', '));
  await pool.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
