require('dotenv').config();
const pool = require('./src/config/db');

(async () => {
  const tables = ['users', 'deposits', 'withdrawals', 'balance_transactions', 'clicks', 'offers'];
  for (const t of tables) {
    const cols = await pool.query(
      `SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [t]
    );
    console.log(`\n=== ${t} columns ===`);
    for (const c of cols.rows) {
      console.log(`  ${c.column_name} ${c.data_type}${c.numeric_precision ? `(${c.numeric_precision},${c.numeric_scale})` : ''} null=${c.is_nullable} default=${c.column_default}`);
    }
    const cons = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
      [t]
    );
    console.log(`  -- constraints (${cons.rows.length}) --`);
    for (const c of cons.rows) console.log(`  ${c.conname}: ${c.def}`);
    const idx = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
      [t]
    );
    console.log(`  -- indexes (${idx.rows.length}) --`);
    for (const i of idx.rows) console.log(`  ${i.indexname}: ${i.indexdef}`);
  }
  await pool.end();
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
