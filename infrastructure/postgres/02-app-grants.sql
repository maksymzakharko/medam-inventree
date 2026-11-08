-- Run after every application migration as the app-db administrator.
\connect medam_app
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medam_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO medam_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON application_audit_events FROM medam_runtime;
