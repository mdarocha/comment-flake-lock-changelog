import { run } from "./main.ts";
import core from "@actions/core";

try {
    await run();
} catch (error) {
    if (error instanceof Error) {
        core.setFailed(error.message);
    }
}
