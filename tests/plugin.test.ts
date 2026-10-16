import { describe, expect, it } from "vitest";

import plugin, { __test } from "../src/plugin";
import type { ShareRecord } from "../src/lib";
import { IMAGE, IMAGE_BYTES, fakeCtx, post } from "./fake-ctx";

const KEY = "bp_" + "a".repeat(40);
const base = (channelIds: number[], kv: Record<string, unknown> = {}) => ({
	settings: { apiKey: KEY },
	kv: { "settings:channelIds": channelIds, ...kv },
});

const hooks = plugin.hooks as Record<string, { handler: (e: unknown, c: unknown) => Promise<unknown> }>;
const routes = plugin.routes as Record<string, { handler: (r: unknown, c: unknown) => Promise<any> }>;

function entry(data: Record<string, unknown>, id = "p1") {
	return { collection: "posts", id, slug: "hello-world", data };
}

describe("share: what gets sent", () => {
	it("posts text to text networks and skips image/video-only ones without an image", async () => {
		const f = fakeCtx(base([308, 309, 310, 313]));
		const rec = await __test.share(f.ctx, entry({ title: "Hello", excerpt: "World" }));

		expect(rec.status).toBe("sent");
		const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/posts")!;
		expect(create.body).toEqual({
			content: "Hello\n\nWorld\n\nhttps://blog.test/posts/hello-world",
			status: "draft",
			channels: [
				{ channelId: 308, platform: "bluesky" },
				{ channelId: 309, platform: "linkedin" },
			],
		});
		expect(create.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(f.calls.some((c) => c.path === "/api/posts/2001/publish")).toBe(true);
		expect(rec.skipped?.map((s) => s.platform)).toEqual(["instagram", "youtube"]);
		expect(rec.sentTo).toEqual(["Bluesky · Test Bluesky", "LinkedIn · Test LinkedIn"]);
	});

	it("uploads the featured image, attaches it, and asks Threads for an image post", async () => {
		const f = fakeCtx({ ...base([310, 311]), media: { MEDIA1: IMAGE_BYTES } });
		const rec = await __test.share(f.ctx, entry({ title: "Pic", featured_image: IMAGE }));

		expect(rec.status).toBe("sent");
		const upload = f.calls.find((c) => c.path === "/api/media")!;
		expect(upload.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
		const text = new TextDecoder().decode(upload.body as Uint8Array);
		expect(text).toContain('name="file"; filename="hero.jpg"');
		expect(text).toContain("Content-Type: image/jpeg");
		const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/posts")!;
		expect(create.body).toMatchObject({ mediaFiles: [125], postTypeOverrides: { threads: "image" } });
		expect((create.body as { channels: unknown[] }).channels).toHaveLength(2);
	});

	it("leaves the image off when the setting is off", async () => {
		const f = fakeCtx({ ...base([308, 310], { "settings:attachImage": false }), media: { MEDIA1: IMAGE_BYTES } });
		const rec = await __test.share(f.ctx, entry({ title: "Pic", featured_image: IMAGE }));
		expect(f.calls.some((c) => c.path === "/api/media")).toBe(false);
		expect(rec.skipped?.[0]).toMatchObject({ platform: "instagram" });
	});

	it("shortens the caption for X only, keeping the link", async () => {
		const f = fakeCtx(base([309, 312]));
		const long = "A very long title ".repeat(25).trim();
		await __test.share(f.ctx, entry({ title: long, excerpt: "e".repeat(300) }));
		const body = f.calls.find((c) => c.method === "POST" && c.path === "/api/posts")!.body as {
			content: string;
			platformContent: Record<string, string>;
		};
		expect(body.content.length).toBeGreaterThan(280);
		expect(body.platformContent.x.endsWith("https://blog.test/posts/hello-world")).toBe(true);
		expect(body.platformContent.linkedin).toBeUndefined();
	});

	it("still shares text when the image is too big to read", async () => {
		const huge = { ...IMAGE_BYTES, size: 50 * 1024 * 1024 };
		const f = fakeCtx({ ...base([308, 310]), media: { MEDIA1: huge } });
		const rec = await __test.share(f.ctx, entry({ title: "Big", featured_image: IMAGE }));
		expect(rec.status).toBe("sent");
		expect(rec.skipped?.map((s) => s.platform)).toEqual(["image", "instagram"]);
	});

	it("uses the SEO description when there is no excerpt", async () => {
		const f = fakeCtx(base([309]));
		await __test.share(f.ctx, { ...entry({ title: "T" }), seo: { description: "From SEO" } });
		const body = f.calls.find((c) => c.method === "POST" && c.path === "/api/posts")!.body as { content: string };
		expect(body.content).toContain("From SEO");
	});
});

describe("share: failures", () => {
	it("deletes the draft when publishing it is refused", async () => {
		const f = fakeCtx({
			...base([309]),
			routes: {
				"POST /api/posts/:id/publish": () => ({ status: 400, body: { error: { message: "linkedin: something is wrong", code: "VALIDATION_ERROR" } } }),
			},
		});
		const rec = await __test.share(f.ctx, entry({ title: "T" }));
		expect(rec.status).toBe("failed");
		expect(rec.error).toBe("linkedin: something is wrong");
		expect(f.calls.some((c) => c.method === "DELETE" && c.path === "/api/posts/2001")).toBe(true);
	});

	it("explains a rejected key", async () => {
		const f = fakeCtx({ ...base([309]), routes: { "GET /api/channels": () => ({ status: 401, body: { error: "Unauthorized" } }) } });
		const rec = await __test.share(f.ctx, entry({ title: "T" }));
		expect(rec.error).toMatch(/didn't accept the API key/);
	});

	it("says so when the plan limit is reached", async () => {
		const f = fakeCtx({ ...base([309]), routes: { "POST /api/posts": () => ({ status: 429, body: { error: { message: "Monthly post limit reached" } } }) } });
		const rec = await __test.share(f.ctx, entry({ title: "T" }));
		expect(rec.error).toBe("Monthly post limit reached");
	});

	it("survives the network being down", async () => {
		const f = fakeCtx({ ...base([309]), routes: { "GET /api/channels": () => { throw new Error("ECONNRESET"); } } });
		const rec = await __test.share(f.ctx, entry({ title: "T" }));
		expect(rec.error).toMatch(/Couldn't reach BulkPublish/);
	});

	it("fails cleanly with nothing to send", async () => {
		const f = fakeCtx(base([310, 313, 314, 999]));
		const rec = await __test.share(f.ctx, entry({ title: "T" }));
		expect(rec.status).toBe("failed");
		expect(f.calls.some((c) => c.path === "/api/posts")).toBe(false);
		expect(rec.skipped?.map((s) => s.reason)).toEqual([
			"needs an image and this post has none",
			"only takes videos",
			"needs reconnecting in BulkPublish",
			"is no longer connected",
		]);
	});

	it("asks for setup when there is no key or no channel", async () => {
		const noKey = fakeCtx({ kv: { "settings:channelIds": [309] } });
		expect((await __test.share(noKey.ctx, entry({ title: "T" }))).error).toMatch(/API key/);
		const noChan = fakeCtx({ settings: { apiKey: KEY } });
		expect((await __test.share(noChan.ctx, entry({ title: "T" }))).error).toMatch(/at least one channel/);
	});

	it("reports a missing network grant instead of crashing", async () => {
		const f = fakeCtx({ ...base([309]), noHttp: true });
		expect((await __test.share(f.ctx, entry({ title: "T" }))).error).toMatch(/without network access/);
	});
});

describe("share: once only", () => {
	it("does not share the same entry twice", async () => {
		const f = fakeCtx(base([309]));
		await __test.share(f.ctx, entry({ title: "T" }));
		const n = f.calls.length;
		const again = await __test.share(f.ctx, entry({ title: "T" }));
		expect(again.status).toBe("sent");
		expect(f.calls.length).toBe(n);
	});

	it("does not retry a failure on its own, but force does", async () => {
		const f = fakeCtx({ settings: { apiKey: KEY } });
		await __test.share(f.ctx, entry({ title: "T" }));
		f.kv.set("settings:channelIds", [309]);
		expect((await __test.share(f.ctx, entry({ title: "T" }))).status).toBe("failed");
		expect((await __test.share(f.ctx, entry({ title: "T" }), { force: true })).status).toBe("sent");
	});

	it("leaves an in-flight share alone, even when forced", async () => {
		const f = fakeCtx(base([309]));
		const now = new Date().toISOString();
		const pending: ShareRecord = { contentId: "p1", collection: "posts", title: "T", postId: null, status: "pending", createdAt: now, updatedAt: now };
		f.rows.set("p1", { value: pending, rev: 1 });
		expect((await __test.share(f.ctx, entry({ title: "T" }), { force: true })).status).toBe("pending");
		expect(f.calls).toHaveLength(0);
	});

	it("takes over a share that died mid-flight", async () => {
		const f = fakeCtx(base([309]));
		const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		f.rows.set("p1", { value: { contentId: "p1", collection: "posts", title: "T", postId: null, status: "pending", createdAt: old, updatedAt: old }, rev: 1 });
		expect((await __test.share(f.ctx, entry({ title: "T" }))).status).toBe("sent");
	});

	it("lets only one of two simultaneous publishes through", async () => {
		const f = fakeCtx(base([309]));
		const [a, b] = await Promise.all([__test.share(f.ctx, entry({ title: "T" })), __test.share(f.ctx, entry({ title: "T" }))]);
		expect(f.calls.filter((c) => c.method === "POST" && c.path === "/api/posts")).toHaveLength(1);
		expect([a.status, b.status].sort()).toEqual(["pending", "sent"]);
	});
});

describe("afterPublish hook", () => {
	const ev = (collection: string, content: Record<string, unknown>) => ({ collection, content });

	it("shares a published post", async () => {
		const f = fakeCtx(base([309]));
		await hooks["content:afterPublish"].handler(ev("posts", post("p9", { title: "Hi" })), f.ctx);
		expect(f.calls.some((c) => c.path === "/api/posts")).toBe(true);
	});

	it.each([
		["another collection", base([309]), "pages"],
		["sharing turned off", base([309], { "settings:enabled": false }), "posts"],
		["no API key", { kv: { "settings:channelIds": [309] } }, "posts"],
	])("does nothing for %s", async (_name, opts, collection) => {
		const f = fakeCtx(opts);
		await hooks["content:afterPublish"].handler(ev(collection, post("p9", { title: "Hi" })), f.ctx);
		expect(f.calls).toHaveLength(0);
		expect(f.rows.size).toBe(0);
	});

	it("follows the configured collections", async () => {
		const f = fakeCtx(base([309], { "settings:collections": "posts,news" }));
		await hooks["content:afterPublish"].handler(ev("news", post("n1", { title: "Hi" })), f.ctx);
		expect(f.calls.some((c) => c.path === "/api/posts")).toBe(true);
	});

	it("removes the share log on uninstall only when asked", async () => {
		const f = fakeCtx(base([309]));
		await __test.share(f.ctx, entry({ title: "T" }));
		await hooks["plugin:uninstall"].handler({ deleteData: false }, f.ctx);
		expect(f.rows.size).toBe(1);
		await hooks["plugin:uninstall"].handler({ deleteData: true }, f.ctx);
		expect(f.rows.size).toBe(0);
	});
});

describe("admin route", () => {
	const call = (f: ReturnType<typeof fakeCtx>, input: unknown) => routes.admin.handler({ input, request: {} }, f.ctx);

	it("lists channels with their problems once connected", async () => {
		const f = fakeCtx(base([309, 999]));
		const res = await call(f, { type: "page_load", page: "/settings" });
		const form = res.blocks.find((b: { block_id?: string }) => b.block_id === "bp-settings");
		const box = form.fields.find((x: { action_id: string }) => x.action_id === "channelIds");
		expect(box.options.find((o: { value: string }) => o.value === "314").label).toContain("needs reconnecting");
		expect(box.initial_value).toEqual(["309"]); // 999 is gone, so it isn't pre-ticked
		expect(res.blocks[2]).toMatchObject({ type: "banner", title: "Connected · 7 channels available" });
	});

	it("rejects a malformed key without calling out", async () => {
		const f = fakeCtx();
		const res = await call(f, { type: "form_submit", action_id: "save_settings", values: { apiKey: "nope" } });
		expect(res.toast.type).toBe("error");
		expect(f.calls).toHaveLength(0);
		expect(f.settings.has("apiKey")).toBe(false);
	});

	it("checks a key against BulkPublish before saving it", async () => {
		const bad = fakeCtx({ routes: { "GET /api/channels": () => ({ status: 401, body: { error: "Unauthorized" } }) } });
		await call(bad, { type: "form_submit", action_id: "save_settings", values: { apiKey: KEY } });
		expect(bad.settings.has("apiKey")).toBe(false);
		const good = fakeCtx();
		const res = await call(good, { type: "form_submit", action_id: "save_settings", values: { apiKey: KEY, channelIds: ["309", "310"], template: "  ", collections: " , " } });
		expect(good.settings.get("apiKey")).toBe(KEY);
		expect(good.kv.get("settings:channelIds")).toEqual([309, 310]);
		expect(good.kv.get("settings:template")).toBe("{title}\n\n{excerpt}\n\n{url}");
		expect(good.kv.get("settings:collections")).toBe("posts");
		expect(res.toast.type).toBe("success");
	});

	it("keeps the saved key when the field is left blank", async () => {
		const f = fakeCtx(base([309]));
		await call(f, { type: "form_submit", action_id: "save_settings", values: { apiKey: "", enabled: false } });
		expect(f.settings.get("apiKey")).toBe(KEY);
		expect(f.kv.get("settings:enabled")).toBe(false);
	});

	it("only accepts an https API address", async () => {
		const f = fakeCtx();
		await call(f, { type: "form_submit", action_id: "save_advanced", values: { apiBase: "http://evil.test", imageField: " hero " } });
		expect(f.kv.get("settings:apiBase")).toBe("https://app.bulkpublish.com");
		expect(f.kv.get("settings:imageField")).toBe("hero");
		await call(f, { type: "form_submit", action_id: "save_advanced", values: { apiBase: "https://staging.bulkpublish.com/x" } });
		expect(f.kv.get("settings:apiBase")).toBe("https://staging.bulkpublish.com");
	});

	it("removes the key", async () => {
		const f = fakeCtx(base([309]));
		await call(f, { type: "block_action", action_id: "disconnect" });
		expect(f.settings.has("apiKey")).toBe(false);
	});

	it("renders the dashboard widget counts", async () => {
		const f = fakeCtx(base([309]));
		await __test.share(f.ctx, entry({ title: "T" }));
		const res = await call(f, { type: "page_load", page: "widget:status" });
		expect(res.blocks[0].items).toEqual([
			{ label: "Shared", value: 1 },
			{ label: "Not shared", value: 0 },
		]);
	});
});

describe("editor panel", () => {
	const ui = (id: string, collection = "posts") => ({ surface: "content-editor-panel", entry: { collection, id, locale: "en", version: 1 }, extensionId: "share" });
	const call = (f: ReturnType<typeof fakeCtx>, input: unknown, id = "p1") => routes["editor/share"].handler({ input, request: {}, ui: ui(id) }, f.ctx);

	it("offers Share now on a published, unshared post", async () => {
		const f = fakeCtx({ ...base([309]), content: { "posts/p1": post("p1", { title: "T" }) } });
		const res = await call(f, { type: "panel_load" });
		expect(res.blocks.at(-1).elements[0]).toMatchObject({ action_id: "share_now", label: "Share now" });
	});

	it("shares on click and shows the result", async () => {
		const f = fakeCtx({ ...base([309]), content: { "posts/p1": post("p1", { title: "T" }) } });
		const res = await call(f, { type: "block_action", action_id: "share_now" });
		expect(res.toast).toEqual({ message: "Shared", type: "success" });
		expect(res.blocks[0]).toMatchObject({ type: "banner", title: "Shared to social" });
		expect(res.blocks.at(-1).elements[0]).toMatchObject({ label: "Share again", confirm: expect.any(Object) });
	});

	it("won't share a draft", async () => {
		const f = fakeCtx({ ...base([309]), content: { "posts/p1": post("p1", { title: "T" }, { status: "draft" }) } });
		const res = await call(f, { type: "block_action", action_id: "share_now" });
		expect(res.toast.type).toBe("error");
		expect(f.calls).toHaveLength(0);
		expect(res.blocks.some((b: { type: string }) => b.type === "actions")).toBe(false);
	});

	it("asks to connect first", async () => {
		const f = fakeCtx({ content: { "posts/p1": post("p1", { title: "T" }) } });
		const res = await call(f, { type: "panel_load" });
		expect(res.blocks[0].text).toMatch(/Connect BulkPublish/);
	});

	it("handles a panel without an entry", async () => {
		const f = fakeCtx(base([309]));
		const res = await routes["editor/share"].handler({ input: { type: "panel_load" }, request: {} }, f.ctx);
		expect(res.blocks[0].text).toMatch(/Save the entry/);
	});
});
