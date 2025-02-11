async function writeResultFile(content: string): Promise<void> {
    const path = `${process.env.RUNNER_TEMP}/comment-flake-lock-changelog-result.md`;
    await Bun.write(path, content);
}

export async function run(): Promise<void> {
    throw new Error("TODO!");
}
