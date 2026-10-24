# Changelog

All notable changes are documented here. Each release flags any change to write
behaviour or required Halaxy API key permissions under **⚠️ Behaviour changes**.

## [1.0.0] - 2026-10-24

First release.

### ⚠️ Behaviour changes

- Introduces write tools (all two-step prepare → `halaxy_commit`): create/update patient,
  create external referrer, create referral (with attachment), book appointment, cancel appointment.
- `halaxy_prepare_create_medicare_coverage` is **disabled by default** (`enableMedicareCoverage`)
  because the Medicare Coverage payload could not be verified against Halaxy's docs.
- Late cancellations require `cancellationCodes.late` in config.json.
- Required API key permissions: see README → "Halaxy API key".

### Added

- Read tools: search patients, duplicate check, patient summary, practitioners, services,
  available times, appointments, referrers, referrals.
- CLI: `setup`, `doctor`, `version`, `forget`.
- MCP prompts: `ingest_gp_referral`, `ingest_paper_form`, `find_and_offer_times`.
- Audit log (ids and outcomes only) with rotation.
