import { describe, expect, it, vi, afterEach } from "vitest";
import { extractHandleFromUrl } from "../profile-url";
import { cleanUsername } from "../clean";
import { getPlatform } from "$lib/social/platform";
import { extractUsernameFromImage } from "$lib/server/ai/extract";

/**
 * Profile-URL inputs (OCR / VLM output) must be unwrapped BEFORE the
 * benchmark-frozen cleaners run. Without the unwrap step the cleaner deletes the
 * URL syntax and stores `httpsinstagram.comrahi.khan` as a HIGH-confidence lead.
 */
describe("extractHandleFromUrl", () => {
    it("fixes the reported bug: https://instagram.com/rahi.khan", () => {
        // The frozen cleaner still mangles raw URLs — that contract is unchanged.
        expect(cleanUsername("https://instagram.com/rahi.khan")).toBe("httpsinstagram.comrahi.khan");
        // The pre-clean step is what recovers the real handle.
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan")).toBe("rahi.khan");
    });

    it("unwraps every supported host", () => {
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://tiktok.com/@mrbeast")).toBe("mrbeast");
        expect(extractHandleFromUrl("https://youtube.com/@mrbeast")).toBe("mrbeast");
        expect(extractHandleFromUrl("https://facebook.com/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://fb.com/rahi.khan")).toBe("rahi.khan");
    });

    it("accepts a bare known host without a scheme", () => {
        expect(extractHandleFromUrl("tiktok.com/@mrbeast")).toBe("mrbeast");
        expect(extractHandleFromUrl("instagram.com/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("youtube.com/@mrbeast")).toBe("mrbeast");
    });

    it("strips www./m./mobile. host prefixes", () => {
        expect(extractHandleFromUrl("www.instagram.com/foo/")).toBe("foo");
        expect(extractHandleFromUrl("m.instagram.com/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("mobile.facebook.com/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://www.m.instagram.com/rahi.khan")).toBe("rahi.khan");
    });

    it("ignores trailing slashes, query strings and hash fragments", () => {
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan/")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan?igsh=abc123")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://www.tiktok.com/@mrbeast?si=xyz")).toBe("mrbeast");
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan#followers")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://instagram.com/?igsh=abc")).toBeNull();
    });

    it("decodes percent-encoding and strips a leading @", () => {
        expect(extractHandleFromUrl("https://instagram.com/rahi%2Ekhan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://tiktok.com/%40mrbeast")).toBe("mrbeast");
        expect(extractHandleFromUrl("https://instagram.com/@rahi.khan")).toBe("rahi.khan");
    });

    it("returns null when the URL carries no usable handle", () => {
        expect(extractHandleFromUrl("https://instagram.com")).toBeNull();
        expect(extractHandleFromUrl("https://instagram.com/")).toBeNull();
        expect(extractHandleFromUrl("https://instagram.com/?igsh=abc")).toBeNull();
        expect(extractHandleFromUrl("")).toBeNull();
        expect(extractHandleFromUrl(null)).toBeNull();
        expect(extractHandleFromUrl(undefined)).toBeNull();
    });

    it("does not treat site-chrome routes as handles", () => {
        expect(extractHandleFromUrl("https://instagram.com/p/Cabc123")).toBeNull();
        expect(extractHandleFromUrl("https://youtube.com/watch?v=abc")).toBeNull();
        expect(extractHandleFromUrl("https://tiktok.com/video/123")).toBeNull();
    });

    it("keeps YouTube's legacy /channel, /c and /user routes working", () => {
        expect(extractHandleFromUrl("https://youtube.com/channel/UCabc123")).toBe("UCabc123");
        expect(extractHandleFromUrl("https://youtube.com/c/rahi.khan")).toBe("rahi.khan");
        expect(extractHandleFromUrl("https://youtube.com/user/rahi.khan")).toBe("rahi.khan");
    });

    it("cuts trailing OCR page text after the URL", () => {
        expect(extractHandleFromUrl("https://instagram.com/rahi.khan 1.2k followers")).toBe("rahi.khan");
        expect(extractHandleFromUrl("(https://instagram.com/rahi.khan)")).toBe("rahi.khan");
    });

    it("leaves plain handles alone", () => {
        expect(extractHandleFromUrl("rahi.khan")).toBeNull();
        expect(extractHandleFromUrl("@rahi.khan")).toBeNull();
        expect(extractHandleFromUrl("rahi_khan.2025")).toBeNull();
        expect(cleanUsername("rahi.khan")).toBe("rahi.khan");
    });

    it("does not mistake prose mentioning a platform for a URL", () => {
        expect(extractHandleFromUrl("instagram is fun")).toBeNull();
        expect(extractHandleFromUrl("follow me on instagram")).toBeNull();
        expect(extractHandleFromUrl("my instagram: rahi.khan")).toBeNull();
        expect(extractHandleFromUrl("https://notinstagram.com/rahi.khan")).toBeNull();
        expect(extractHandleFromUrl("https://instagram.com.evil.test/rahi.khan")).toBeNull();
        // ...and the cleaner's legacy output for that prose is unchanged.
        expect(cleanUsername("follow me on instagram")).toBe("followmeoninstagram");
    });
});

describe("platform cleaners behind the unwrap step", () => {
    it("produce the handle for URL input when fed through extractHandleFromUrl", () => {
        for (const platform of ["instagram", "tiktok", "youtube", "facebook"] as const) {
            const url = getPlatform(platform).buildProfileUrl("rahi.khan");
            const cleaned = getPlatform(platform).cleanHandle(extractHandleFromUrl(url) ?? url);
            expect(cleaned).toBe("rahi.khan");
        }
    });
});

describe("extractUsernameFromImage — URL output from the model", () => {
    const creds = { accountId: "acc", apiToken: "tok" };
    afterEach(() => vi.unstubAllGlobals());

    function mockRest(inner: unknown) {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ success: true, result: inner })
            }))
        );
    }

    it("stores the handle (not the mangled URL) end to end for an Instagram URL", async () => {
        mockRest({ response: '{"platform":"instagram","username":"https://instagram.com/rahi.khan","kind":"handle"}' });
        const result = await extractUsernameFromImage({ creds, imageBytes: new Uint8Array([1]) });

        expect(result.username).toBe("rahi.khan");
        expect(result.username).not.toBe("httpsinstagram.comrahi.khan");
        expect(result.profileUrl).toBe("https://instagram.com/rahi.khan");
        expect(result.confidence).toBe(95);
        expect(result.tier).toBe("HIGH");
        expect(result.status).toBe("verified");
    });

    it("handles a bare TikTok URL returned without JSON", async () => {
        mockRest({ response: "tiktok.com/@mrbeast" });
        const result = await extractUsernameFromImage({ creds, imageBytes: new Uint8Array([1]) });

        // A bare string has no platform tag, so it lands on `other` (no profile URL) —
        // but the URL is still unwrapped instead of stored mangled.
        expect(result.platform).toBe("other");
        expect(result.username).toBe("mrbeast");
        expect(result.profileUrl).toBeNull();
    });

    it("builds the canonical profile URL for a TikTok URL with a platform tag", async () => {
        mockRest({
            response: '{"platform":"tiktok","username":"https://www.tiktok.com/@mrbeast?si=xyz","kind":"handle"}'
        });
        const result = await extractUsernameFromImage({ creds, imageBytes: new Uint8Array([1]) });

        expect(result.username).toBe("mrbeast");
        expect(result.profileUrl).toBe("https://www.tiktok.com/@mrbeast");
    });

    it("treats a URL tagged as a display name as a handle", async () => {
        mockRest({ response: '{"platform":"youtube","username":"www.youtube.com/@rahi.khan","kind":"display_name"}' });
        const result = await extractUsernameFromImage({ creds, imageBytes: new Uint8Array([1]) });

        expect(result.username).toBe("rahi.khan");
        expect(result.kind).toBe("handle");
        expect(result.profileUrl).toBe("https://www.youtube.com/@rahi.khan");
    });

    it("still falls back to the old behaviour for a URL with no handle", async () => {
        mockRest({ response: '{"platform":"instagram","username":"https://instagram.com/","kind":"handle"}' });
        const result = await extractUsernameFromImage({ creds, imageBytes: new Uint8Array([1]) });

        // No handle to unwrap → the frozen cleaner sees the raw text, exactly as before.
        expect(cleanUsername("https://instagram.com/")).toBe("httpsinstagram.com");
        expect(result.username).toBe("httpsinstagram.com");
    });
});
