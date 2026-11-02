import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "../csv";

/**
 * RFC 4180 edge cases for the leads export that the base suite does not cover:
 * carriage-return-only breaks, mixed quoting, header escaping, unicode, and
 * ragged rows. The endpoint at `src/routes/api/leads/+server.ts` relies on these.
 */

describe("csvField — quoting boundaries", () => {
    it("quotes a bare carriage return (not just LF)", () => {
        expect(csvField("a\rb")).toBe('"a\rb"');
    });

    it("escapes quotes and newlines in the same field", () => {
        expect(csvField('say "hi"\nthen "bye"')).toBe('"say ""hi""\nthen ""bye"""');
    });

    it("does not quote spaces, so values keep leading/trailing padding", () => {
        expect(csvField("  padded  ")).toBe("  padded  ");
    });

    it("stringifies falsy primitives instead of blanking them", () => {
        expect(csvField(0)).toBe("0");
        expect(csvField(false)).toBe("false");
    });

    it("passes unicode, emoji and non-Latin text through unchanged", () => {
        expect(csvField("rahi.khan")).toBe("rahi.khan");
        expect(csvField("Ünïcode ✨")).toBe("Ünïcode ✨");
    });
});

describe("toCsv — document shape", () => {
    it("escapes a header cell containing a comma", () => {
        expect(toCsv(["a,b"], [])).toBe('"a,b"');
    });

    it("preserves CRLF-embedded values inside a quoted cell", () => {
        expect(toCsv(["note"], [["line1\r\nline2"]])).toBe('note\r\n"line1\r\nline2"');
    });

    it("does not pad ragged rows to the header width", () => {
        expect(toCsv(["a", "b", "c"], [["1"]])).toBe("a,b,c\r\n1");
    });

    it("renders an explicit empty row as an empty line", () => {
        expect(toCsv(["a", "b"], [["", ""]])).toBe("a,b\r\n,");
    });

    it("keeps the leads-export header order stable", () => {
        const header = ["username", "platform", "profile_url", "tier", "confidence", "notion_status", "created_at"];
        expect(toCsv(header, []).split(",")).toEqual(header);
    });
});
