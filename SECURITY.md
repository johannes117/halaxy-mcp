# Security policy

## Reporting a vulnerability

Please report security issues privately using GitHub's **"Report a vulnerability"** button
(Security → Advisories) on this repository. Do not open a public issue for a vulnerability.

We aim to acknowledge reports within 5 working days.

## Never include patient data

**Do not put protected health information (PHI) in issues, pull requests, discussions,
logs or screenshots** — no names, dates of birth, Medicare numbers, contact details,
referral contents or Halaxy record ids tied to real people. Reproduce problems with
obviously synthetic data (e.g. "Test Patient", DOB 2000-01-01). Never share your Halaxy
client secret; if you think it has leaked, revoke the key in Halaxy → Settings →
Integrations and run `halaxy-mcp setup` with a new one.

## Design summary

- Runs locally over stdio only; makes network calls only to the configured Halaxy base URL. No telemetry.
- API credentials are stored only in the OS keychain. Access tokens are held in memory only.
- No patient data is written to disk or cached between tool calls. The audit log holds ids and outcomes only.
- Every write is prepared, previewed and committed with a single-use confirmation id that expires after 10 minutes.
- Attachments are read only from the configured folder, with real-path (symlink) checks.
- Releases are published only from tags on `main` via GitHub Actions with npm provenance.
