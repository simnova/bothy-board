-- Proof receipt hash so land cannot point at a mutating report file.

alter table tasks add column if not exists proofs_report_sha256 text;
