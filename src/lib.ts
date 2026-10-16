// Pure helpers: no ctx, no network. Everything here is unit-tested.

export const API_BASE = "https://app.bulkpublish.com";
export const DEFAULT_TEMPLATE = "{title}\n\n{url}";

export interface Channel {
	id: number;
	platform: string;
	name?: string;
	username?: string;
}

export interface ShareRecord {
	contentId: string;
	collection: string;
	postId: number | null;
	status: "sent" | "failed";
	error?: string;
	createdAt: string;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pull a display title out of whatever fields the collection has. */
export function titleOf(data: unknown): string {
	if (!isRecord(data)) return "";
	for (const k of ["title", "name", "headline"]) {
		if (typeof data[k] === "string" && data[k]) return data[k] as string;
	}
	return "";
}

export function excerptOf(data: unknown, max = 200): string {
	if (!isRecord(data)) return "";
	for (const k of ["excerpt", "description", "summary"]) {
		if (typeof data[k] === "string" && data[k]) return truncate(data[k] as string, max);
	}
	return "";
}

export function truncate(s: string, max: number): string {
	const t = s.trim();
	return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

export function postUrl(siteUrl: string, collection: string, slug: string): string {
	const base = siteUrl.replace(/\/+$/, "");
	return `${base}/${collection}/${encodeURIComponent(slug)}`;
}

/** {title} {url} {excerpt} tokens; unknown tokens are left as typed. */
export function renderCaption(
	template: string,
	vars: { title: string; url: string; excerpt: string },
): string {
	return template
		.replace(/\{(title|url|excerpt)\}/g, (_, k: keyof typeof vars) => vars[k])
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function parseChannelIds(v: unknown): number[] {
	const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
	const ids = raw.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0);
	return [...new Set(ids)];
}

/** Body for POST /api/posts. Publish-now = create draft, then /publish. */
export function buildPostBody(caption: string, channels: Channel[], ids: number[]) {
	const byId = new Map(channels.map((c) => [c.id, c]));
	return {
		content: caption,
		status: "draft" as const,
		channels: ids
			.filter((id) => byId.has(id))
			.map((id) => ({ channelId: id, platform: byId.get(id)!.platform })),
	};
}

/** Turn an API error body into one sentence a site editor can act on. */
export function apiError(status: number, body: unknown): string {
	const msg =
		isRecord(body) && typeof body.error === "string"
			? body.error
			: isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
				? body.error.message
				: "";
	if (status === 401) return "Your BulkPublish API key was rejected. Paste a new one in Settings.";
	if (status === 402 || status === 429) return msg || "You've reached your plan's posting limit.";
	return msg || `BulkPublish returned an error (${status}).`;
}
