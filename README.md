# BulkPublish for EmDash

Share EmDash posts to your social accounts the moment you publish them.
User-facing listing copy lives in [`listing/`](listing/) and is published with
each release.

## What it does

- `content:afterPublish` shares each post **once** (a claim row in the `shares`
  collection; a claim older than 2 minutes counts as dead and can be retaken).
  Failures are not retried automatically — the editor panel's **Share again**
  forces a new share.
- Publish-now is create-draft → `POST /api/posts/{id}/publish`. A draft whose
  publish is refused is deleted, so a retry never leaves a duplicate behind.
- Channels are filtered before sending, because one invalid destination makes
  the API reject the whole post: inactive / reconnect-needed / unavailable
  channels, video-only networks (TikTok, YouTube), and image-only networks
  (Instagram, Pinterest, Snapchat) when there is no image. Each skip is
  recorded with a reason.
- Featured image: found by the configured field, then common names, then the
  first image-valued field; read with `media.readBytes` (7 MB cap) and sent as
  a hand-built multipart body. Threads gets `postTypeOverrides.threads=image`
  when an image is attached.
- Captions: the API checks the main `content` against EVERY destination's
  limit, even ones with a `platformContent` override. So `content` is the
  version that fits all targets (excerpt dropped first, then the title
  shortened, link kept whole; X/Mastodon count links as 23), and networks with
  room get the full caption in `platformContent`.
- Any failure after an upload deletes the uploaded image, and a refused
  publish deletes its draft.
- The API key is verified with `GET /api/channels` before it is stored.

Capabilities: `content:read`, `media:read`, `media:bytes:read` (required by
`media.readBytes` — `media:read` alone is refused), `network:request` pinned to
`app.bulkpublish.com`. Cloudflare's per-invocation limits (10 subrequests, 50 ms
CPU) are respected: a share makes at most 5 requests.

## Development

```bash
npm install
npm test             # unit + plugin tests against a fake EmDash context
npm run typecheck
npm run build        # dist/plugin.mjs + manifest.json
npm run bundle       # registry tarball
```

`tests/fake-ctx.ts` stands in for the plugin context; its API responses are
the shapes the real BulkPublish API returned on 2026-10-16.

### Live playground

`playground/` (gitignored) is an EmDash blog site that loads this plugin
through the real workerd sandbox:

```bash
npm create emdash@latest playground -- --template node:blog --pm npm --install --yes
cd playground && npm i ../ @emdash-cms/sandbox-workerd workerd
# astro.config.mjs → emdash({ …, sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox", sandboxed: [bulkpublish] })
npx astro dev --port 4350 --host 127.0.0.1
```

Sign in at `/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`. Rebuild the
plugin (`npm run build`) and restart the site to pick up changes.

The sandbox refuses loopback and private addresses, and the manifest pins
`app.bulkpublish.com`, so a dev BulkPublish has to be on a public https host
that the site also allows. The playground does both:

```bash
ngrok http 4322 --url=<your-domain>                      # tunnel to a dev webapp
BP_TEST_HOST=<your-domain> npx astro dev --port 4350 --host 127.0.0.1
```

`BP_TEST_HOST` adds the host to the plugin's `allowedHosts` in
`playground/astro.config.mjs`. Then point the plugin at it — there is no field
for this, because a real install can only ever reach `app.bulkpublish.com`:

```js
// in the admin's browser console
fetch("/_emdash/api/plugins/bulkpublish/admin", { method: "POST",
  headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
  body: JSON.stringify({ type: "form_submit", action_id: "save_advanced",
    values: { apiBase: "https://<your-domain>" } }) });
```

Verified this way on 2026-10-16: text-only, image (byte-exact upload),
long-caption, plan-limit, re-publish and draft/image cleanup paths.

## Releasing

1. `npx emdash-plugin login <handle>` and put that account's DID in
   `publisher` (`emdash-plugin.jsonc`).
2. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
3. `npx emdash-plugin publish`.
