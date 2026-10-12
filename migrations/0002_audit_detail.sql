-- Review finding B10: the audit row for an irreversible action should say what it touched.
-- JSON with counts and folder names only; never addresses or bodies.
ALTER TABLE audit_log ADD COLUMN detail TEXT;
