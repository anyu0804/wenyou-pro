import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	ANTI_LOCKOUT_RULESET_NAME,
	applyGitHubRepoConfig,
	assertAntiLockoutRulesetPayload,
	buildAntiLockoutRulesetPayload,
	buildDryRunPlan,
	buildGhApiArgs,
	createGhApiRunner,
	DEFAULT_REPO,
	parseConfigureArgs,
	REPO_ADMIN_ROLE_ACTOR_ID,
	verifyRepository,
} from "./configure-github-repo.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const CONFIGURE_SCRIPT_PATH = resolve(SCRIPT_DIR, "configure-github-repo.mjs");

async function createTempDir(t, prefix = "wenyou-repo-guard-test-") {
	const dir = await mkdtemp(join(os.tmpdir(), prefix));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function writeRepoFixture(rootDir, overrides = {}) {
	const files = {
		".github/CODEOWNERS": "# Maintainer: 安钰\n* @anyu0804\n",
		".github/workflows/ci.yml": [
			"name: Wenyou Pro CI",
			"on:",
			"  push:",
			"    branches: [main]",
			"permissions:",
			"  contents: read",
			"concurrency:",
			"  group: wenyou-ci-${{ github.workflow }}-${{ github.ref }}",
			"  cancel-in-progress: true",
			"jobs:",
			"  verify:",
			"    runs-on: ubuntu-latest",
			"    timeout-minutes: 25",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"      - run: echo ok",
		].join("\n"),
		".github/workflows/release.yml": [
			"name: Release (Upstream Archive)",
			"on:",
			"  workflow_dispatch:",
			"concurrency:",
			"  group: percho-release",
			"  cancel-in-progress: true",
			"jobs:",
			"  prepare:",
			"    runs-on: ubuntu-latest",
			"    timeout-minutes: 15",
			"    steps:",
			"      - run: echo prepare",
			"  runtime:",
			"    needs: prepare",
			"    uses: ./.github/workflows/remote-runtime.yml",
			"  publish:",
			"    needs: [prepare, runtime]",
			"    runs-on: ubuntu-latest",
			"    timeout-minutes: 15",
			"    steps:",
			"      - run: echo publish",
		].join("\n"),
		".github/workflows/remote-runtime.yml": [
			"name: Remote runtime artifacts",
			"on:",
			"  workflow_call:",
			"jobs:",
			"  build-and-verify:",
			"    runs-on: ubuntu-latest",
			"    timeout-minutes: 45",
			"    steps:",
			"      - run: echo build",
		].join("\n"),
		"packages/desktop/electron-builder.wenyou.yml": [
			"appId: io.github.anyu.wenyou-pro",
			"productName: Wenyou Pro",
			"extraMetadata:",
			"  version: 0.2.5",
			"  disableAutoUpdate: true",
			"publish: null",
		].join("\n"),
		...overrides,
	};

	for (const [relPath, content] of Object.entries(files)) {
		if (content === null) continue;
		const fullPath = join(rootDir, relPath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf8");
	}
}

describe("configure-github-repo CLI argument parsing", () => {
	test("parses --verify, --dry-run, --apply, --repo and rejects invalid combinations", () => {
		assert.deepEqual(parseConfigureArgs(["--verify"]), {
			mode: "verify",
			repo: DEFAULT_REPO,
			rootDir: undefined,
			help: false,
		});
		assert.deepEqual(parseConfigureArgs(["--dry-run"]), {
			mode: "dry-run",
			repo: DEFAULT_REPO,
			rootDir: undefined,
			help: false,
		});
		assert.deepEqual(parseConfigureArgs(["--apply", "--repo", "anyu0804/wenyou-pro"]), {
			mode: "apply",
			repo: "anyu0804/wenyou-pro",
			rootDir: undefined,
			help: false,
		});
		assert.deepEqual(parseConfigureArgs(["-h"]), {
			mode: null,
			repo: DEFAULT_REPO,
			rootDir: undefined,
			help: true,
		});

		assert.throws(() => parseConfigureArgs([]), /Specify exactly one mode/);
		assert.throws(() => parseConfigureArgs(["--verify", "--apply"]), /mutually exclusive/);
		assert.throws(() => parseConfigureArgs(["--dry-run", "--repo", "not-a-slug"]), /Invalid GitHub/);
		assert.throws(() => parseConfigureArgs(["--unknown-flag"]));
	});
});

describe("configure-github-repo --verify static anti-lockout gate", () => {
	test("passes against the actual Wenyou Pro repository and CLI exits 0 with clean JSON", async () => {
		const report = await verifyRepository({ rootDir: REPO_ROOT });
		assert.equal(report.ok, true, `Unexpected violations: ${JSON.stringify(report.violations)}`);
		assert.equal(report.checks.codeowners.ok, true);
		assert.ok(report.checks.codeowners.owners.includes("@anyu0804"));
		assert.equal(report.checks.workflows.ok, true);
		assert.ok(report.checks.workflows.filesScanned >= 5);
		assert.ok(report.checks.workflows.reusableCallerJobs >= 2);
		assert.equal(report.checks.ciConcurrency.cancelInProgress, true);
		assert.equal(report.checks.releaseTrigger.hasPushVTagTrigger, false);
		assert.equal(report.checks.electronBuilder.disableAutoUpdate, true);
		assert.equal(report.checks.electronBuilder.publish, null);

		const { stdout } = await execFileAsync(process.execPath, [CONFIGURE_SCRIPT_PATH, "--verify"], {
			cwd: REPO_ROOT,
		});
		const cliReport = JSON.parse(stdout);
		assert.equal(cliReport.ok, true);
		assert.equal(cliReport.mode, "verify");
		assert.equal(stdout.includes(os.homedir()), false, "CLI output must not expose local home path");
	});

	test("blocks a regular job missing timeout-minutes even if a step or comment mentions timeout-minutes", async (t) => {
		const tempRoot = await createTempDir(t);
		await writeRepoFixture(tempRoot, {
			".github/workflows/ci.yml": [
				"name: Broken CI",
				"on:",
				"  push:",
				"    branches: [main]",
				"concurrency:",
				"  group: ci-${{ github.ref }}",
				"  cancel-in-progress: true",
				"jobs:",
				"  verify:",
				"    runs-on: ubuntu-latest",
				"    # timeout-minutes: 25",
				"    steps:",
				"      - name: Run step with step-level timeout only",
				"        timeout-minutes: 10",
				"        run: |",
				"          echo 'timeout-minutes: 20'",
			].join("\n"),
		});

		const report = await verifyRepository({ rootDir: tempRoot });
		assert.equal(report.ok, false);
		assert.equal(report.checks.workflows.ok, false);
		assert.ok(
			report.violations.some(
				(v) => v.file === ".github/workflows/ci.yml" && /missing explicit timeout-minutes/i.test(v.message),
			),
		);

		await assert.rejects(
			execFileAsync(process.execPath, [CONFIGURE_SCRIPT_PATH, "--verify", "--root", tempRoot]),
			(error) => {
				assert.equal(error.code, 1);
				const parsed = JSON.parse(error.stdout);
				assert.equal(parsed.ok, false);
				return true;
			},
		);
	});

	test("blocks regular jobs with timeout-minutes > 60 or non-positive values", async (t) => {
		const tempRoot = await createTempDir(t);
		await writeRepoFixture(tempRoot, {
			".github/workflows/ci.yml": [
				"name: Overlong CI",
				"on: workflow_dispatch",
				"concurrency:",
				"  group: ci",
				"  cancel-in-progress: true",
				"jobs:",
				"  too-long:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 90",
				"    steps:",
				"      - run: echo slow",
				"  zero-timeout:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 0",
				"    steps:",
				"      - run: echo zero",
			].join("\n"),
		});

		const report = await verifyRepository({ rootDir: tempRoot });
		assert.equal(report.ok, false);
		assert.equal(
			report.violations.filter((v) => /invalid timeout-minutes/i.test(v.message)).length,
			2,
		);
	});

	test("allows reusable workflow caller jobs (uses:) without timeout-minutes, and rejects timeout-minutes on caller jobs", async (t) => {
		const validRoot = await createTempDir(t);
		await writeRepoFixture(validRoot);
		const validReport = await verifyRepository({ rootDir: validRoot });
		assert.equal(validReport.ok, true);
		assert.equal(validReport.checks.workflows.reusableCallerJobs, 1);

		const invalidCallerRoot = await createTempDir(t);
		await writeRepoFixture(invalidCallerRoot, {
			".github/workflows/release.yml": [
				"name: Invalid Caller",
				"on:",
				"  workflow_dispatch:",
				"jobs:",
				"  runtime:",
				"    uses: ./.github/workflows/remote-runtime.yml",
				"    timeout-minutes: 45",
			].join("\n"),
		});
		const invalidReport = await verifyRepository({ rootDir: invalidCallerRoot });
		assert.equal(invalidReport.ok, false);
		assert.ok(
			invalidReport.violations.some(
				(v) =>
					v.file === ".github/workflows/release.yml" &&
					/Reusable workflow caller job "runtime".*must NOT declare timeout-minutes/i.test(v.message),
			),
		);
	});

	test("blocks legacy @Jaxton07 owner or missing @anyu0804 in .github/CODEOWNERS", async (t) => {
		const upstreamRoot = await createTempDir(t);
		await writeRepoFixture(upstreamRoot, {
			".github/CODEOWNERS": "* @Jaxton07\n",
		});
		const upstreamReport = await verifyRepository({ rootDir: upstreamRoot });
		assert.equal(upstreamReport.ok, false);
		assert.equal(upstreamReport.checks.codeowners.ok, false);
		assert.ok(upstreamReport.violations.some((v) => /@Jaxton07/.test(v.message)));
		assert.ok(upstreamReport.violations.some((v) => /@anyu0804/.test(v.message)));

		const commentLeakRoot = await createTempDir(t);
		await writeRepoFixture(commentLeakRoot, {
			".github/CODEOWNERS": "# Old owner: @Jaxton07\n* @anyu0804\n",
		});
		const commentReport = await verifyRepository({ rootDir: commentLeakRoot });
		assert.equal(commentReport.ok, false);
		assert.ok(commentReport.violations.some((v) => /@Jaxton07/.test(v.message)));
	});

	test("blocks ci.yml without cancel-in-progress: true, release.yml with push v* tags, and auto-update enabled in electron-builder", async (t) => {
		const tempRoot = await createTempDir(t);
		await writeRepoFixture(tempRoot, {
			".github/workflows/ci.yml": [
				"name: CI",
				"on: push",
				"concurrency:",
				"  group: ci",
				"  cancel-in-progress: false",
				"jobs:",
				"  verify:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 25",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
			".github/workflows/release.yml": [
				"name: Release",
				"on:",
				"  push:",
				'    tags: ["v*"]',
				"  workflow_dispatch:",
				"jobs:",
				"  prepare:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 15",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
			"packages/desktop/electron-builder.wenyou.yml": [
				"appId: io.github.anyu.wenyou-pro",
				"extraMetadata:",
				"  disableAutoUpdate: false",
				"publish:",
				"  - provider: github",
			].join("\n"),
		});

		const report = await verifyRepository({ rootDir: tempRoot });
		assert.equal(report.ok, false);
		assert.equal(report.checks.ciConcurrency.ok, false);
		assert.equal(report.checks.releaseTrigger.ok, false);
		assert.equal(report.checks.electronBuilder.ok, false);
		assert.ok(report.violations.some((v) => v.check === "ciConcurrency"));
		assert.ok(report.violations.some((v) => v.check === "releaseTrigger"));
		assert.ok(
			report.violations.filter((v) => v.check === "electronBuilder").length === 2,
		);
	});

	test("also catches block-sequence push tags (- \"v*\"), zero-indent sequences, and any push.tags pattern in release.yml", async (t) => {
		const indentedRoot = await createTempDir(t);
		await writeRepoFixture(indentedRoot, {
			".github/workflows/release.yml": [
				"name: Release",
				"on:",
				"  push:",
				"    tags:",
				'      - "v*"',
				"jobs:",
				"  prepare:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 15",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
		});
		const indentedReport = await verifyRepository({ rootDir: indentedRoot });
		assert.equal(indentedReport.ok, false);
		assert.equal(indentedReport.checks.releaseTrigger.hasPushTagTrigger, true);
		assert.equal(indentedReport.checks.releaseTrigger.hasPushVTagTrigger, true);

		// Valid YAML allows sequence items at the exact same indent as `tags:`
		const zeroIndentRoot = await createTempDir(t);
		await writeRepoFixture(zeroIndentRoot, {
			".github/workflows/release.yml": [
				"name: Release",
				"on:",
				"  push:",
				"    tags:",
				'    - "v*"',
				"    branches:",
				"    - main",
				"jobs:",
				"  prepare:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 15",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
		});
		const zeroIndentReport = await verifyRepository({ rootDir: zeroIndentRoot });
		assert.equal(zeroIndentReport.ok, false);
		assert.equal(zeroIndentReport.checks.releaseTrigger.hasPushTagTrigger, true);
		assert.deepEqual(zeroIndentReport.checks.releaseTrigger.pushTags, ["v*"]);

		// Any push.tags pattern (e.g. v[0-9]*, *, release-*) must be blocked on archived release.yml
		for (const tagExpr of ['["v[0-9]*"]', '["*"]', '["release-*"]']) {
			const patternRoot = await createTempDir(t);
			await writeRepoFixture(patternRoot, {
				".github/workflows/release.yml": [
					"name: Release",
					"on:",
					"  push:",
					`    tags: ${tagExpr}`,
					"jobs:",
					"  prepare:",
					"    runs-on: ubuntu-latest",
					"    timeout-minutes: 15",
					"    steps:",
					"      - run: echo ok",
				].join("\n"),
			});
			const patternReport = await verifyRepository({ rootDir: patternRoot });
			assert.equal(patternReport.ok, false, `Expected push.tags ${tagExpr} to be rejected`);
			assert.equal(patternReport.checks.releaseTrigger.ok, false);
			assert.equal(patternReport.checks.releaseTrigger.hasPushTagTrigger, true);
		}
	});

	test("blocks ci.yml concurrency missing a non-empty group even when cancel-in-progress is true", async (t) => {
		const missingGroupRoot = await createTempDir(t);
		await writeRepoFixture(missingGroupRoot, {
			".github/workflows/ci.yml": [
				"name: CI",
				"on: push",
				"concurrency:",
				"  cancel-in-progress: true",
				"jobs:",
				"  verify:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 25",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
		});
		const missingGroupReport = await verifyRepository({ rootDir: missingGroupRoot });
		assert.equal(missingGroupReport.ok, false);
		assert.equal(missingGroupReport.checks.ciConcurrency.ok, false);
		assert.equal(missingGroupReport.checks.ciConcurrency.group, null);
		assert.ok(
			missingGroupReport.violations.some(
				(v) => v.check === "ciConcurrency" && /non-empty.*group/i.test(v.message),
			),
		);

		const emptyGroupRoot = await createTempDir(t);
		await writeRepoFixture(emptyGroupRoot, {
			".github/workflows/ci.yml": [
				"name: CI",
				"on: push",
				'concurrency: { group: "   ", cancel-in-progress: true }',
				"jobs:",
				"  verify:",
				"    runs-on: ubuntu-latest",
				"    timeout-minutes: 25",
				"    steps:",
				"      - run: echo ok",
			].join("\n"),
		});
		const emptyGroupReport = await verifyRepository({ rootDir: emptyGroupRoot });
		assert.equal(emptyGroupReport.ok, false);
		assert.equal(emptyGroupReport.checks.ciConcurrency.ok, false);
		assert.equal(emptyGroupReport.checks.ciConcurrency.group, null);
	});
});

describe("configure-github-repo Anti-Lockout Ruleset payload & --dry-run", () => {
	test("dry-run payload grants Repository Admin always bypass and forbids pull_request / required_status_checks", async () => {
		const plan = buildDryRunPlan();
		assert.equal(plan.ok, true);
		assert.equal(plan.repo, DEFAULT_REPO);
		assert.deepEqual(plan.workflowPermissions, {
			default_workflow_permissions: "read",
			can_approve_pull_request_reviews: false,
		});

		const { ruleset } = plan;
		assert.equal(ruleset.name, ANTI_LOCKOUT_RULESET_NAME);
		assert.equal(ruleset.target, "branch");
		assert.equal(ruleset.enforcement, "active");
		assert.deepEqual(ruleset.conditions, {
			ref_name: {
				include: ["~DEFAULT_BRANCH"],
				exclude: [],
			},
		});
		assert.deepEqual(ruleset.bypass_actors, [
			{
				actor_id: REPO_ADMIN_ROLE_ACTOR_ID,
				actor_type: "RepositoryRole",
				bypass_mode: "always",
			},
		]);
		assert.deepEqual(ruleset.rules, [{ type: "deletion" }, { type: "non_fast_forward" }]);
		assert.equal(
			ruleset.rules.some((r) => r.type === "pull_request" || r.type === "required_status_checks"),
			false,
		);

		// CLI --dry-run runs completely offline and prints valid JSON
		const { stdout } = await execFileAsync(
			process.execPath,
			[CONFIGURE_SCRIPT_PATH, "--dry-run", "--repo", "anyu0804/wenyou-pro"],
			{ cwd: REPO_ROOT },
		);
		const cliPlan = JSON.parse(stdout);
		assert.equal(cliPlan.ok, true);
		assert.equal(cliPlan.mode, "dry-run");
		assert.deepEqual(cliPlan.ruleset, ruleset);
	});

	test("assertAntiLockoutRulesetPayload rejects missing admin bypass or self-locking pull_request rules", () => {
		const noBypass = {
			...buildAntiLockoutRulesetPayload(),
			bypass_actors: [],
		};
		assert.throws(() => assertAntiLockoutRulesetPayload(noBypass), /bypass_actors/);

		const prOnlyBypass = {
			...buildAntiLockoutRulesetPayload(),
			bypass_actors: [
				{
					actor_id: REPO_ADMIN_ROLE_ACTOR_ID,
					actor_type: "RepositoryRole",
					bypass_mode: "pull_request",
				},
			],
		};
		assert.throws(() => assertAntiLockoutRulesetPayload(prOnlyBypass), /bypass_mode='always'/);

		const withPullRequestLock = {
			...buildAntiLockoutRulesetPayload(),
			rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
		};
		assert.throws(() => assertAntiLockoutRulesetPayload(withPullRequestLock), /pull_request/);

		const withStatusCheckLock = {
			...buildAntiLockoutRulesetPayload(),
			rules: [
				{ type: "deletion" },
				{ type: "non_fast_forward" },
				{ type: "required_status_checks" },
			],
		};
		assert.throws(
			() => assertAntiLockoutRulesetPayload(withStatusCheckLock),
			/required_status_checks/,
		);
	});
});

describe("configure-github-repo --apply idempotent create & update branches with mock gh", () => {
	test("creates anti-lockout ruleset via POST when none exists yet", async () => {
		const calls = [];
		const mockRunGh = async (req) => {
			calls.push(req);
			if (req.method === "PUT" && req.endpoint === "repos/anyu0804/wenyou-pro/actions/permissions/workflow") {
				return null;
			}
			if (req.method === "GET" && req.endpoint === "repos/anyu0804/wenyou-pro/rulesets") {
				return [
					{ id: 10, name: "other-ruleset", source_type: "Repository" },
					{ id: 20, name: ANTI_LOCKOUT_RULESET_NAME, source_type: "Organization" },
				];
			}
			if (req.method === "POST" && req.endpoint === "repos/anyu0804/wenyou-pro/rulesets") {
				return { id: 777, name: req.body.name };
			}
			throw new Error(`Unexpected gh api call: ${req.method} ${req.endpoint}`);
		};

		const result = await applyGitHubRepoConfig({
			repo: "anyu0804/wenyou-pro",
			runGh: mockRunGh,
		});

		assert.equal(result.ok, true);
		assert.equal(result.mode, "apply");
		assert.equal(result.ruleset.action, "created");
		assert.equal(result.ruleset.method, "POST");
		assert.equal(result.ruleset.endpoint, "repos/anyu0804/wenyou-pro/rulesets");
		assert.equal(result.ruleset.id, 777);

		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0], {
			method: "PUT",
			endpoint: "repos/anyu0804/wenyou-pro/actions/permissions/workflow",
			body: {
				default_workflow_permissions: "read",
				can_approve_pull_request_reviews: false,
			},
		});
		assert.deepEqual(calls[1], {
			method: "GET",
			endpoint: "repos/anyu0804/wenyou-pro/rulesets",
		});
		assert.equal(calls[2].method, "POST");
		assert.equal(calls[2].endpoint, "repos/anyu0804/wenyou-pro/rulesets");
		assert.deepEqual(calls[2].body, buildAntiLockoutRulesetPayload());
	});

	test("updates existing anti-lockout ruleset idempotently via PUT when already present", async () => {
		const calls = [];
		const mockRunGh = async (req) => {
			calls.push(req);
			if (req.method === "PUT" && req.endpoint === "repos/anyu0804/wenyou-pro/actions/permissions/workflow") {
				return null;
			}
			if (req.method === "GET" && req.endpoint === "repos/anyu0804/wenyou-pro/rulesets") {
				return [
					{ id: 9001, name: ANTI_LOCKOUT_RULESET_NAME, source_type: "Repository" },
				];
			}
			if (req.method === "PUT" && req.endpoint === "repos/anyu0804/wenyou-pro/rulesets/9001") {
				return { id: 9001, name: req.body.name };
			}
			throw new Error(`Unexpected gh api call: ${req.method} ${req.endpoint}`);
		};

		const result = await applyGitHubRepoConfig({
			repo: "anyu0804/wenyou-pro",
			runGh: mockRunGh,
		});

		assert.equal(result.ok, true);
		assert.equal(result.ruleset.action, "updated");
		assert.equal(result.ruleset.method, "PUT");
		assert.equal(result.ruleset.endpoint, "repos/anyu0804/wenyou-pro/rulesets/9001");
		assert.equal(result.ruleset.id, 9001);

		assert.equal(calls.length, 3);
		assert.equal(calls[2].method, "PUT");
		assert.equal(calls[2].endpoint, "repos/anyu0804/wenyou-pro/rulesets/9001");
		assert.deepEqual(calls[2].body, buildAntiLockoutRulesetPayload());
	});

	test("builds exact gh api CLI arguments with stdin payload flag only when body is present", () => {
		assert.deepEqual(
			buildGhApiArgs({
				method: "GET",
				endpoint: "repos/anyu0804/wenyou-pro/rulesets",
				hasBody: false,
			}),
			[
				"api",
				"--method",
				"GET",
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				"X-GitHub-Api-Version: 2022-11-28",
				"repos/anyu0804/wenyou-pro/rulesets",
			],
		);
		assert.deepEqual(
			buildGhApiArgs({
				method: "PUT",
				endpoint: "repos/anyu0804/wenyou-pro/actions/permissions/workflow",
				hasBody: true,
			}),
			[
				"api",
				"--method",
				"PUT",
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				"X-GitHub-Api-Version: 2022-11-28",
				"repos/anyu0804/wenyou-pro/actions/permissions/workflow",
				"--input",
				"-",
			],
		);
	});

	test("handles early child process exit without uncaught stdin EPIPE/EOF error", async () => {
		// Spawning node with non-existent "api" arg exits immediately with non-zero code without reading stdin.
		const runner = createGhApiRunner({ ghBin: process.execPath, timeoutMs: 5000 });
		let uncaughtError = null;
		const onUncaught = (err) => {
			uncaughtError = err;
		};
		process.on("uncaughtException", onUncaught);
		try {
			await assert.rejects(
				runner({
					method: "PUT",
					endpoint: "repos/anyu0804/wenyou-pro/rulesets",
					body: { padding: "x".repeat(256 * 1024) },
				}),
				/failed with exit code/,
			);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
			assert.equal(uncaughtError, null, "stdin write to early-exiting child must not emit uncaught error");
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});
});
