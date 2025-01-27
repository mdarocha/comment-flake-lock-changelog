import { beforeEach, expect, mock, test } from "bun:test";

beforeEach(() => {
    // have to do this manually, since jest.resetModules() is not implemented
    // Resets the module cache, so each test re-evaluates the imported modules
    Object.keys(require.cache).forEach((key) => {
        delete require.cache[key];
    });
});

test("should execute run()", async () => {
    const run = mock(() => {});
    mock.module("./main", () => ({ run }));

    await import("./index");

    expect(run).toHaveBeenCalled();
});

test("should call setFailed if run() throws an error", async (done) => {
    const errorMessage = `Test error ${Math.random()}`;
    mock.module("./main", () => ({
        run: () => {
            throw new Error(errorMessage);
        },
    }));

    const setFailed = mock(() => {
        done();
    });
    mock.module("@actions/core", () => ({
        default: { setFailed },
    }));

    await import("./index");

    expect(setFailed).toHaveBeenCalledWith(errorMessage);
});
