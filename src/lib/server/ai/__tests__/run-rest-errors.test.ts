import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CfInferenceError,
    DEFAULT_VISION_MODEL,
    listVisionModels,
    runVisionViaRest,
    type CloudflareCreds
} from "../run-rest";

/**
 * Failure-path coverage for the per-user Workers AI REST client: transport throws,
 * the 400 → legacy-schema retry, MIME sniffing, output-unwrap edge cases, and the
 * catalog sort/flag rules. Every fetch is stubbed — no network.
 */

const creds: CloudflareCreds = { accountId: "acc123", apiToken: "tok_abc" };

/** Minimal Response surface the client actually reads. */
function jsonResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
    vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("runVisionViaRest — transport failures", () => {
    it("wraps a network throw as a transport error with status 0", async () => {
        mockFetch(async () => {
            throw new Error("ECONNRESET");
        });

        const err = await runVisionViaRest(creds, "m", { image: [1], prompt: "p" }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(CfInferenceError);
        expect(err).toMatchObject({ status: 0, kind: "transport", message: "ECONNRESET" });
    });

    it("surfaces a transport error if the legacy-schema retry itself throws", async () => {
        let call = 0;
        mockFetch(async () => {
            call += 1;
            if (call === 1) return jsonResponse(400, {});
            throw new Error("socket hang up");
        });

        await expect(runVisionViaRest(creds, "m", { image: [1], prompt: "p" })).rejects.toMatchObject({
            status: 0,
            kind: "transport",
            message: "socket hang up"
        });
        expect(call).toBe(2);
    });

    it("retries a 400 exactly once, then reports the retry's status", async () => {
        let call = 0;
        mockFetch(async () => {
            call += 1;
            return call === 1 ? jsonResponse(400, {}) : jsonResponse(429, {});
        });

        await expect(runVisionViaRest(creds, "m", { image: [1], prompt: "p" })).rejects.toMatchObject({
            status: 429,
            kind: "rate_limit"
        });
        expect(call).toBe(2);
    });

    it("does not retry a non-400 failure", async () => {
        let call = 0;
        mockFetch(async () => {
            call += 1;
            return jsonResponse(503, {});
        });

        await expect(runVisionViaRest(creds, "m", { image: [1], prompt: "p" })).rejects.toMatchObject({
            status: 503,
            kind: "transport"
        });
        expect(call).toBe(1);
    });
});

describe("runVisionViaRest — request shaping", () => {
    async function captureBody(image: number[], maxTokens?: number): Promise<Record<string, unknown>> {
        let body = "";
        mockFetch(async (_url, init) => {
            body = String(init?.body ?? "");
            return jsonResponse(200, { result: { response: "ok" } });
        });
        await runVisionViaRest(creds, "m", { image, prompt: "p", ...(maxTokens === undefined ? {} : { maxTokens }) });
        return JSON.parse(body) as Record<string, unknown>;
    }

    it("sniffs the image MIME type from magic bytes", async () => {
        const cases: Array<[number[], string]> = [
            [[0x89, 0x50, 0x4e, 0x47, 0x00], "image/png"],
            [[0x47, 0x49, 0x46, 0x39], "image/gif"],
            [[0x52, 0x49, 0x46, 0x46, 0x00], "image/webp"],
            [[0xff, 0xd8, 0xff], "image/jpeg"],
            [[0x00, 0x01, 0x02], "image/jpeg"] // unknown → default
        ];

        for (const [image, mime] of cases) {
            const body = await captureBody(image);
            const content = (body["messages"] as Array<{ content: Array<{ image_url?: { url: string } }> }>)[0]!
                .content;
            expect(content[1]?.image_url?.url.startsWith(`data:${mime};base64,`)).toBe(true);
        }
    });

    it("honours an explicit maxTokens override", async () => {
        const body = await captureBody([1, 2], 2048);
        expect(body["max_tokens"]).toBe(2048);
    });

    it("defaults maxTokens to 512", async () => {
        const body = await captureBody([1, 2]);
        expect(body["max_tokens"]).toBe(512);
    });

    it("passes the model output through untouched when there is no `result` envelope", async () => {
        mockFetch(async () => jsonResponse(200, { response: "bare-shape" }));
        await expect(runVisionViaRest(creds, "m", { image: [1], prompt: "p" })).resolves.toEqual({
            response: "bare-shape"
        });
    });
});

describe("listVisionModels — failure and reconciliation", () => {
    it("maps a network throw to a transport error", async () => {
        mockFetch(async () => {
            throw new Error("dns failure");
        });

        await expect(listVisionModels(creds)).rejects.toMatchObject({ status: 0, kind: "transport" });
    });

    it("de-dupes ids, strips registry prefixes, and sorts deprecated last", async () => {
        mockFetch(async () =>
            jsonResponse(200, {
                result: [
                    { name: "@cf/zeta/legacy-vision", task: { name: "image-to-text" }, tags: ["Deprecated"] },
                    { name: "@cf/alpha/vision", task: { name: "Image-Text-to-Text" } },
                    { name: "@cf/alpha/vision", task: { name: "Image-Text-to-Text" } },
                    {
                        name: DEFAULT_VISION_MODEL,
                        task: { name: "Image-Text-to-Text" },
                        properties: [{ property_id: "beta", value: true }]
                    }
                ]
            })
        );

        const models = await listVisionModels(creds);
        const ids = models.map((m) => m.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids[0]).toBe(DEFAULT_VISION_MODEL);
        expect(ids[ids.length - 1]).toBe("@cf/zeta/legacy-vision");

        const legacy = models.find((m) => m.id === "@cf/zeta/legacy-vision");
        expect(legacy).toMatchObject({ label: "zeta/legacy-vision", deprecated: true });

        const fallbackDefault = models.find((m) => m.id === DEFAULT_VISION_MODEL);
        expect(fallbackDefault).toMatchObject({ beta: true, label: "mistralai/mistral-small-3.1-24b-instruct" });
    });
});
