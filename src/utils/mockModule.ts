// https://github.com/oven-sh/bun/issues/7823
import { mock } from "bun:test";

/**
 *
 * @param modulePath - the path starting from this files' path.
 * @param renderMocks - function to generate mocks (by their named or default exports)
 * @returns an object
 */
export const mockModule = async (modulePath: string, renderMocks: () => Record<string, any>) => {
    let original = {
        ...(await import(modulePath)),
    };

    let mocks = renderMocks();

    let result = {
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
