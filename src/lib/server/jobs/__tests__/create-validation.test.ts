import { describe, expect, it } from "vitest";
import type { Db } from "$lib/server/db";
import { createJob, QuotaExceededError } from "../create";

/**
 * Job creation envelope: input validation ordering, quota admission, multi/chunked
 * mode, and the R2 → D1 → queue ordering+batching invariants. All bindings are
 * stubbed; nothing touches D1, R2, Queues or the network.
 */

type CreateEnv = Parameters<typeof createJob>[0]["env"];

const CONNECTED = [{ tok: new Uint8Array([1]).buffer, acct: "acc_123", model: null }];

function makeDb(selectResults: unknown[][]) {
    const inserts: Array<{ values: unknown }> = [];
    const updates: unknown[] = [];
    let selectCount = 0;

    const select = () => {
        selectCount += 1;
        const rows = selectResults[selectCount - 1] ?? [];
        const chain = {
            from: () => chain,
            where: () => chain,
            limit: () => chain,
            then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                Promise.resolve(rows).then(resolve, reject)
        };
        return chain;
    };

    const db = {
        select,
        insert: () => ({
            values: async (values: unknown) => {
                inserts.push({ values });
            }
        }),
        update: () => ({
            set: (values: unknown) => ({
                where: async () => {
                    updates.push(values);
                }
            })
        })
    };

    return {
        db: db as unknown as Db,
        inserts,
        updates,
        get selectCount() {
            return selectCount;
        }
    };
}

function makeEnv() {
    const puts: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const env = {
        R2: {
            put: async (key: string) => {
                puts.push(key);
            }
        },
        QUEUE: {
            send: async (message: Record<string, unknown>) => {
                sent.push(message);
            }
        }
    };
    return { env: env as unknown as CreateEnv, puts, sent };
}

function pngFile(name = "a.png"): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

describe("createJob — input validation ordering", () => {
    it("rejects an empty batch before reading the platform or touching bindings", async () => {
        const state = makeDb([]);
        const { env, puts, sent } = makeEnv();

        await expect(createJob({ db: state.db, env, userId: "u1", files: [], diagnostics: false })).rejects.toThrow(
            "at least one file is required"
        );

        expect(state.selectCount).toBe(0);
        expect(puts).toHaveLength(0);
        expect(sent).toHaveLength(0);
    });
});

describe("createJob — quota admission", () => {
    it("rejects a batch that would exceed the daily quota, before R2/D1/queue work", async () => {
        const state = makeDb([CONNECTED, [{ q: 5 }], [{ total: 4 }]]);
        const { env, puts, sent } = makeEnv();

        const err = await createJob({
            db: state.db,
            env,
            userId: "u1",
            files: [pngFile("a.png"), pngFile("b.png"), pngFile("c.png")],
            diagnostics: false
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(QuotaExceededError);
        expect(err).toMatchObject({ used: 4, limit: 5, requested: 3 });
        expect(puts).toHaveLength(0);
        expect(state.inserts).toHaveLength(0);
        expect(sent).toHaveLength(0);
    });

    it("treats limit 0 as unlimited and still admits the batch", async () => {
        const state = makeDb([CONNECTED, [{ q: 0 }], [{ total: 9999 }]]);
        const { env } = makeEnv();

        const result = await createJob({
            db: state.db,
            env,
            userId: "u1",
            files: [pngFile("a.png"), pngFile("b.png")],
            diagnostics: false
        });

        expect(result.itemCount).toBe(2);
    });

    it("reserves the declared total up front in multi mode", async () => {
        const state = makeDb([CONNECTED, [{ q: 50 }], [{ total: 0 }]]);
        const { env, puts } = makeEnv();

        await expect(
            createJob({
                db: state.db,
                env,
                userId: "u1",
                files: [],
                diagnostics: false,
                multi: true,
                expectedTotal: 100
            })
        ).rejects.toMatchObject({ used: 0, limit: 50, requested: 100 });

        expect(puts).toHaveLength(0);
    });

    it("creates an empty, not-yet-complete job in multi mode", async () => {
        const state = makeDb([CONNECTED, [{ q: 0 }], [{ total: 0 }]]);
        const { env, puts, sent } = makeEnv();

        const result = await createJob({
            db: state.db,
            env,
            userId: "u1",
            files: [],
            diagnostics: false,
            multi: true,
            expectedTotal: 5
        });

        const job = state.inserts[0]?.values as Record<string, unknown>;
        expect(result.itemCount).toBe(0);
        expect(job).toMatchObject({ uploadComplete: 0, imageCount: 0, status: "pending" });
        expect(puts).toHaveLength(0);
        expect(sent).toHaveLength(0);
    });
});

describe("createJob — persistence and queue invariants", () => {
    it("writes uploadComplete=1 and enqueues one message per file", async () => {
        const state = makeDb([CONNECTED, [{ q: 0 }], [{ total: 0 }]]);
        const { env, puts, sent } = makeEnv();

        const result = await createJob({
            db: state.db,
            env,
            userId: "u1",
            files: [pngFile("a.png"), pngFile("b.png")],
            diagnostics: true
        });

        const job = state.inserts[0]?.values as Record<string, unknown>;
        expect(result.itemCount).toBe(2);
        expect(job).toMatchObject({ userId: "u1", uploadComplete: 1, diagnostics: 1 });

        expect(puts).toHaveLength(2);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatchObject({ job_id: result.jobId, user_id: "u1", diagnostics: true });
        expect(sent[0]?.["r2_key"]).toBe(puts[0]);
        expect(sent[0]?.["ai_gateway_slug"]).toBeUndefined();
    });

    it("sanitizes the filename in the R2 key", async () => {
        const state = makeDb([CONNECTED, [{ q: 0 }], [{ total: 0 }]]);
        const { env, puts } = makeEnv();

        const result = await createJob({
            db: state.db,
            env,
            userId: "u1",
            files: [pngFile("My Photo (1).PNG")],
            diagnostics: false
        });

        expect(puts[0]).toMatch(new RegExp(`^raw/${result.jobId}/${UUID_RE}_my_photo_1_\\.png$`));
    });

    it("sub-batches item inserts at 10 rows while enqueueing every item", async () => {
        const state = makeDb([CONNECTED, [{ q: 0 }], [{ total: 0 }]]);
        const { env, sent } = makeEnv();
        const files = Array.from({ length: 12 }, (_, i) => pngFile(`img-${i}.png`));

        const result = await createJob({ db: state.db, env, userId: "u1", files, diagnostics: false });

        // inserts[0] is the parent job row; the item rows follow in 10 + 2 batches.
        const batches = state.inserts.slice(1).map((entry) => (entry.values as unknown[]).length);
        expect(batches).toEqual([10, 2]);
        expect(result.itemCount).toBe(12);
        expect(sent).toHaveLength(12);
    });
});
