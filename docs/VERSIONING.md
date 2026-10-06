# Versioning policy

- `VERSION` at the repo root is the single source of truth for the repo
  version. Keep `package.json` `version` in sync.
- **`main` is PR-only**: no direct pushes.
- **Every PR must bump `VERSION`** using semver:
  - bug fix → patch (`1.0.0` → `1.0.1`)
  - new skill or feature → minor (`1.0.0` → `1.1.0`)
  - breaking change (skill renamed/removed, install contract changed) → major
    (`1.0.0` → `2.0.0`)
- The PR must also add a matching `## <new-version>` section at the top of
  `CHANGELOG.md`. CI (`version-bump.yml`) fails otherwise.
- Per-skill versions (in each skill's frontmatter/README) are independent of
  the repo `VERSION`; the repo version tracks the collection as a whole.