\getenv owner_password INVENTREE_OWNER_PASSWORD
SELECT format('CREATE ROLE inventree LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'owner_password') \gexec
CREATE DATABASE inventree OWNER inventree;
REVOKE ALL ON DATABASE inventree FROM PUBLIC;
\connect inventree
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO inventree;
