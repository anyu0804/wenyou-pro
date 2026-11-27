/** Wenyou Pro 官方源码与发布页地址 */
export const DEFAULT_REPO_URL = "https://github.com/anyu0804/wenyou-pro";

function normalizeRepoUrl(repoUrl?: string | null): string {
	const trimmed = repoUrl?.trim();
	return (trimmed || DEFAULT_REPO_URL).replace(/\/+$/, "");
}

/** Wenyou Pro 发布标签统一为 `wenyou-v<version>`，兼容已带 `wenyou-v` 或 `v` 前缀的入参。 */
export function formatReleaseTag(version: string): string {
	const trimmed = version.trim();
	if (/^wenyou-v/i.test(trimmed)) return `wenyou-v${trimmed.slice("wenyou-v".length)}`;
	return `wenyou-v${trimmed.replace(/^v/i, "")}`;
}

export function buildReleasesUrl(repoUrl?: string | null): string {
	return `${normalizeRepoUrl(repoUrl)}/releases`;
}

export function buildReleaseTagUrl(repoUrl: string | null | undefined, version: string): string {
	return `${buildReleasesUrl(repoUrl)}/tag/${formatReleaseTag(version)}`;
}
