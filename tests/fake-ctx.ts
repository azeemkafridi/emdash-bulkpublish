// A small in-memory stand-in for the EmDash plugin context. Response shapes
// for the BulkPublish API were captured from a running server.

import { CHAR_LIMITS, platformLength } from "../src/lib";

/**
 * The length check POST /api/posts runs: the main caption against EVERY
 * destination (overrides or not), then each override against its own network.
 */
export function serverLengthErrors(body: { content?: string; channels: { platform: string }[]; platformContent?: Record<string, string> }) {
	const errors: string[] = [];
	for (const { platform } of body.channels) {
		const limit = CHAR_LIMITS[platform];
		const len = platformLength(body.content ?? "", platform);
		if (limit && len > limit) errors.push(`${platform}: content exceeds ${limit} character limit (${len})`);
	}
	for (const [platform, text] of Object.entries(body.platformContent ?? {})) {
		const limit = CHAR_LIMITS[platform];
		const len = platformLength(text, platform);
		if (limit && len > limit) errors.push(`${platform}: content exceeds ${limit} character limit (${len})`);
	}
	return errors;
}

export interface Call {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}

type Handler = (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export const CHANNELS = [
	{ id: 308, platform: "bluesky", accountName: "Test Bluesky", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 309, platform: "linkedin", accountName: "Test LinkedIn", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 310, platform: "instagram", accountName: "Test IG", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 311, platform: "threads", accountName: "Test Threads", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 312, platform: "x", accountName: "Test X", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 313, platform: "youtube", accountName: "Test YT", isActive: true, needsReconnect: false, tokenStatus: "valid", platformAvailable: true },
	{ id: 314, platform: "facebook", accountName: "Old Page", isActive: true, needsReconnect: true, tokenStatus: "expired", platformAvailable: true },
];

/** Default routes: everything succeeds. Override per test. */
export function defaultRoutes(): Record<string, Handler> {
	let nextPost = 2000;
	return {
		"GET /api/channels": () => ({ status: 200, body: { channels: CHANNELS } }),
		"POST /api/media": () => ({ status: 201, body: { file: { id: 125, fileName: "x.jpg", mimeType: "image/jpeg" } } }),
		"POST /api/posts": (call) => {
			const errors = serverLengthErrors(call.body as never);
			if (errors.length) return { status: 400, body: { error: { message: errors.join("; "), code: "VALIDATION_ERROR" } } };
			return { status: 201, body: { id: ++nextPost, status: "draft" } };
		},
		"POST /api/posts/:id/publish": () => ({ status: 200, body: { success: true } }),
		"DELETE /api/posts/:id": () => ({ status: 200, body: { success: true } }),
	};
}

function routeKey(method: string, path: string) {
	return `${method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id")}`;
}

export function fakeCtx(opts: {
	settings?: Record<string, unknown>;
	kv?: Record<string, unknown>;
	routes?: Record<string, Handler>;
	content?: Record<string, Record<string, unknown>>;
	media?: Record<string, { bytes: Uint8Array; filename: string; mimeType: string; size: number }>;
	noHttp?: boolean;
} = {}) {
	const settings = new Map(Object.entries(opts.settings ?? {}));
	const kv = new Map(Object.entries(opts.kv ?? {}));
	const routes = { ...defaultRoutes(), ...(opts.routes ?? {}) };
	const calls: Call[] = [];
	const logs: Array<{ level: string; msg: string; data?: unknown }> = [];

	const rows = new Map<string, { value: unknown; rev: number }>();
	let rev = 0;
	const matches = (data: unknown, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([k, v]) => (data as Record<string, unknown>)[k] === v);
	const shares = {
		async get(id: string) {
			return rows.get(id)?.value ?? null;
		},
		async getVersioned(id: string) {
			const r = rows.get(id);
			return r ? { value: r.value, revision: String(r.rev) } : null;
		},
		async compareAndSet(id: string, expected: string | null, value: unknown) {
			const cur = rows.get(id);
			if ((cur ? String(cur.rev) : null) !== expected) return { applied: false };
			rows.set(id, { value, rev: ++rev });
			return { applied: true, revision: String(rev) };
		},
		async put(id: string, value: unknown) {
			rows.set(id, { value, rev: ++rev });
		},
		async count(where?: Record<string, unknown>) {
			return [...rows.values()].filter((r) => matches(r.value, where)).length;
		},
		async query(q: { limit?: number; orderBy?: Record<string, "asc" | "desc"> } = {}) {
			let items = [...rows.entries()].map(([id, r]) => ({ id, data: r.value }));
			const [key, dir] = Object.entries(q.orderBy ?? {})[0] ?? [];
			if (key) items.sort((a, b) => String((a.data as never)[key]).localeCompare(String((b.data as never)[key])) * (dir === "desc" ? -1 : 1));
			items = items.slice(0, q.limit ?? 50);
			return { items, hasMore: false };
		},
		async deleteMany(ids: string[]) {
			let n = 0;
			for (const id of ids) if (rows.delete(id)) n++;
			return n;
		},
	};

	const ctx = {
		settings: {
			get: async (k: string) => (settings.has(k) ? settings.get(k) : null),
			set: async (k: string, v: unknown) => void settings.set(k, v),
			delete: async (k: string) => settings.delete(k),
		},
		kv: {
			get: async (k: string) => (kv.has(k) ? kv.get(k) : null),
			set: async (k: string, v: unknown) => void kv.set(k, v),
			delete: async (k: string) => kv.delete(k),
		},
		storage: { shares },
		log: {
			info: (msg: string, data?: unknown) => logs.push({ level: "info", msg, data }),
			warn: (msg: string, data?: unknown) => logs.push({ level: "warn", msg, data }),
			error: (msg: string, data?: unknown) => logs.push({ level: "error", msg, data }),
			debug: () => undefined,
		},
		url: (p: string) => `https://blog.test${p}`,
		site: { name: "Test", url: "https://blog.test", locale: "en" },
		content: {
			get: async (collection: string, id: string) => opts.content?.[`${collection}/${id}`] ?? null,
			getPublicUrl: async (collection: string, id: string) => {
				const c = opts.content?.[`${collection}/${id}`];
				return c ? `/${collection}/${c.slug}` : null;
			},
		},
		media: {
			readBytes: async (id: string, o?: { maxBytes?: number }) => {
				const m = opts.media?.[id];
				if (!m) throw new Error("not found");
				if (o?.maxBytes && m.size > o.maxBytes) throw new Error("too large");
				return m;
			},
		},
		http: opts.noHttp
			? undefined
			: {
					fetch: async (url: string, init: RequestInit = {}) => {
						const u = new URL(url);
						const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
						let body: unknown = init.body;
						if (typeof body === "string") body = JSON.parse(body);
						const call = { method: init.method ?? "GET", path: u.pathname, headers, body };
						calls.push(call);
						const h = routes[routeKey(call.method, call.path)];
						if (!h) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
						const r = await h(call);
						return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
					},
				},
	};
	return { ctx: ctx as never, calls, logs, settings, kv, rows };
}

export function post(id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return { id, slug: id, status: "published", data, ...extra };
}

export const IMAGE = { provider: "local", id: "MEDIA1", mimeType: "image/jpeg", filename: "hero.jpg", width: 1200, height: 800 };
export const IMAGE_BYTES = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), filename: "hero.jpg", mimeType: "image/jpeg", size: 7 };
