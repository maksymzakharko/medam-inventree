\getenv runtime_password MEDAM_RUNTIME_PASSWORD
\getenv migrator_password MEDAM_MIGRATOR_PASSWORD
SELECT format('CREATE ROLE medam_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE medam_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'runtime_password') \gexec
CREATE DATABASE medam_app OWNER medam_migrator;
REVOKE ALL ON DATABASE medam_app FROM PUBLIC;
GRANT CONNECT ON DATABASE medam_app TO medam_runtime;
\connect medam_app
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO medam_migrator;
GRANT USAGE ON SCHEMA public TO medam_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE medam_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medam_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE medam_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO medam_runtime;
