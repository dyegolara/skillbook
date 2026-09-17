# Domain docs

## Layout: single-context

This repo uses a single `CONTEXT.md` at the root and `docs/adr/` for architecture
decision records. All engineers should read `CONTEXT.md` before starting work.

### Consumer rules

- Read `CONTEXT.md` at the repo root for overall project context
- Architecture decisions are documented in `docs/adr/`
- New ADRs should follow the template in `docs/adr/0001-template.md` (create
  sequentially)
- The `## Agent skills` block in `AGENTS.md` references the skill catalogue