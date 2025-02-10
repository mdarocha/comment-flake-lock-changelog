import core from "@actions/core";
import { run } from "~/main";

try {
    await run();
} catch (error) {
    if (error instanceof Error) {
        core.setFailed(error.message);
    }
}
