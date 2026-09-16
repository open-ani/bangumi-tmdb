# bangumi-tmdb

- Use TypeScript; run `pnpm check`, `pnpm test`, and `pnpm validate` before delivery.
- Names are search clues, not identity proof. Never infer season 1 from a bare TV link.
- Do not invent IDs, episode numbers, or missing matches. Leave uncertainty pending.
- Respect `locked: true`; automation reports problems without changing locked records.
- Only trusted default-branch code may run on the self-hosted worker.
- Automated updates may change `data/`, `state/`, `sources/` and the generated stats block of README.md only, after validation.
- Scheduled runs research only recent or upcoming unmapped subjects; the deep backlog is offline work.
- Episode rules come from air-date agreement or from a model that actually read the TMDB season; never from position.
- Scheduled automation is explicitly authorized to commit and push validated changes
  directly to main as openanibot. Never force-push or create an automation branch/PR.
- Community PRs are merged by maintainers; never auto-merge them.
- Keep credentials and machine-specific paths out of tracked files and public logs.
