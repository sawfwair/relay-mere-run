# Fleet console

`web/src/App.tsx` is the authenticated account fleet console and public node-download landing page. `web/src/types.ts` describes the view model, `web/src/contracts.ts` validates every server payload, `web/src/json.ts` is the only response decoder, and `web/src/format.ts` owns display formatting. `web/vite.config.ts` builds the console into the Worker-served `dist/` directory.

Keep authentication and scheduling decisions on the Worker. The browser may request fleet refreshes, policy changes, and model plans, but it must not recreate eligibility, lease, or account-ownership rules. Add new response fields to the executable contract before consuming them, preserve unknown server fields for forward compatibility, and surface non-2xx errors through `apiRequest`.

Run `corepack pnpm typecheck:web`, `corepack pnpm lint`, and `corepack pnpm build:web` for focused changes; use `corepack pnpm verify:fast` before pushing.
