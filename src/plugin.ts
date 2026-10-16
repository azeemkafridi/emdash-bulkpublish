import type { PluginContext, SandboxedPlugin, SandboxedRouteContext as RouteContext } from "emdash/plugin";

import {
	DEFAULT_API_BASE,
	DEFAULT_TEMPLATE,
	MAX_IMAGE_BYTES,
	STALE_CLAIM_MS,
	apiError,
	buildPostBody,
	excerptOf,
	imageOf,
	isRecord,
	looksLikeKey,
	multipartFile,
	normalizeApiBase,
	parseChannel,
	parseChannelIds,
	parseCollections,
	planTargets,
	platformLabel,
	titleOf,
	type Channel,
	type ShareRecord,
	type Skipped,
} from "./lib";

type Ctx = PluginContext;
type Block = Record<string, unknown>;

// ── Config ──

async function getConfig(ctx: Ctx) {
	const kv = ctx.kv;
	return {
		apiKey: (await ctx.settings.get<string>("apiKey")) || null,
		apiBase: normalizeApiBase(await kv.get<string>("settings:apiBase")),
		enabled: (await kv.get<boolean>("settings:enabled")) ?? true,
		channelIds: parseChannelIds(await kv.get<number[]>("settings:channelIds")),
		template: (await kv.get<string>("settings:template")) || DEFAULT_TEMPLATE,
		collections: parseCollections((await kv.get<string>("settings:collections")) ?? "posts"),
		attachImage: (await kv.get<boolean>("settings:attachImage")) ?? true,
		imageField: (await kv.get<string>("settings:imageField")) || "",
	};
}
type Config = Awaited<ReturnType<typeof getConfig>>;

// ── API client ──

class ApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

async function api(
	ctx: Ctx,
	cfg: Pick<Config, "apiKey" | "apiBase">,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	if (!ctx.http) throw new ApiError("This plugin was installed without network access. Reinstall it and allow access.", 0);
	if (!cfg.apiKey) throw new ApiError("Add your BulkPublish API key in Settings.", 0);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${cfg.apiKey}`,
		Accept: "application/json",
		"X-BulkPublish-Client": "emdash",
	};
	let payload: string | Uint8Array<ArrayBuffer> | undefined;
	if (isRecord(body) && body.multipart instanceof Uint8Array) {
		payload = body.multipart as Uint8Array<ArrayBuffer>;
		headers["Content-Type"] = String(body.contentType);
	} else if (body !== undefined) {
		payload = JSON.stringify(body);
		headers["Content-Type"] = "application/json";
	}
	let res: Response;
	try {
		res = await ctx.http.fetch(`${cfg.apiBase}${path}`, { method, headers, body: payload });
	} catch (err) {
		ctx.log.warn("BulkPublish request failed", { path, error: String(err) });
		throw new ApiError("Couldn't reach BulkPublish. Check your connection and try again.", 0);
	}
	const data: unknown = await res.json().catch(() => null);
	if (!res.ok) throw new ApiError(apiError(res.status, data), res.status);
	return data;
}

async function listChannels(ctx: Ctx, cfg: Config): Promise<Channel[]> {
	const data = await api(ctx, cfg, "GET", "/api/channels");
	const rows = isRecord(data) && Array.isArray(data.channels) ? data.channels : [];
	return rows.map(parseChannel).filter((c): c is Channel => c !== null);
}

/** Copy the entry's featured image into the BulkPublish media library. */
async function uploadImage(ctx: Ctx, cfg: Config, data: unknown): Promise<{ id: number | null; note?: string }> {
	if (!cfg.attachImage) return { id: null };
	const ref = imageOf(data, cfg.imageField);
	if (!ref) return { id: null };
	if (!ctx.media?.readBytes) return { id: null, note: "the image couldn't be read from your media library" };
	let file;
	try {
		file = await ctx.media.readBytes(ref.id, { maxBytes: MAX_IMAGE_BYTES });
	} catch (err) {
		ctx.log.warn("BulkPublish could not read image", { mediaId: ref.id, error: String(err) });
		return { id: null, note: "the image is too large (over 7 MB) or couldn't be read" };
	}
	const { body, contentType } = multipartFile({
		bytes: file.bytes,
		filename: file.filename || ref.filename,
		mimeType: file.mimeType || ref.mimeType,
	});
	try {
		const res = await api(ctx, cfg, "POST", "/api/media", { multipart: body, contentType });
		const id = isRecord(res) && isRecord(res.file) ? Number(res.file.id) : NaN;
		return Number.isInteger(id) ? { id } : { id: null, note: "BulkPublish didn't accept the image" };
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) throw err;
		return { id: null, note: `the image wasn't attached: ${err instanceof Error ? err.message : String(err)}` };
	}
}

// ── Sharing ──

interface ShareInput {
	collection: string;
	id: string;
	slug?: string | null;
	data?: unknown;
	seo?: { description?: string | null } | null;
}

async function publicUrl(ctx: Ctx, entry: ShareInput): Promise<string> {
	try {
		const url = await ctx.content?.getPublicUrl?.(entry.collection, entry.id);
		if (url) return url.startsWith("http") ? url : ctx.url(url);
	} catch {
		// fall through to the conventional path
	}
	return ctx.url(`/${entry.collection}/${encodeURIComponent(entry.slug || entry.id)}`);
}

/**
 * Share one entry. Without `force` an entry is shared at most once: a later
 * re-publish (an edit to a live post) does not post it again.
 */
async function share(ctx: Ctx, entry: ShareInput, opts: { force?: boolean } = {}): Promise<ShareRecord> {
	const shares = ctx.storage.shares!;
	const now = new Date().toISOString();
	const prev = await shares.getVersioned(entry.id);
	const prevRec = prev?.value as ShareRecord | undefined;
	if (prevRec && !opts.force) {
		const stale = prevRec.status === "pending" && Date.now() - Date.parse(prevRec.updatedAt) > STALE_CLAIM_MS;
		if (!stale) return prevRec;
	}
	if (prevRec?.status === "pending" && Date.now() - Date.parse(prevRec.updatedAt) <= STALE_CLAIM_MS) {
		return prevRec; // another request is sharing this entry right now
	}

	const title = titleOf(entry.data) || entry.slug || "Untitled";
	const claim: ShareRecord = {
		contentId: entry.id,
		collection: entry.collection,
		title,
		postId: null,
		status: "pending",
		createdAt: prevRec?.createdAt ?? now,
		updatedAt: now,
	};
	const won = await shares.compareAndSet(entry.id, prev?.revision ?? null, claim);
	if (!won.applied) return ((await shares.get(entry.id)) as ShareRecord | null) ?? claim;

	const cfg = await getConfig(ctx);
	let rec: ShareRecord = claim;
	let draftId: number | null = null;
	try {
		if (!cfg.apiKey) throw new ApiError("Add your BulkPublish API key in Settings.", 0);
		if (cfg.channelIds.length === 0) throw new ApiError("Pick at least one channel in BulkPublish settings.", 0);

		const channels = await listChannels(ctx, cfg);
		const image = await uploadImage(ctx, cfg, entry.data);
		const { targets, skipped } = planTargets(channels, cfg.channelIds, image.id !== null);
		const notes: Skipped[] = image.note ? [{ channelId: 0, platform: "image", reason: image.note }] : [];
		if (targets.length === 0) {
			rec = { ...claim, status: "failed", skipped: [...notes, ...skipped], error: "None of the chosen channels can take this post.", updatedAt: new Date().toISOString() };
		} else {
			const vars = { title, excerpt: excerptOf(entry.data, 200, entry.seo?.description), url: await publicUrl(ctx, entry) };
			const created = await api(ctx, cfg, "POST", "/api/posts", buildPostBody(targets, cfg.template, vars, image.id));
			const postId = isRecord(created) ? Number(created.id) : NaN;
			if (!Number.isInteger(postId)) throw new ApiError("BulkPublish didn't return the new post.", 0);
			draftId = postId;
			await api(ctx, cfg, "POST", `/api/posts/${postId}/publish`);
			draftId = null;
			rec = {
				...claim,
				postId,
				status: "sent",
				sentTo: targets.map((t) => `${platformLabel(t.platform)} · ${t.name}`),
				skipped: [...notes, ...skipped],
				updatedAt: new Date().toISOString(),
			};
		}
	} catch (err) {
		rec = { ...claim, status: "failed", error: err instanceof Error ? err.message : String(err), updatedAt: new Date().toISOString() };
		ctx.log.warn("BulkPublish share failed", { contentId: entry.id, error: rec.error });
	}
	// A draft that couldn't be published would otherwise sit in BulkPublish
	// and turn into a duplicate the next time this entry is shared.
	if (draftId !== null) {
		await api(ctx, cfg, "DELETE", `/api/posts/${draftId}`).catch(() => undefined);
	}
	await shares.put(entry.id, rec);
	return rec;
}

// ── Block Kit ──

function banner(title: string, variant: "default" | "alert" | "error" = "default", description?: string): Block {
	return { type: "banner", title, variant, ...(description ? { description } : {}) };
}

function recordSummary(rec: ShareRecord): Block[] {
	const blocks: Block[] = [];
	if (rec.status === "sent") {
		blocks.push(banner("Shared to social", "default", rec.sentTo?.join(", ")));
	} else if (rec.status === "pending") {
		blocks.push(banner("Sharing now…"));
	} else {
		blocks.push(banner("Not shared", "error", rec.error));
	}
	const skipped = (rec.skipped ?? []).map((s) => (s.platform === "image" ? `Image: ${s.reason}` : `${platformLabel(s.platform)} ${s.reason}`));
	if (skipped.length) blocks.push({ type: "context", text: `Skipped: ${skipped.join("; ")}.` });
	return blocks;
}

async function settingsPage(ctx: Ctx, extra: Block[] = []) {
	const cfg = await getConfig(ctx);
	const blocks: Block[] = [
		{ type: "header", text: "BulkPublish" },
		{ type: "context", text: "Share every post you publish to your social accounts. Create an API key in BulkPublish under Settings → API keys." },
		...extra,
	];

	let channels: Channel[] | null = null;
	if (cfg.apiKey) {
		try {
			channels = await listChannels(ctx, cfg);
			blocks.push(banner(`Connected · ${channels.length} channel${channels.length === 1 ? "" : "s"} available`));
		} catch (err) {
			blocks.push(banner("Can't connect to BulkPublish", "error", err instanceof Error ? err.message : String(err)));
		}
	} else {
		blocks.push(banner("Not connected", "alert", "Paste your API key below and save."));
	}

	const fields: Block[] = [
		{ type: "secret_input", action_id: "apiKey", label: "API key", placeholder: cfg.apiKey ? "Saved. Paste a new key to replace it." : "bp_…", has_value: !!cfg.apiKey },
	];
	if (channels) {
		if (channels.length === 0) {
			blocks.push({ type: "context", text: "No channels yet. Connect your social accounts in BulkPublish, then reload this page." });
		} else {
			const known = new Set(channels.map((c) => c.id));
			fields.push({
				type: "checkbox",
				action_id: "channelIds",
				label: "Share to",
				options: channels.map((c) => ({
					label: `${platformLabel(c.platform)} · ${c.name}${c.problem ? ` (${c.problem})` : ""}`,
					value: String(c.id),
				})),
				initial_value: cfg.channelIds.filter((id) => known.has(id)).map(String),
			});
		}
	}
	fields.push(
		{ type: "toggle", action_id: "enabled", label: "Share automatically when a post is published", description: "Each post is shared once. Use Share again in the editor to share it a second time.", initial_value: cfg.enabled },
		{ type: "text_input", action_id: "template", label: "Caption", multiline: true, initial_value: cfg.template, placeholder: DEFAULT_TEMPLATE },
		{ type: "toggle", action_id: "attachImage", label: "Attach the featured image", description: "Instagram, Pinterest and Snapchat need an image. Posts without one skip them.", initial_value: cfg.attachImage },
		{ type: "text_input", action_id: "collections", label: "Collections to share", placeholder: "posts", initial_value: cfg.collections.join(", ") },
	);
	blocks.push(
		{ type: "context", text: "Caption placeholders: {title}, {excerpt}, {url}. Captions too long for X, Bluesky or Threads are shortened for those networks, keeping the link." },
		{ type: "form", block_id: "bp-settings", fields, submit: { label: "Save settings", action_id: "save_settings" } },
		{
			type: "accordion",
			label: "Advanced",
			blocks: [
				{
					type: "form",
					block_id: "bp-advanced",
					fields: [
						{ type: "text_input", action_id: "imageField", label: "Image field", placeholder: "Found automatically", initial_value: cfg.imageField },
						{ type: "text_input", action_id: "apiBase", label: "API address", placeholder: DEFAULT_API_BASE, initial_value: cfg.apiBase === DEFAULT_API_BASE ? "" : cfg.apiBase },
					],
					submit: { label: "Save advanced", action_id: "save_advanced" },
				},
				...(cfg.apiKey
					? [{ type: "actions", elements: [{ type: "button", action_id: "disconnect", label: "Remove API key", style: "danger", confirm: { title: "Remove the API key?", text: "Posts stop being shared until you add a key again.", confirm: "Remove", deny: "Cancel", style: "danger" } }] }]
					: []),
			],
		},
		...(await recentShares(ctx)),
	);
	return { blocks };
}

async function recentShares(ctx: Ctx): Promise<Block[]> {
	const res = await ctx.storage.shares!.query({ orderBy: { createdAt: "desc" }, limit: 10 });
	const rows = res.items.map(({ data }) => {
		const r = data as ShareRecord;
		return {
			title: r.title,
			status: r.status === "sent" ? "Shared" : r.status === "pending" ? "Sharing" : "Not shared",
			detail: r.status === "sent" ? (r.sentTo ?? []).join(", ") : (r.error ?? ""),
			when: r.updatedAt,
		};
	});
	return [
		{ type: "divider" },
		{ type: "header", text: "Recent shares" },
		{
			type: "table",
			page_action_id: "recent_page",
			columns: [
				{ key: "title", label: "Post" },
				{ key: "status", label: "Result", format: "badge" },
				{ key: "detail", label: "Details" },
				{ key: "when", label: "When", format: "relative_time" },
			],
			rows,
			empty_text: "Nothing shared yet.",
		},
	];
}

async function saveSettings(ctx: Ctx, v: Record<string, unknown>) {
	const problems: string[] = [];
	if (typeof v.apiKey === "string" && v.apiKey.trim()) {
		const key = v.apiKey.trim();
		if (!looksLikeKey(key)) {
			problems.push("That doesn't look like a BulkPublish API key (they start with bp_).");
		} else {
			const cfg = await getConfig(ctx);
			try {
				await api(ctx, { ...cfg, apiKey: key }, "GET", "/api/channels");
				await ctx.settings.set("apiKey", key);
			} catch (err) {
				problems.push(err instanceof Error ? err.message : String(err));
			}
		}
	}
	if (typeof v.enabled === "boolean") await ctx.kv.set("settings:enabled", v.enabled);
	if (typeof v.attachImage === "boolean") await ctx.kv.set("settings:attachImage", v.attachImage);
	if (typeof v.template === "string") {
		const t = v.template.trim();
		if (t.length > 2000) problems.push("The caption is too long (2,000 characters at most).");
		else await ctx.kv.set("settings:template", t || DEFAULT_TEMPLATE);
	}
	if (typeof v.collections === "string") {
		const list = parseCollections(v.collections);
		await ctx.kv.set("settings:collections", (list.length ? list : ["posts"]).join(","));
	}
	if (v.channelIds !== undefined) await ctx.kv.set("settings:channelIds", parseChannelIds(v.channelIds));

	const extra = problems.length ? [banner("Some settings weren't saved", "error", problems.join(" "))] : [];
	return {
		...(await settingsPage(ctx, extra)),
		toast: problems.length ? { message: "Check the settings", type: "error" as const } : { message: "Settings saved", type: "success" as const },
	};
}

async function saveAdvanced(ctx: Ctx, v: Record<string, unknown>) {
	if (typeof v.imageField === "string") await ctx.kv.set("settings:imageField", v.imageField.trim());
	if (typeof v.apiBase === "string") {
		const base = v.apiBase.trim();
		if (!base) await ctx.kv.delete("settings:apiBase");
		else await ctx.kv.set("settings:apiBase", normalizeApiBase(base));
	}
	return { ...(await settingsPage(ctx)), toast: { message: "Saved", type: "success" as const } };
}

async function statusWidget(ctx: Ctx) {
	const shares = ctx.storage.shares!;
	const cfg = await getConfig(ctx);
	const blocks: Block[] = [
		{
			type: "stats",
			items: [
				{ label: "Shared", value: await shares.count({ status: "sent" }) },
				{ label: "Not shared", value: await shares.count({ status: "failed" }) },
			],
		},
	];
	if (!cfg.apiKey) blocks.push({ type: "context", text: "Add your API key in BulkPublish settings to start sharing." });
	else if (!cfg.enabled) blocks.push({ type: "context", text: "Automatic sharing is off." });
	return { blocks };
}

async function sharePanel(ctx: Ctx, collection: string, id: string, toast?: { message: string; type: "success" | "error" | "info" }) {
	const cfg = await getConfig(ctx);
	const rec = (await ctx.storage.shares!.get(id)) as ShareRecord | null;
	const blocks: Block[] = [];
	if (!cfg.apiKey) {
		blocks.push({ type: "context", text: "Connect BulkPublish in its settings page to share posts." });
		return { blocks };
	}
	if (!cfg.collections.includes(collection)) {
		blocks.push({ type: "context", text: `This collection isn't shared automatically. Add "${collection}" in BulkPublish settings, or share it by hand.` });
	}
	const entry = await ctx.content?.get(collection, id);
	const live = entry?.status === "published";
	if (rec) blocks.push(...recordSummary(rec));
	else if (live) blocks.push({ type: "context", text: "This post hasn't been shared." });
	else blocks.push({ type: "context", text: cfg.enabled ? "It will be shared when you publish it." : "Automatic sharing is off. Publish, then share it here." });
	if (live && rec?.status !== "pending") {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "share_now",
					label: rec ? "Share again" : "Share now",
					style: rec ? "secondary" : "primary",
					...(rec?.status === "sent" ? { confirm: { title: "Share this post again?", text: "It will be posted to your channels a second time.", confirm: "Share again", deny: "Cancel" } } : {}),
				},
			],
		});
	}
	return { blocks, ...(toast ? { toast } : {}) };
}

// ── Plugin definition ──

const plugin = {
	hooks: {
		"content:afterPublish": {
			timeout: 28000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const cfg = await getConfig(ctx);
				if (!cfg.enabled || !cfg.apiKey || !cfg.collections.includes(event.collection)) return;
				const c = event.content as Record<string, unknown>;
				if (typeof c.id !== "string" && typeof c.id !== "number") return;
				await share(ctx, {
					collection: event.collection,
					id: String(c.id),
					slug: typeof c.slug === "string" ? c.slug : null,
					data: c.data,
					seo: isRecord(c.seo) ? (c.seo as { description?: string | null }) : null,
				});
			},
		},
		"plugin:uninstall": {
			handler: async (event, ctx) => {
				if (!event.deleteData) return;
				for (;;) {
					const page = await ctx.storage.shares!.query({ limit: 100 });
					if (page.items.length === 0) break;
					await ctx.storage.shares!.deleteMany(page.items.map((i) => i.id));
				}
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: RouteContext, ctx: Ctx) => {
				const i = (isRecord(routeCtx.input) ? routeCtx.input : {}) as { type?: string; page?: string; action_id?: string; values?: Record<string, unknown> };
				if (i.type === "page_load" && i.page === "widget:status") return statusWidget(ctx);
				if (i.type === "form_submit" && i.action_id === "save_settings") return saveSettings(ctx, i.values ?? {});
				if (i.type === "form_submit" && i.action_id === "save_advanced") return saveAdvanced(ctx, i.values ?? {});
				if (i.type === "block_action" && i.action_id === "disconnect") {
					await ctx.settings.delete("apiKey");
					return { ...(await settingsPage(ctx)), toast: { message: "API key removed", type: "info" as const } };
				}
				return settingsPage(ctx);
			},
		},
		"editor/share": {
			permission: "content:publish_any",
			handler: async (routeCtx: RouteContext, ctx: Ctx) => {
				const entry = routeCtx.ui && "entry" in routeCtx.ui ? routeCtx.ui.entry : undefined;
				if (!entry) return { blocks: [{ type: "context", text: "Save the entry first." }] };
				const i = (isRecord(routeCtx.input) ? routeCtx.input : {}) as { type?: string; action_id?: string };
				if (i.type === "block_action" && i.action_id === "share_now") {
					const item = await ctx.content?.get(entry.collection, entry.id);
					if (!item || item.status !== "published") {
						return sharePanel(ctx, entry.collection, entry.id, { message: "Publish the post first", type: "error" });
					}
					const rec = await share(ctx, { collection: entry.collection, id: item.id, slug: item.slug, data: item.data, seo: item.seo }, { force: true });
					return sharePanel(ctx, entry.collection, entry.id, rec.status === "sent" ? { message: "Shared", type: "success" } : { message: rec.error ?? "Not shared", type: "error" });
				}
				return sharePanel(ctx, entry.collection, entry.id);
			},
		},
	},
} satisfies SandboxedPlugin;

export default plugin;

/** Exposed for tests only. */
export const __test = { share, getConfig };
