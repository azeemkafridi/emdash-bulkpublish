import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import {
	API_BASE,
	DEFAULT_TEMPLATE,
	apiError,
	buildPostBody,
	excerptOf,
	isRecord,
	parseChannelIds,
	renderCaption,
	titleOf,
	type Channel,
	type ShareRecord,
} from "./lib";

// ── Config ──

async function getConfig(ctx: PluginContext) {
	return {
		apiKey: await ctx.settings.get<string>("apiKey"),
		enabled: (await ctx.kv.get<boolean>("settings:enabled")) ?? true,
		channelIds: parseChannelIds(await ctx.kv.get<number[]>("settings:channelIds")),
		template: (await ctx.kv.get<string>("settings:template")) || DEFAULT_TEMPLATE,
		collections: (await ctx.kv.get<string>("settings:collections")) || "posts",
	};
}

// ── API client (the only host this plugin may reach) ──

async function api(ctx: PluginContext, apiKey: string, method: string, path: string, body?: unknown) {
	if (!ctx.http) throw new Error("BulkPublish needs the network:request capability");
	const res = await ctx.http.fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"X-BulkPublish-Client": "emdash",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data: unknown = await res.json().catch(() => null);
	if (!res.ok) throw new Error(apiError(res.status, data));
	return data;
}

async function listChannels(ctx: PluginContext, apiKey: string): Promise<Channel[]> {
	const data = await api(ctx, apiKey, "GET", "/api/channels");
	const rows = isRecord(data) && Array.isArray(data.channels) ? data.channels : [];
	return rows.filter(isRecord).map((c) => ({
		id: Number(c.id),
		platform: String(c.platform),
		name: typeof c.name === "string" ? c.name : undefined,
		username: typeof c.username === "string" ? c.username : undefined,
	}));
}

// ── Sharing ──

async function share(
	ctx: PluginContext,
	content: { id?: unknown; slug?: unknown; data?: unknown },
	collection: string,
	opts: { force?: boolean } = {},
): Promise<ShareRecord> {
	const cfg = await getConfig(ctx);
	const contentId = String(content.id);
	const shares = ctx.storage.shares!;

	// Claim the row first so a double publish (or two editors) shares once.
	const prev = await shares.getVersioned(contentId);
	if (prev && !opts.force) return prev.value as ShareRecord;
	const claim: ShareRecord = { contentId, collection, postId: null, status: "failed", error: "In progress", createdAt: new Date().toISOString() };
	const won = await shares.compareAndSet(contentId, prev?.revision ?? null, claim);
	if (!won.applied) return ((await shares.get(contentId)) as ShareRecord) ?? claim;

	let record: ShareRecord;
	try {
		if (!cfg.apiKey) throw new Error("Add your BulkPublish API key in Settings.");
		if (cfg.channelIds.length === 0) throw new Error("Pick at least one channel in Settings.");
		const slug = typeof content.slug === "string" ? content.slug : contentId;
		const caption = renderCaption(cfg.template, {
			title: titleOf(content.data),
			excerpt: excerptOf(content.data),
			url: ctx.url(`/${collection}/${encodeURIComponent(slug)}`),
		});
		const channels = await listChannels(ctx, cfg.apiKey);
		const body = buildPostBody(caption, channels, cfg.channelIds);
		if (body.channels.length === 0) throw new Error("None of the chosen channels are connected any more.");
		const created = await api(ctx, cfg.apiKey, "POST", "/api/posts", body);
		const postId = isRecord(created) && isRecord(created.post) ? Number(created.post.id) : NaN;
		if (!Number.isInteger(postId)) throw new Error("BulkPublish did not return a post.");
		await api(ctx, cfg.apiKey, "POST", `/api/posts/${postId}/publish`);
		record = { ...claim, postId, status: "sent", error: undefined };
	} catch (err) {
		record = { ...claim, error: err instanceof Error ? err.message : String(err) };
		ctx.log.warn("BulkPublish share failed", { contentId, error: record.error });
	}
	await shares.put(contentId, record);
	return record;
}

// ── Block Kit pages ──

async function settingsPage(ctx: PluginContext) {
	const cfg = await getConfig(ctx);
	let channelBlock: Record<string, unknown>;
	if (!cfg.apiKey) {
		channelBlock = { type: "banner", variant: "info", title: "Paste an API key and save to pick channels." };
	} else {
		try {
			const channels = await listChannels(ctx, cfg.apiKey);
			channelBlock = {
				type: "checkbox",
				action_id: "channelIds",
				label: "Share to these channels",
				options: channels.map((c) => ({ label: `${c.platform} · ${c.name ?? c.username ?? c.id}`, value: String(c.id) })),
				initial_value: cfg.channelIds.map(String),
			};
		} catch (err) {
			channelBlock = { type: "banner", variant: "error", title: err instanceof Error ? err.message : "Could not load channels." };
		}
	}
	const fields: Record<string, unknown>[] = [
		{ type: "secret_input", action_id: "apiKey", label: "API key", has_value: !!cfg.apiKey, placeholder: "bp_…" },
		{ type: "toggle", action_id: "enabled", label: "Share automatically when a post is published", initial_value: cfg.enabled },
		{ type: "text_input", action_id: "collections", label: "Collections to share (comma separated)", initial_value: cfg.collections },
		{ type: "text_input", action_id: "template", label: "Caption ({title}, {excerpt}, {url})", multiline: true, initial_value: cfg.template },
	];
	if (channelBlock.type === "checkbox") fields.push(channelBlock);
	return {
		blocks: [
			{ type: "header", text: "BulkPublish" },
			{ type: "context", text: "Create an API key at app.bulkpublish.com → Settings → API keys." },
			...(channelBlock.type === "checkbox" ? [] : [channelBlock]),
			{ type: "form", block_id: "bp-settings", fields, submit: { label: "Save", action_id: "save_settings" } },
		],
	};
}

async function saveSettings(ctx: PluginContext, v: Record<string, unknown>) {
	if (typeof v.apiKey === "string" && v.apiKey.trim()) await ctx.settings.set("apiKey", v.apiKey.trim());
	if (typeof v.enabled === "boolean") await ctx.kv.set("settings:enabled", v.enabled);
	if (typeof v.template === "string") await ctx.kv.set("settings:template", v.template);
	if (typeof v.collections === "string") await ctx.kv.set("settings:collections", v.collections);
	if (v.channelIds !== undefined) await ctx.kv.set("settings:channelIds", parseChannelIds(v.channelIds));
	return { ...(await settingsPage(ctx)), toast: { message: "Settings saved", type: "success" } };
}

async function statusWidget(ctx: PluginContext) {
	const shares = ctx.storage.shares!;
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Shared", value: String(await shares.count({ status: "sent" })) },
					{ label: "Failed", value: String(await shares.count({ status: "failed" })) },
				],
			},
		],
	};
}

async function sharePanel(ctx: PluginContext, contentId: string) {
	const rec = (await ctx.storage.shares!.get(contentId)) as ShareRecord | null;
	const line = !rec
		? { type: "context", text: "Not shared yet. It will be shared when you publish." }
		: rec.status === "sent"
			? { type: "banner", variant: "success", title: "Shared to social" }
			: { type: "banner", variant: "error", title: rec.error ?? "Share failed" };
	return {
		blocks: [
			line,
			{ type: "actions", elements: [{ type: "button", label: rec ? "Share again" : "Share now", action_id: "share_now", value: contentId }] },
		],
	};
}

// ── Plugin definition ──

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterPublish": {
			timeout: 25000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const cfg = await getConfig(ctx);
				const wanted = cfg.collections.split(",").map((s) => s.trim()).filter(Boolean);
				if (!cfg.enabled || !wanted.includes(event.collection)) return;
				await share(ctx, event.content, event.collection);
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const i = routeCtx.input as { type?: string; page?: string; action_id?: string; values?: Record<string, unknown> };
				if (i.type === "page_load" && i.page === "widget:status") return statusWidget(ctx);
				if (i.type === "page_load" && i.page === "/settings") return settingsPage(ctx);
				if (i.type === "form_submit" && i.action_id === "save_settings") return saveSettings(ctx, i.values ?? {});
				return { blocks: [] };
			},
		},
		"editor/share": {
			handler: async (routeCtx, ctx) => {
				const i = routeCtx.input as { type?: string; action_id?: string; value?: string; contentId?: string; collection?: string };
				const contentId = String(i.contentId ?? i.value ?? "");
				if (!contentId) return { blocks: [] };
				if (i.type === "block_action" && i.action_id === "share_now") {
					const collection = i.collection ?? "posts";
					const content = await ctx.content!.get(collection, contentId);
					if (content) await share(ctx, content, collection, { force: true });
				}
				return sharePanel(ctx, contentId);
			},
		},
	},
} satisfies SandboxedPlugin;

export default plugin;
