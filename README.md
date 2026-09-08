# adma-finance

## Development checks

The production `cloud.js` bundle is generated from feature-owned sources in `src/cloud/`:

```sh
npm run frontend:build
npm run check
npm test
```

Architecture and API contract notes are in `docs/ARCHITECTURE.md`. Do not edit generated `cloud.js` directly.
