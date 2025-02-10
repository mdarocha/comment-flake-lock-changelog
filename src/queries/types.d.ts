type GraphQlResponse<T> = { data: T };

interface GetPullRequestRefsResponseData {
    repository: {
        pullRequest: {
            baseRefOid: string;
            headRefOid: string;
        };
    };
}

declare module "~/queries/GetPullRequestRefs.graphql" {
    export default string;
    export type GetPullRequestRefsResponse = GraphQlResponse<GetPullRequestRefsResponseData>;
}

interface GetFileContentAtCommitResponseData {
    repository: {
        object: {
            text: string;
        };
    };
}

declare module "~/queries/GetFileContentAtCommit.graphql" {
    export default string;
    export type GetFileContentAtCommitResponse = GraphQlResponse<GetFileContentAtCommitResponseData>;
}

interface GetPullRequestChangedFilesResponseData {
    repository: {
        pullRequest: {
            files: {
                totalCount: number;
                pageInfo: {
                    endCursor: string;
                    hasNextPage: boolean;
                };
                nodes: Array<{
                    path: string;
                }>;
            };
        };
    };
}

declare module "~/queries/GetPullRequestChangedFiles.graphql" {
    export default string;
    export type GetPullRequestChangedFilesResponse = GraphQlResponse<GetPullRequestChangedFilesResponseData>;
}
