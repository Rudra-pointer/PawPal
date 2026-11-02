// server/src/db/verify.js
// Quick count check — prints the same table as pawpal_03_verify.sql query #4.
import 'dotenv/config';
import { query, pool } from './pool.js';

const { rows } = await query(`
  SELECT 'users'        t, count(*)::int c FROM users
  UNION ALL SELECT 'shelters',   count(*)::int FROM shelters
  UNION ALL SELECT 'pets',       count(*)::int FROM pets
  UNION ALL SELECT 'applications', count(*)::int FROM applications
  UNION ALL SELECT 'pet_photos', count(*)::int FROM pet_photos
  UNION ALL SELECT 'vaccinations', count(*)::int FROM pet_vaccinations
`);

console.log('\n  PawPal DB counts');
console.log('  ' + '─'.repeat(30));
for (const r of rows) {
  console.log(`  ${r.t.padEnd(15)} ${r.c}`);
}

const { rows: species } = await query(
  `SELECT species, status, count(*)::int n FROM pets GROUP BY 1,2 ORDER BY 1,2`
);
console.log('\n  Pets by species/status:');
for (const r of species) {
  console.log(`  ${r.species.padEnd(8)} ${r.status.padEnd(12)} ${r.n}`);
}

await pool.end();

