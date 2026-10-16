import { describe, expect, it } from "vitest";
import { apiError, buildPostBody, parseChannelIds, renderCaption, titleOf, truncate } from "../src/lib";

describe("caption", () => {
	it("fills tokens and collapses blank runs", () => {
		expect(renderCaption("{title}\n\n\n\n{excerpt}\n{url}", { title: "Hi", excerpt: "", url: "https://x.dev/p" })).toBe("Hi\n\nhttps://x.dev/p");
	});
	it("leaves unknown tokens alone", () => {
		expect(renderCaption("{title} {foo}", { title: "A", excerpt: "", url: "" })).toBe("A {foo}");
	});
	it("truncates with an ellipsis", () => {
		expect(truncate("abcdef", 4)).toBe("abc…");
	});
	it("finds a title field", () => {
		expect(titleOf({ name: "N" })).toBe("N");
		expect(titleOf(null)).toBe("");
	});
});

describe("body", () => {
	it("dedupes ids and drops channels that are gone", () => {
		expect(parseChannelIds(["3", 3, "x", "4"])).toEqual([3, 4]);
		const body = buildPostBody("c", [{ id: 3, platform: "x" }], [3, 4]);
		expect(body).toEqual({ content: "c", status: "draft", channels: [{ channelId: 3, platform: "x" }] });
	});
});

describe("errors", () => {
	it("reads both error shapes", () => {
		expect(apiError(400, { error: "bad" })).toBe("bad");
		expect(apiError(400, { error: { message: "worse" } })).toBe("worse");
		expect(apiError(401, {})).toMatch(/API key/);
	});
});
