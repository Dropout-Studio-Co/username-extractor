import { describe, expect, it } from "vitest";
import { cleanUsername } from "../clean";
import { isValidInstagramFormat } from "../validate";
import { getPlatform } from "$lib/social/platform";

/**
 * Normalization edge cases that the core suite does not pin: unicode folding,
 * invisible/space-like characters, separator handling, and input coming from a
 * model as a profile URL rather than a bare handle.
 */

describe("cleanUsername — unicode and invisible characters", () => {
    it("strips non-ASCII letters rather than transliterating them", () => {
        expect(cleanUsername("Café")).toBe("caf");
        expect(cleanUsername("naïve")).toBe("nave");
    });

    it("folds a Turkish dotted capital I to plain ASCII", () => {
        // "İ".toLowerCase() is "i" + U+0307 (combining dot); the combining mark is stripped.
        expect(cleanUsername("İstanbul")).toBe("istanbul");
    });

    it("removes zero-width characters and non-ASCII digits", () => {
        expect(cleanUsername("rahi\u200Bkhan")).toBe("rahikhan");
        expect(cleanUsername("٠١٢")).toBeNull();
    });

    it("treats NBSP and tabs as collapsible whitespace", () => {
        expect(cleanUsername("rahi\u00A0\t.khan")).toBe("rahi.khan");
    });

    it("tolerates a null-ish value defensively", () => {
        expect(cleanUsername(null as unknown as string)).toBeNull();
    });
});

describe("cleanUsername — separators and prefix handling", () => {
    it("removes every leading @ before validating", () => {
        expect(cleanUsername("@@rahi")).toBe("rahi");
    });

    it("preserves interior dots and underscores", () => {
        expect(cleanUsername("rahi._khan")).toBe("rahi._khan");
    });

    it("strips leading separators but keeps a trailing underscore", () => {
        expect(cleanUsername("._rahi")).toBe("rahi");
        expect(cleanUsername("rahi_")).toBe("rahi_");
        // A trailing underscore is legal on Instagram; only a trailing dot is not.
        expect(isValidInstagramFormat("rahi_")).toBe(true);
    });
});

describe("platform cleaners — shared normalization contract", () => {
    it("each cleaner lowercases, strips @ and collapses whitespace", () => {
        for (const id of ["instagram", "tiktok", "youtube", "facebook", "other"] as const) {
            const cleaned = getPlatform(id).cleanHandle("  @Rahi.Khan 2025 ");
            expect(cleaned).toBe("rahi.khan2025");
        }
    });

    it("youtube keeps hyphens while tiktok drops them", () => {
        expect(getPlatform("youtube").cleanHandle("@cool-channel")).toBe("cool-channel");
        expect(getPlatform("tiktok").cleanHandle("@cool-channel")).toBe("coolchannel");
    });
});

// URL inputs are unwrapped BEFORE the frozen cleaner (`extractHandleFromUrl`, see
// profile-url.test.ts), so `cleanUsername` keeps its benchmarked rule set verbatim
// while the pipeline still stores the real handle. This pins the split: if anyone
// "fixes" the mangling inside `cleanUsername`, the benchmark contract breaks here.
describe("cleanUsername — frozen contract for URL-shaped input", () => {
    it("still deletes URL syntax (the unwrap step runs upstream, not here)", () => {
        expect(cleanUsername("https://instagram.com/rahi.khan")).toBe("httpsinstagram.comrahi.khan");
        expect(getPlatform("tiktok").cleanHandle("tiktok.com/@mrbeast")).toBe("tiktok.commrbeast");
    });
});
