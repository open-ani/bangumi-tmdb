# bangumi-tmdb

- Use TypeScript; run `pnpm check`, `pnpm test`, and `pnpm validate` before delivery.
- Names are search clues, not identity proof. Never infer season 1 from a bare TV link.
- Do not invent IDs, episode numbers, or missing matches. Leave uncertainty pending.
- Respect `locked: true`; automation reports problems without changing locked records.
- Only trusted default-branch code may run on the self-hosted worker.
- Automated updates may change `data/`, `state/`, and `sources/` only, after validation.
- Scheduled automation is explicitly authorized to commit and push validated changes
  directly to main as openanibot. Never force-push or create an automation branch/PR.
- Community PRs are merged by maintainers; never auto-merge them.
- Keep credentials and machine-specific paths out of tracked files and public logs.
