import { describe, expect, it } from "vitest";
import { parseProfileResponse } from "../parse-response";

/**
 * Malformed / partial model output. The contract is: `parseProfileResponse` NEVER
 * throws, and anything it cannot resolve degrades to the bare-string fallback on
 * `platform: "other"` so the per-platform cleaner (not the parser) rejects junk.
 */

describe("parseProfileResponse — malformed JSON", () => {
    it("never throws on truncated JSON and degrades to the bare fallback", () => {
        const text = '{"platform":"instagram","username":"john';
        const parsed = parseProfileResponse(text);
        expect(parsed.platform).toBe("other");
        expect(parsed.kind).toBe("handle");
        expect(parsed.username).toContain("john");
    });

    it("treats non-JSON braces in prose as plain text", () => {
        const text = "The handle {might} be john.doe";
        expect(parseProfileResponse(text)).toEqual({ platform: "other", username: text, kind: "handle" });
    });

    it("ignores an object with a non-string username and falls back", () => {
        const parsed = parseProfileResponse('{"platform":"instagram","username":42}');
        expect(parsed).toEqual({
            platform: "other",
            username: '{"platform":"instagram","username":42}',
            kind: "handle"
        });
    });

    it("keeps an earlier valid object when a later object has no username", () => {
        const parsed = parseProfileResponse('{"username":"first.one"} {"foo":"bar"}');
        expect(parsed).toEqual({ platform: "other", username: "first.one", kind: "handle" });
    });

    it("parses an object nested inside a JSON array", () => {
        expect(parseProfileResponse('[{"platform":"tiktok","username":"mrbeast"}]')).toEqual({
            platform: "tiktok",
            username: "mrbeast",
            kind: "handle"
        });
    });
});

describe("parseProfileResponse — alternate field names and envelopes", () => {
    it("falls back to the `name` field when username/handle are absent", () => {
        expect(parseProfileResponse('{"platform":"instagram","name":"rahi.khan"}')).toEqual({
            platform: "instagram",
            username: "rahi.khan",
            kind: "handle"
        });
    });

    it("reads a `handle` field and strips its @ prefix", () => {
        expect(parseProfileResponse('{"platform":"ig","handle":"@a.b"}')).toEqual({
            platform: "instagram",
            username: "a.b",
            kind: "handle"
        });
    });

    it("unwraps three levels of nested envelopes", () => {
        const answer = JSON.stringify({ platform: "instagram", username: "deep.user" });
        const level2 = JSON.stringify({ text: answer });
        const level3 = JSON.stringify({ description: level2 });

        expect(parseProfileResponse(level3)).toEqual({
            platform: "instagram",
            username: "deep.user",
            kind: "handle"
        });
    });

    it("preserves escaped quotes inside the raw username for the cleaner to handle", () => {
        expect(parseProfileResponse('{"platform":"instagram","username":"john\\"doe"}').username).toBe('john"doe');
    });
});
