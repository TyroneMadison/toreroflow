# @toreroflow/contracts

The shared contracts folder from the workflow split plan (`shared/contracts`
in SPLIT-PLAN.md lives here, as a workspace package). Backend writes it,
frontend only imports it: `import { DraftSchema } from "@toreroflow/contracts"`.

- `src/workflow.ts`: drafts, targets, preflight, override, queue, rollup, templates, platform limits.
- `src/ideas.ts`: monthly report, Trello intake, merged insights, brand kit, Sunra carousel quote, approval links, failed-post retry, assets, repurpose.
- `src/permissions.ts`: roles, bot scopes, full access, who may override preflight.
- `src/index.ts`: every export plus `ENDPOINTS`, the method, path and schemas of each route.
