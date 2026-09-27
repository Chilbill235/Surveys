require('dotenv').config();
const pool = require('./src/config/db');

(async () => {
  const q = (label, sql) =>
    pool.query(sql).then((r) => {
      console.log(`\n=== ${label} ===`);
      if (!r.rows.length) console.log('  (none)');
      for (const row of r.rows) console.log('  ' + JSON.stringify(row));
      return r.rows;
    });

  await q('deposits', `
    SELECT id, user_id, amount, asset_code, status, credited_at FROM deposits ORDER BY id`);

  await q('is_demo flags', `
    SELECT transaction_type, is_demo, COUNT(*)::INT AS n, SUM(amount) AS total
    FROM balance_transactions GROUP BY 1, 2 ORDER BY 1, 2`);

  await q('cash ledger vs balance', `
    SELECT u.id, u.balance, COALESCE(c.total, 0) AS cash_ledger, u.balance - COALESCE(c.total, 0) AS diff
    FROM users u
    LEFT JOIN (
      SELECT user_id, SUM(amount) AS total FROM balance_transactions WHERE NOT is_demo GROUP BY user_id
    ) c ON c.user_id = u.id
    WHERE u.balance <> COALESCE(c.total, 0)
    ORDER BY u.id`);

  await q('confirmed deposits visible to reconciliation', `
    SELECT id, status, credited_at FROM deposits
    WHERE provider_payment_id IS NOT NULL AND credited_at IS NULL AND status IN ('pending','confirming')
    ORDER BY id`);

  await pool.end();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
