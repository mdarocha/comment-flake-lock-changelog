import { beforeEach, expect, mock, test } from "bun:test";
import { mockModule } from "~/utils/mockModule";

beforeEach(() => {
    // Bun does not implement jest.resetModules(), so we manually clear the cache
    // for index.ts and main.ts — the only modules that run side-effects on import.
    // We intentionally do NOT clear the full cache; wiping all entries breaks
    // mock.module() live bindings (e.g. @actions/github) in other test files.
    for (const key of Object.keys(require.cache)) {
        if (key.includes("/src/index") || key.includes("/src/main")) {
            delete require.cache[key];
        }
    }
});

test("should execute run()", async () => {
    const run = mock(() => {});
    using _mainMock = await mockModule("~/main", () => ({ run }));

    await import("./index");

    expect(run).toHaveBeenCalled();
});

test("should call setFailed if run() throws an error", async (done) => {
    const errorMessage = `Test error ${Math.random()}`;
    using _mainMock = await mockModule("~/main", () => ({
        run: () => {
            throw new Error(errorMessage);
        },
    }));

    const setFailed = mock(() => {
        done();
    });
    using _actionsCoreMock = await mockModule("@actions/core", () => ({
        setFailed,
    }));

    await import("./index");

    expect(setFailed).toHaveBeenCalledWith(errorMessage);
});
