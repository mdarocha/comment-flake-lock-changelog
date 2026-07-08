// https://github.com/oven-sh/bun/issues/7823
import { mock } from "bun:test";

/**
 *
 * @param modulePath - the path starting from this files' path.
 * @param renderMocks - function to generate mocks (by their named or default exports)
 * @returns an object
 */
export interface MockHandle {
    [Symbol.dispose]: () => void;
    dispose: () => void;
}

export const mockModule = async (
    modulePath: string,
    renderMocks: () => Record<string, unknown>,
): Promise<MockHandle> => {
    // dynamic import is intentional: this utility exercises module-loading boundaries for test mocking
    const original = {
        ...(await import(modulePath)),
    };

    const mocks = renderMocks();

    const result = {
        ...original,
        ...mocks,
    };

    mock.module(modulePath, () => result);

    const dispose = () => {
        mock.module(modulePath, () => original);
    };

    return {
        [Symbol.dispose]: dispose,
        dispose,
    };
};
