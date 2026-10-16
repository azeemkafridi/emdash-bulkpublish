import { describe, expect, it } from "vitest";

import {
	apiError,
	buildPostBody,
	captionFor,
	excerptOf,
	imageOf,
	looksLikeKey,
	multipartFile,
	normalizeApiBase,
	parseChannel,
	parseChannelIds,
	parseCollections,
	planTargets,
	platformLength,
	renderCaption,
	titleOf,
	truncate,
} from "../src/lib";

const vars = { title: "Hello", excerpt: "", url: "https://x.dev/p" };

describe("caption", () => {
	it("fills tokens and collapses the blank lines an empty token leaves", () => {
		expect(renderCaption("{title}\n\n{excerpt}\n\n{url}", vars)).toBe("Hello\n\nhttps://x.dev/p");
	});
	it("leaves unknown tokens alone", () => {
		expect(renderCaption("{title} {foo}", vars)).toBe("Hello {foo}");
	});
	it("truncates on a word boundary with an ellipsis", () => {
		expect(truncate("one two three four five", 12)).toBe("one two…");
		expect(truncate("abcdef", 4)).toBe("abc…");
		expect(truncate("short", 10)).toBe("short");
	});
	it("does not split an emoji", () => {
		expect(truncate("😀😀😀😀😀", 3)).toBe("😀😀…");
	});
	it("counts links as 23 on X and Mastodon only", () => {
		const t = `hi https://example.com/${"a".repeat(100)}`;
		expect(platformLength(t, "x")).toBe(3 + 23);
		expect(platformLength(t, "bluesky")).toBe([...t].length);
	});
	it("drops the excerpt first, then shortens the title, never the link", () => {
		const long = { title: "T".repeat(50), excerpt: "E".repeat(260), url: "https://x.dev/p" };
		expect(captionFor("x", "{title}\n\n{excerpt}\n\n{url}", long)).toBe(`${"T".repeat(50)}\n\nhttps://x.dev/p`);
		const huge = { title: "word ".repeat(100).trim(), excerpt: "", url: "https://x.dev/p" };
		const out = captionFor("bluesky", "{title}\n\n{url}", huge);
		expect([...out].length).toBeLessThanOrEqual(300);
		expect(out.endsWith("…\n\nhttps://x.dev/p")).toBe(true);
	});
	it("leaves networks without a limit alone", () => {
		const big = { ...vars, title: "x".repeat(5000) };
		expect(captionFor("facebook", "{title}", big)).toHaveLength(5000);
	});
});

describe("content", () => {
	it("finds a title field", () => {
		expect(titleOf({ name: "N" })).toBe("N");
		expect(titleOf({ title: "  ", headline: "H" })).toBe("H");
		expect(titleOf(null)).toBe("");
	});
	it("falls back from excerpt to SEO to the body", () => {
		expect(excerptOf({ excerpt: "E" }, 200, "S")).toBe("E");
		expect(excerptOf({}, 200, "S")).toBe("S");
		const body = [
			{ _type: "block", children: [{ _type: "span", text: "First" }, { _type: "span", text: " para." }] },
			{ _type: "image" },
			{ _type: "block", children: [{ _type: "span", text: "Second." }] },
		];
		expect(excerptOf({ content: body })).toBe("First para. Second.");
	});
	it("finds the featured image by name, by convention, or by shape", () => {
		const img = { provider: "local", id: "M1", mimeType: "image/png", filename: "a.png" };
		expect(imageOf({ featured_image: img })?.id).toBe("M1");
		expect(imageOf({ random: img })?.id).toBe("M1");
		expect(imageOf({ hero: img, cover: { ...img, id: "M2" } }, "hero")?.id).toBe("M1");
		expect(imageOf({ hero: img }, "missing")).toBeNull();
	});
	it("ignores SVGs, videos and empty fields", () => {
		expect(imageOf({ image: { id: "M", mimeType: "image/svg+xml" } })).toBeNull();
		expect(imageOf({ image: { id: "M", mimeType: "video/mp4" } })).toBeNull();
		expect(imageOf({ image: null, title: "x" })).toBeNull();
	});
});

describe("channels", () => {
	it("reads the API's channel shape and flags unusable ones", () => {
		expect(parseChannel({ id: 1, platform: "x", accountName: "Me" })).toEqual({ id: 1, platform: "x", name: "Me", usable: true, problem: undefined });
		expect(parseChannel({ id: 2, platform: "x", needsReconnect: true })?.problem).toMatch(/reconnect/);
		expect(parseChannel({ id: 3, platform: "x", isActive: false })?.usable).toBe(false);
		expect(parseChannel({ id: 4, platform: "x", platformAvailable: false })?.usable).toBe(false);
		expect(parseChannel({ id: "nope", platform: "x" })).toBeNull();
	});
	it("dedupes ids and collections", () => {
		expect(parseChannelIds(["3", 3, "x", "4", -1])).toEqual([3, 4]);
		expect(parseChannelIds("5, 6,5")).toEqual([5, 6]);
		expect(parseCollections(" posts, news ,posts,")).toEqual(["posts", "news"]);
	});
	it("plans targets around media needs", () => {
		const ch = [
			{ id: 1, platform: "instagram", name: "ig", usable: true },
			{ id: 2, platform: "tiktok", name: "tt", usable: true },
			{ id: 3, platform: "x", name: "x", usable: true },
		];
		expect(planTargets(ch, [1, 2, 3], false).targets.map((t) => t.id)).toEqual([3]);
		expect(planTargets(ch, [1, 2, 3], true).targets.map((t) => t.id)).toEqual([1, 3]);
	});
	it("builds a post body with per-network extras only where needed", () => {
		const t = [
			{ id: 1, platform: "threads", name: "t", usable: true },
			{ id: 2, platform: "linkedin", name: "l", usable: true },
		];
		expect(buildPostBody(t, "{title}", vars, null)).toEqual({
			content: "Hello",
			status: "draft",
			channels: [
				{ channelId: 1, platform: "threads" },
				{ channelId: 2, platform: "linkedin" },
			],
		});
		expect(buildPostBody(t, "{title}", vars, 9)).toMatchObject({ mediaFiles: [9], postTypeOverrides: { threads: "image" } });
	});
});

describe("http", () => {
	it("reads both error shapes and names the common statuses", () => {
		expect(apiError(400, { error: "bad" })).toBe("bad");
		expect(apiError(400, { error: { message: "worse", hint: "Try X." } })).toBe("worse Try X.");
		expect(apiError(401, {})).toMatch(/API key/);
		expect(apiError(502, null)).toMatch(/trouble/);
		expect(apiError(418, null)).toMatch(/418/);
	});
	it("accepts only https API addresses", () => {
		expect(normalizeApiBase("")).toBe("https://app.bulkpublish.com");
		expect(normalizeApiBase("http://localhost:4322")).toBe("https://app.bulkpublish.com");
		expect(normalizeApiBase("not a url")).toBe("https://app.bulkpublish.com");
		expect(normalizeApiBase("https://staging.example.com/api")).toBe("https://staging.example.com");
	});
	it("recognises key format", () => {
		expect(looksLikeKey("bp_" + "a1".repeat(10))).toBe(true);
		expect(looksLikeKey("sk_live_123")).toBe(false);
	});
	it("frames a file as multipart and escapes the filename", () => {
		const { body, contentType } = multipartFile({ bytes: new Uint8Array([1, 2, 3]), filename: 'a"b\r\n.jpg', mimeType: "image/jpeg" });
		const boundary = contentType.split("boundary=")[1];
		const text = new TextDecoder().decode(body);
		expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
		expect(text).toContain('filename="a_b__.jpg"');
		expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
		expect(body.length).toBe(text.length);
	});
});
