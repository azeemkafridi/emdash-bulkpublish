# BulkPublish for EmDash

Share EmDash posts to Instagram, X, LinkedIn, TikTok and 11 more networks the
moment you publish them.

## Setup

1. Install the plugin from the EmDash plugin registry and approve its access:
   it reads your published content and talks only to `app.bulkpublish.com`.
2. Open **BulkPublish** in the admin, paste an API key from
   app.bulkpublish.com → Settings → API keys, and save.
3. Tick the channels to share to, adjust the caption (`{title}`, `{excerpt}`,
   `{url}`), and save.

Every published post in the chosen collections is shared once. The **Share to
social** panel in the editor shows the result and can share again.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build        # dist/plugin.mjs + manifest.json
npm run bundle       # registry tarball
```

Publishing: `npx emdash-plugin login <handle>`, set `publisher` in
`emdash-plugin.jsonc` to that account's DID, bump `version`, then
`npx emdash-plugin publish`.
