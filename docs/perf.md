# Pet browse benchmark

Run with `npm run seed:load-test`. The runner sets `NODE_ENV=test`, requires `TEST_DATABASE_URL`, verifies `current_database()` is exactly `pawpal_test` before its first write, and removes only the UUIDs it created.

## Recorded run

- Database: `pawpal_test`
- Temporary pets: 500
- Actual endpoint: `GET /api/pets?pageSize=24&sort=newest`
- Latest verified route timings over seven sequential requests: 65.37, 15.79, 14.19, 13.20, 14.27, 13.17, 13.52 ms
- Latest median route time: 14.19 ms
- Latest `EXPLAIN (ANALYZE, BUFFERS)` query execution: 3.090 ms; planning: 0.964 ms
- Shared buffers: 45 hits, 0 reads; temporary buffers: 0 read/written
- Main plan shape: sequential scan of the 500-row `pets` fixture; nested-loop/hash join to the verified shelter and active owner; materialized filtered CTE with window count; top-N sort for the 24-row page. The test photo table had no benchmark photos, so the planner used a small sequential scan for each lateral photo lookup; it completed within the 3.090 ms total.
- The query completed below the 200 ms threshold. No additional index or migration is justified by this run.
- Cleanup removed only the exact 500 pet UUIDs and their temporary shelter/user. The script verified zero of those pet UUIDs remained.

The first route request includes a cold-path measurement; the remaining requests were between 13.17 and 15.79 ms. These measurements describe the local `pawpal_test` instance and are not a production capacity estimate.
