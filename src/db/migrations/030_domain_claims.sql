-- A customer proves a site is theirs before Toran takes it as their store (src/domainProof.ts, the audit's PRA-SEC-003):
-- /start keeps a claim with a random token, proven when a DNS TXT record or a meta tag on the home page carries it.
-- One claim per workspace and domain; proven_at and how (dns | meta) once it is.
CREATE TABLE domain_claims (
  id           serial PRIMARY KEY,
  workspace_id integer NOT NULL,
  domain       text NOT NULL,
  url          text NOT NULL,
  token        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  checked_at   timestamptz,
  proven_at    timestamptz,
  how          text,
  UNIQUE (workspace_id, domain)
);
CREATE INDEX domain_claims_domain ON domain_claims (domain);
