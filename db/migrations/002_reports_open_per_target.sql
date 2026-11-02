BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_open_per_reporter_target
  ON reports (reporter_id, target_type, target_id)
  WHERE status IN ('open', 'in_review');

COMMIT;
