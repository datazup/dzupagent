# Repository Analysis Pack

Generated at: 2026-04-21T18:19:52.035Z
Date stamp: 2026_04_21
Dry run: false

## Repository
- Name: dzupagent
- Source: manifest
- Local path: /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent
- Workspace-relative path: dzupagent

## Pack
- Pack name: full
- Output directory: /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/analyze-full_2026_04_21
- Repo-relative output path: docs/analyze-full_2026_04_21
- Prompt library: /media/ninel/Second/code/datazup/ai-internal-dev/scripts/prompts/repo-analysis-pack.prompts.json
- Log file: /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/analyze-full_2026_04_21/codex_out_log.md
- Live search: false
- Quality gate: true
- Min output chars: 1800
- Max quality retries: 2
- Enforce required sections: true
- Min required section chars: 120
- Master summary enabled: true
- Master summary prompt key: 00_master_summary

## Documents
- `00_master_summary.md` — 00 Master Summary
- `01_current_state_inventory.md` — 01 Current State Inventory
- `02_correctness_and_verification.md` — 02 Correctness And Verification
- `03_architecture_review.md` — 03 Architecture Review
- `04_security_review.md` — 04 Security Review
- `05_code_quality_and_maintainability.md` — 05 Code Quality And Maintainability
- `06_performance_and_scalability.md` — 06 Performance And Scalability
- `07_operability_and_release_readiness.md` — 07 Operability And Release Readiness
- `08_product_and_docs_consistency.md` — 08 Product And Docs Consistency
- `09_feature_gap_matrix.md` — 09 Feature Gap Matrix
- `10_external_comparison.md` — 10 External Comparison
- `11_recommendations_and_roadmap.md` — 11 Recommendations And Roadmap
- `12_dependency_and_config_risk.md` — 12 Dependency And Config Risk
- `13_data_model_and_migrations.md` — 13 Data Model And Migrations
- `14_api_surface_and_contracts.md` — 14 API Surface And Contracts
- `15_developer_experience_and_onboarding.md` — 15 Developer Experience And Onboarding

## Expected Evidence Sources
- Local repository code, tests, configs, migrations, and hidden docs such as `.docs/` when present
- Relevant local artifacts under the workspace `out/` tree
- Existing pack-local outputs generated in this directory during the run

## Runner Command
```text
/home/ninel/.nvm/versions/node/v22.17.0/bin/node /media/ninel/Second/code/datazup/ai-internal-dev/scripts/reviews/codex/run-repo-reviews.js --workspace /media/ninel/Second/code/datazup/ai-internal-dev --repos-file /tmp/repo-analysis-pack-u7deCh/target.json --output-dir /media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/analyze-full_2026_04_21 --prompts-file /media/ninel/Second/code/datazup/ai-internal-dev/scripts/prompts/repo-analysis-pack.prompts.json --append-repo-suffix false --skip-existing false --log-file codex_out_log.md --search false --quality-gate true --min-output-chars 1800 --max-quality-retries 2 --enforce-required-sections true --min-required-section-chars 120 --prompt-numbers 2,3,4,5,6,7,8,9,10,11,12,13,14,15,16
```
