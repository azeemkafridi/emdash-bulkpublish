# Changelog

## 1.0.0

- Shares posts to your BulkPublish channels when they are published, once per post.
- Caption template with `{title}`, `{excerpt}` and `{url}`, shortened per network for X, Bluesky, Threads, Mastodon and Snapchat.
- Attaches the featured image; networks that need one are skipped when a post has none, with the reason shown.
- Share to social editor panel with Share now / Share again, a dashboard widget, and a recent-shares log in settings.
- API key is checked against BulkPublish before it is saved.
- A share that fails cleans up after itself: no leftover draft or image in BulkPublish.
