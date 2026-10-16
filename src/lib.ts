// Pure helpers: no ctx, no network. Everything here is unit-tested.

export const DEFAULT_API_BASE = "https://app.bulkpublish.com";
export const DEFAULT_TEMPLATE = "{title}\n\n{excerpt}\n\n{url}";
/** A claim older than this is a share that died mid-flight; it may be retried. */
export const STALE_CLAIM_MS = 2 * 60 * 1000;
/** The sandbox buffers request bodies at 8 MiB; leave room for the multipart frame. */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

export interface Channel {
	id: number;
	platform: string;
	name: string;
	usable: boolean;
	/** Why a channel can't be used right now, in words for the editor. */
	problem?: string;
}

export interface Skipped {
	channelId: number;
	platform: string;
	reason: string;
}

export interface ShareRecord {
	contentId: string;
	collection: string;
	title: string;
	postId: number | null;
	status: "pending" | "sent" | "failed";
	error?: string;
	skipped?: Skipped[];
	sentTo?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface ImageRef {
	id: string;
	mimeType: string;
	filename: string;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Reading content ──

/** Pull a display title out of whatever fields the collection has. */
export function titleOf(data: unknown): string {
	if (!isRecord(data)) return "";
	for (const k of ["title", "name", "headline"]) {
		const v = data[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/** Plain text of a Portable Text array (blocks → spans). */
export function portableTextToPlain(v: unknown): string {
	if (!Array.isArray(v)) return "";
	const parts: string[] = [];
	for (const block of v) {
		if (!isRecord(block) || block._type !== "block" || !Array.isArray(block.children)) continue;
		const text = block.children
			.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
			.join("");
		if (text.trim()) parts.push(text.trim());
	}
	return parts.join(" ");
}

/** The entry's excerpt, its SEO description, or the opening of its body. */
export function excerptOf(data: unknown, max = 200, seoDescription?: string | null): string {
	if (!isRecord(data)) return seoDescription ? truncate(seoDescription, max) : "";
	for (const k of ["excerpt", "description", "summary"]) {
		const v = data[k];
		if (typeof v === "string" && v.trim()) return truncate(v, max);
	}
	if (seoDescription && seoDescription.trim()) return truncate(seoDescription, max);
	for (const k of ["content", "body"]) {
		const v = data[k];
		const plain = typeof v === "string" ? v : portableTextToPlain(v);
		if (plain.trim()) return truncate(plain, max);
	}
	return "";
}

function asImage(v: unknown): ImageRef | null {
	if (!isRecord(v) || typeof v.id !== "string" || !v.id) return null;
	const mime = typeof v.mimeType === "string" ? v.mimeType : "";
	if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
	return { id: v.id, mimeType: mime, filename: typeof v.filename === "string" && v.filename ? v.filename : "image" };
}

/**
 * The entry's featured image: the named field if one is configured, else
 * the conventional names, else the first image-valued field.
 */
export function imageOf(data: unknown, field?: string): ImageRef | null {
	if (!isRecord(data)) return null;
	if (field && field.trim()) return asImage(data[field.trim()]);
	for (const k of ["featured_image", "featuredImage", "image", "cover", "cover_image", "hero", "thumbnail"]) {
		const img = asImage(data[k]);
		if (img) return img;
	}
	for (const v of Object.values(data)) {
		const img = asImage(v);
		if (img) return img;
	}
	return null;
}

// ── Captions ──

export function truncate(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	if ([...t].length <= max) return t;
	if (max <= 1) return "…";
	const cut = [...t].slice(0, max - 1).join("");
	const space = cut.lastIndexOf(" ");
	return (space >= max * 0.5 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/** {title} {url} {excerpt} tokens; unknown tokens are left as typed. */
export function renderCaption(
	template: string,
	vars: { title: string; url: string; excerpt: string },
): string {
	return template
		.replace(/\{(title|url|excerpt)\}/g, (_, k: keyof typeof vars) => vars[k])
		.split("\n")
		.map((l) => l.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Caption limits we check before sending, so one network can't reject the whole post. */
export const CHAR_LIMITS: Record<string, number> = {
	x: 280,
	bluesky: 300,
	threads: 500,
	mastodon: 500,
	pinterest: 500,
	snapchat: 160,
	gmb: 1500,
	discord: 2000,
	instagram: 2200,
	tiktok: 2200,
	linkedin: 3000,
	telegram: 4096,
};

const URL_RE = /https?:\/\/\S+/g;

/** Length as the network counts it: X and Mastodon count every link as 23. */
export function platformLength(text: string, platform: string): number {
	const n = [...text].length;
	if (platform !== "x" && platform !== "mastodon") return n;
	let len = n;
	for (const m of text.match(URL_RE) ?? []) len += 23 - [...m].length;
	return len;
}

/**
 * The caption for one network: the full one if it fits, else the template
 * without the excerpt, else a shortened title with the link kept whole.
 */
export function captionFor(
	platform: string,
	template: string,
	vars: { title: string; url: string; excerpt: string },
): string {
	const full = renderCaption(template, vars);
	const limit = CHAR_LIMITS[platform];
	if (!limit || platformLength(full, platform) <= limit) return full;
	const noExcerpt = renderCaption(template, { ...vars, excerpt: "" });
	if (platformLength(noExcerpt, platform) <= limit) return noExcerpt;
	const link = vars.url ? `\n\n${vars.url}` : "";
	const room = limit - platformLength(link, platform);
	return room > 0 ? `${truncate(vars.title, room)}${link}`.trim() : truncate(vars.title, limit);
}

// ── Channels and networks ──

/** What each network's default post needs. Networks not listed take text alone. */
const MEDIA_RULES: Record<string, "image" | "video"> = {
	instagram: "image",
	pinterest: "image",
	snapchat: "image",
	tiktok: "video",
	youtube: "video",
};

/** Post type to request when an image is attached, where the default type is text-only. */
const IMAGE_POST_TYPE: Record<string, string> = { threads: "image" };

export function needs(platform: string): "image" | "video" | null {
	return MEDIA_RULES[platform] ?? null;
}

export function parseChannel(raw: unknown): Channel | null {
	if (!isRecord(raw)) return null;
	const id = Number(raw.id);
	if (!Number.isInteger(id) || typeof raw.platform !== "string") return null;
	const name =
		(typeof raw.accountName === "string" && raw.accountName) ||
		(typeof raw.name === "string" && raw.name) ||
		`#${id}`;
	let problem: string | undefined;
	if (raw.isActive === false) problem = "is turned off in BulkPublish";
	else if (raw.needsReconnect === true || raw.tokenStatus === "expired") problem = "needs reconnecting in BulkPublish";
	else if (raw.platformAvailable === false) problem = "can't be posted to right now";
	return { id, platform: raw.platform, name, usable: !problem, problem };
}

export function parseChannelIds(v: unknown): number[] {
	const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
	const ids = raw.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0);
	return [...new Set(ids)];
}

export function parseCollections(v: unknown): string[] {
	const raw = typeof v === "string" ? v : "posts";
	return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

export function platformLabel(p: string): string {
	const names: Record<string, string> = {
		x: "X", gmb: "Google Business", linkedin: "LinkedIn", tiktok: "TikTok", youtube: "YouTube",
	};
	return names[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Decide which chosen channels this post can go to, and why the rest can't.
 * `hasImage` is whether an image will be attached.
 */
export function planTargets(channels: Channel[], ids: number[], hasImage: boolean) {
	const byId = new Map(channels.map((c) => [c.id, c]));
	const targets: Channel[] = [];
	const skipped: Skipped[] = [];
	for (const id of ids) {
		const c = byId.get(id);
		if (!c) {
			skipped.push({ channelId: id, platform: "unknown", reason: "is no longer connected" });
			continue;
		}
		if (!c.usable) {
			skipped.push({ channelId: id, platform: c.platform, reason: c.problem ?? "can't be used" });
			continue;
		}
		const need = needs(c.platform);
		if (need === "video") {
			skipped.push({ channelId: id, platform: c.platform, reason: "only takes videos" });
			continue;
		}
		if (need === "image" && !hasImage) {
			skipped.push({ channelId: id, platform: c.platform, reason: "needs an image and this post has none" });
			continue;
		}
		targets.push(c);
	}
	return { targets, skipped };
}

/** Body for POST /api/posts. Publish-now = create draft, then /publish. */
export function buildPostBody(
	targets: Channel[],
	template: string,
	vars: { title: string; url: string; excerpt: string },
	mediaId: number | null,
) {
	const platforms = [...new Set(targets.map((t) => t.platform))];
	const fitted = new Map(platforms.map((p) => [p, captionFor(p, template, vars)]));
	// BulkPublish checks the main caption against every destination's limit,
	// even one that has its own caption. So the main caption is the version
	// that fits everywhere, and networks with room get the full one.
	const fitsAll = (text: string) =>
		platforms.every((p) => !CHAR_LIMITS[p] || platformLength(text, p) <= CHAR_LIMITS[p]);
	const candidates = [renderCaption(template, vars), ...fitted.values()];
	const content =
		candidates.find(fitsAll) ??
		candidates.reduce((a, b) => ([...a].length <= [...b].length ? a : b));
	const platformContent: Record<string, string> = {};
	const postTypeOverrides: Record<string, string> = {};
	for (const p of platforms) {
		if (fitted.get(p) !== content) platformContent[p] = fitted.get(p)!;
		if (mediaId !== null && IMAGE_POST_TYPE[p]) postTypeOverrides[p] = IMAGE_POST_TYPE[p];
	}
	return {
		content,
		status: "draft" as const,
		channels: targets.map((t) => ({ channelId: t.id, platform: t.platform })),
		...(mediaId !== null ? { mediaFiles: [mediaId] } : {}),
		...(Object.keys(platformContent).length ? { platformContent } : {}),
		...(Object.keys(postTypeOverrides).length ? { postTypeOverrides } : {}),
	};
}

// ── HTTP ──

/** Turn an API error body into one sentence a site editor can act on. */
export function apiError(status: number, body: unknown): string {
	let msg = "";
	if (isRecord(body)) {
		if (typeof body.error === "string") msg = body.error;
		else if (isRecord(body.error) && typeof body.error.message === "string") {
			msg = body.error.message;
			if (typeof body.error.hint === "string") msg += ` ${body.error.hint}`;
		} else if (typeof body.message === "string") msg = body.message;
	}
	if (status === 401) return "BulkPublish didn't accept the API key. Check it, or create a new one in BulkPublish.";
	if (status === 403 && !msg) return "This API key isn't allowed to do that.";
	if (status === 402 || status === 429) return msg || "You've reached your BulkPublish plan's limit.";
	if (status >= 500) return "BulkPublish is having trouble right now. Try again in a few minutes.";
	return msg || `BulkPublish returned an error (${status}).`;
}

export function normalizeApiBase(v: unknown): string {
	if (typeof v !== "string" || !v.trim()) return DEFAULT_API_BASE;
	try {
		const u = new URL(v.trim());
		// The plugin sandbox refuses private and loopback hosts, so only a
		// public https address can ever be reached.
		if (u.protocol !== "https:") return DEFAULT_API_BASE;
		return u.origin;
	} catch {
		return DEFAULT_API_BASE;
	}
}

export function looksLikeKey(v: string): boolean {
	return /^bp_[A-Za-z0-9_-]{16,}$/.test(v.trim());
}

/**
 * A multipart/form-data body built by hand, so it crosses the sandbox's
 * request bridge as plain bytes.
 */
export function multipartFile(file: { bytes: Uint8Array; filename: string; mimeType: string }) {
	const boundary = `----bp${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	const safeName = file.filename.replace(/["\r\n\\]/g, "_");
	const head = new TextEncoder().encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
	);
	const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
	const body = new Uint8Array(new ArrayBuffer(head.length + file.bytes.length + tail.length));
	body.set(head, 0);
	body.set(file.bytes, head.length);
	body.set(tail, head.length + file.bytes.length);
	return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
