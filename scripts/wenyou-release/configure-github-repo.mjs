#!/usr/bin/env node
/**
 * GitHub anti-lockout static verifier and idempotent cloud repository guard for Wenyou Pro.
 * Author: 安钰
 *
 * Zero external dependencies so `--verify` can run cleanly in CI prior to `npm ci`.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(MODULE_PATH), "../..");

export const DEFAULT_REPO = "anyu0804/wenyou-pro";
export const REQUIRED_CODEOWNER = "@anyu0804";
export const FORBIDDEN_CODEOWNERS = ["@Jaxton07"];
export const MAX_JOB_TIMEOUT_MINUTES = 60;
export const ANTI_LOCKOUT_RULESET_NAME = "main-anti-lockout-protection";
export const REPO_ADMIN_ROLE_ACTOR_ID = 5;
export const ALLOWED_RULESET_RULE_TYPES = new Set(["deletion", "non_fast_forward"]);
export const FORBIDDEN_RULESET_RULE_TYPES = new Set(["pull_request", "required_status_checks"]);

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BLOCK_SCALAR_PATTERN = /^[|>](?:[+-]\d*|\d*[+-]?)?$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;

function normalizeSlashes(value) {
	return String(value).replaceAll("\\", "/");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeTextForDisplay(input, homeDir = os.homedir()) {
	const text = typeof input === "string" ? input : String(input ?? "");
	if (!homeDir) return text;
	const trimmedHome = homeDir.replace(/[\\/]+$/, "");
	if (!trimmedHome) return text;
	const segments = trimmedHome.split(/[\\/]+/).filter(Boolean);
	if (segments.length === 0) return text;

	const boundaryAfter = "(?=$|[\\\\/\\s\"'`,;)\\]}:.<>，。；：！？、】【（）])";
	const patterns = [];
	const driveMatch = /^([A-Za-z]):$/.exec(segments[0]);
	if (driveMatch) {
		const driveLetter = driveMatch[1];
		const restPattern = segments.slice(1).map(escapeRegExp).join("[\\\\/]+");
		if (restPattern) {
			patterns.push(
				new RegExp(
					`(^|[^A-Za-z0-9_])${escapeRegExp(driveLetter)}:[\\\\/]+${restPattern}${boundaryAfter}`,
					"gi",
				),
			);
			patterns.push(
				new RegExp(
					`(^|[^A-Za-z0-9_])/${escapeRegExp(driveLetter)}[\\\\/]+${restPattern}${boundaryAfter}`,
					"gi",
				),
			);
		}
	} else {
		const joined = segments.map(escapeRegExp).join("[\\\\/]+");
		patterns.push(new RegExp(`(^|[^A-Za-z0-9_])[\\\\/]+${joined}${boundaryAfter}`, "g"));
	}

	let sanitized = text;
	for (const pattern of patterns) {
		sanitized = sanitized.replace(pattern, "$1~");
	}
	return sanitized;
}

export function validateRepoSlug(repo) {
	const trimmed = typeof repo === "string" ? repo.trim() : "";
	if (!REPO_SLUG_PATTERN.test(trimmed)) {
		throw new Error(`Invalid GitHub repository slug "${trimmed}". Expected "<owner>/<name>".`);
	}
	return trimmed;
}

export function buildWorkflowPermissionsPayload() {
	return {
		default_workflow_permissions: "read",
		can_approve_pull_request_reviews: false,
	};
}

export function buildAntiLockoutRulesetPayload() {
	return {
		name: ANTI_LOCKOUT_RULESET_NAME,
		target: "branch",
		enforcement: "active",
		conditions: {
			ref_name: {
				include: ["~DEFAULT_BRANCH"],
				exclude: [],
			},
		},
		bypass_actors: [
			{
				actor_id: REPO_ADMIN_ROLE_ACTOR_ID,
				actor_type: "RepositoryRole",
				bypass_mode: "always",
			},
		],
		rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
	};
}

/**
 * Self-check that guarantees the ruleset payload can never lock out a solo repository admin.
 */
export function assertAntiLockoutRulesetPayload(payload) {
	if (!payload || typeof payload !== "object") {
		throw new Error("Ruleset payload must be an object.");
	}
	if (payload.name !== ANTI_LOCKOUT_RULESET_NAME) {
		throw new Error(`Ruleset name must be "${ANTI_LOCKOUT_RULESET_NAME}".`);
	}
	if (payload.target !== "branch") {
		throw new Error(`Ruleset target must be "branch", got "${payload.target}".`);
	}
	if (payload.enforcement !== "active") {
		throw new Error(`Ruleset enforcement must be "active", got "${payload.enforcement}".`);
	}
	const includeRefs = payload.conditions?.ref_name?.include;
	if (!Array.isArray(includeRefs) || !includeRefs.includes("~DEFAULT_BRANCH")) {
		throw new Error('Ruleset conditions.ref_name.include must target "~DEFAULT_BRANCH".');
	}
	const bypassActors = Array.isArray(payload.bypass_actors) ? payload.bypass_actors : [];
	const hasAdminAlwaysBypass = bypassActors.some(
		(actor) =>
			actor &&
			actor.actor_id === REPO_ADMIN_ROLE_ACTOR_ID &&
			actor.actor_type === "RepositoryRole" &&
			actor.bypass_mode === "always",
	);
	if (!hasAdminAlwaysBypass) {
		throw new Error(
			"Anti-lockout guard violation: ruleset bypass_actors must grant RepositoryRole actor_id=5 bypass_mode='always'.",
		);
	}
	const rules = Array.isArray(payload.rules) ? payload.rules : [];
	const ruleTypes = new Set();
	for (const rule of rules) {
		const type = rule?.type;
		if (!type || typeof type !== "string") {
			throw new Error("Ruleset contains a rule entry without a string type.");
		}
		if (FORBIDDEN_RULESET_RULE_TYPES.has(type)) {
			throw new Error(
				`Anti-lockout guard violation: ruleset must NOT include self-locking rule "${type}".`,
			);
		}
		if (!ALLOWED_RULESET_RULE_TYPES.has(type)) {
			throw new Error(`Unexpected ruleset rule type "${type}".`);
		}
		ruleTypes.add(type);
	}
	for (const requiredType of ALLOWED_RULESET_RULE_TYPES) {
		if (!ruleTypes.has(requiredType)) {
			throw new Error(`Ruleset must include required rule "${requiredType}".`);
		}
	}
	return payload;
}

export function buildDryRunPlan(repo = DEFAULT_REPO) {
	const validatedRepo = validateRepoSlug(repo);
	const workflowPermissions = buildWorkflowPermissionsPayload();
	const ruleset = assertAntiLockoutRulesetPayload(buildAntiLockoutRulesetPayload());

	return {
		ok: true,
		mode: "dry-run",
		repo: validatedRepo,
		dryRun: true,
		operations: [
			{
				name: "actions-workflow-permissions",
				method: "PUT",
				endpoint: `repos/${validatedRepo}/actions/permissions/workflow`,
				payload: workflowPermissions,
			},
			{
				name: "main-anti-lockout-ruleset",
				lookupMethod: "GET",
				lookupEndpoint: `repos/${validatedRepo}/rulesets`,
				createMethod: "POST",
				createEndpoint: `repos/${validatedRepo}/rulesets`,
				updateMethod: "PUT",
				updateEndpointTemplate: `repos/${validatedRepo}/rulesets/{ruleset_id}`,
				payload: ruleset,
			},
		],
		workflowPermissions,
		ruleset,
	};
}

function stripYamlInlineComment(line) {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (inSingle) {
			if (ch === "'") {
				if (line[i + 1] === "'") {
					i += 1;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				i += 1;
			} else if (ch === '"') {
				inDouble = false;
			}
			continue;
		}
		if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
			return line.slice(0, i).trimEnd();
		}
	}
	return line.trimEnd();
}

function unquoteYamlScalar(raw) {
	const trimmed = String(raw ?? "").trim();
	if (trimmed.length >= 2) {
		if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
			return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
		}
		if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
			return trimmed.slice(1, -1).replace(/''/g, "'");
		}
	}
	return trimmed;
}

function parseKeyValueLine(text) {
	const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/.exec(text);
	if (!match) return null;
	const key = match[1] ?? match[2] ?? match[3];
	const value = match[4].trim();
	return { key, value };
}

function splitTopLevelFlow(text) {
	const items = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let braceDepth = 0;
	let bracketDepth = 0;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (inSingle) {
			current += ch;
			if (ch === "'") {
				if (text[i + 1] === "'") {
					current += "'";
					i += 1;
				} else {
					inSingle = false;
				}
			}
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === "\\" && i + 1 < text.length) {
				current += text[i + 1];
				i += 1;
			} else if (ch === '"') {
				inDouble = false;
			}
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
		} else if (ch === '"') {
			inDouble = true;
			current += ch;
		} else if (ch === "{") {
			braceDepth += 1;
			current += ch;
		} else if (ch === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += ch;
		} else if (ch === "[") {
			bracketDepth += 1;
			current += ch;
		} else if (ch === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += ch;
		} else if (ch === "," && braceDepth === 0 && bracketDepth === 0) {
			if (current.trim()) items.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) items.push(current.trim());
	return items;
}

function parseFlowMapping(raw) {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	const inner = trimmed.slice(1, -1).trim();
	const map = new Map();
	if (!inner) return map;
	for (const entry of splitTopLevelFlow(inner)) {
		const kv = parseKeyValueLine(entry);
		if (kv) {
			map.set(kv.key, kv.value);
		}
	}
	return map;
}

function parseFlowSequence(raw) {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	const inner = trimmed.slice(1, -1).trim();
	if (!inner) return [];
	return splitTopLevelFlow(inner).map(unquoteYamlScalar);
}

/**
 * Extracts indentation-aware structural YAML lines while ignoring comments and block scalar bodies.
 */
export function extractStructuralYamlLines(content) {
	const rawLines = String(content).split(/\r?\n/);
	const structural = [];
	let inBlockScalar = false;
	let blockScalarParentIndent = -1;

	for (let index = 0; index < rawLines.length; index += 1) {
		const rawLine = rawLines[index];
		const leadingMatch = /^( *)/.exec(rawLine);
		const indent = leadingMatch ? leadingMatch[1].length : 0;
		const trimmedAll = rawLine.trim();

		if (inBlockScalar) {
			if (trimmedAll === "") {
				continue;
			}
			if (indent > blockScalarParentIndent) {
				continue;
			}
			inBlockScalar = false;
			blockScalarParentIndent = -1;
		}

		const withoutComment = stripYamlInlineComment(rawLine);
		const text = withoutComment.trim();
		if (!text) continue;
		if (indent === 0 && (text === "---" || text === "...")) continue;

		structural.push({
			lineNo: index + 1,
			indent,
			text,
		});

		const listPrefixMatch = /^(-\s+)(.*)$/.exec(text);
		const candidateText = listPrefixMatch ? listPrefixMatch[2] : text;
		const effectiveIndent = listPrefixMatch ? indent + listPrefixMatch[1].length : indent;
		const kv = parseKeyValueLine(candidateText);
		if (kv && BLOCK_SCALAR_PATTERN.test(kv.value)) {
			inBlockScalar = true;
			blockScalarParentIndent = effectiveIndent;
		}
	}

	return structural;
}

function getSectionSlice(lines, topKey) {
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.indent !== 0) continue;
		const kv = parseKeyValueLine(line.text);
		if (!kv || kv.key !== topKey) continue;

		const children = [];
		for (let j = i + 1; j < lines.length; j += 1) {
			if (lines[j].indent === 0) break;
			children.push(lines[j]);
		}
		return { header: line, inlineValue: kv.value, children };
	}
	return null;
}

function parseConcurrencySection(lines) {
	const section = getSectionSlice(lines, "concurrency");
	if (!section) {
		return {
			present: false,
			group: null,
			cancelInProgressRaw: null,
			cancelInProgress: null,
		};
	}

	let groupRaw = null;
	let cancelRaw = null;
	if (section.inlineValue.startsWith("{")) {
		const flow = parseFlowMapping(section.inlineValue);
		if (flow?.has("group")) {
			groupRaw = unquoteYamlScalar(flow.get("group"));
		}
		if (flow?.has("cancel-in-progress")) {
			cancelRaw = unquoteYamlScalar(flow.get("cancel-in-progress"));
		}
	} else if (section.children.length > 0) {
		const childIndent = section.children[0].indent;
		for (const child of section.children) {
			if (child.indent !== childIndent) continue;
			const kv = parseKeyValueLine(child.text);
			if (!kv) continue;
			if (kv.key === "group") {
				groupRaw = unquoteYamlScalar(kv.value);
			} else if (kv.key === "cancel-in-progress") {
				cancelRaw = unquoteYamlScalar(kv.value);
			}
		}
	} else if (section.inlineValue) {
		groupRaw = unquoteYamlScalar(section.inlineValue);
	}

	const group = groupRaw && groupRaw.trim().length > 0 ? groupRaw.trim() : null;
	const cancelInProgress = cancelRaw === "true" ? true : cancelRaw === "false" ? false : null;
	return {
		present: true,
		group,
		cancelInProgressRaw: cancelRaw,
		cancelInProgress,
	};
}

function parsePushTagsFromOnSection(lines) {
	const section = getSectionSlice(lines, "on");
	if (!section) {
		return { pushTags: [], hasPushTagTrigger: false, hasPushVTagTrigger: false };
	}

	const pushTags = [];
	const collectTagsFromFlow = (pushRaw) => {
		const pushMap = parseFlowMapping(pushRaw);
		if (!pushMap?.has("tags")) return;
		const tagsVal = pushMap.get("tags");
		const seq = parseFlowSequence(tagsVal);
		if (seq) {
			pushTags.push(...seq);
		} else if (tagsVal) {
			pushTags.push(unquoteYamlScalar(tagsVal));
		}
	};

	if (section.inlineValue.startsWith("{")) {
		const onMap = parseFlowMapping(section.inlineValue);
		if (onMap?.has("push")) {
			collectTagsFromFlow(onMap.get("push"));
		}
	} else if (section.children.length > 0) {
		const eventIndent = section.children[0].indent;
		for (let i = 0; i < section.children.length; i += 1) {
			const child = section.children[i];
			if (child.indent !== eventIndent) continue;
			const kv = parseKeyValueLine(child.text);
			if (!kv || kv.key !== "push") continue;

			if (kv.value.startsWith("{")) {
				collectTagsFromFlow(kv.value);
				continue;
			}

			const pushChildren = [];
			for (let j = i + 1; j < section.children.length; j += 1) {
				if (section.children[j].indent <= eventIndent) break;
				pushChildren.push(section.children[j]);
			}
			if (pushChildren.length === 0) continue;

			const pushPropIndent = pushChildren[0].indent;
			for (let k = 0; k < pushChildren.length; k += 1) {
				const prop = pushChildren[k];
				if (prop.indent !== pushPropIndent) continue;
				const pkv = parseKeyValueLine(prop.text);
				if (!pkv || pkv.key !== "tags") continue;

				if (pkv.value) {
					const seq = parseFlowSequence(pkv.value);
					if (seq) {
						pushTags.push(...seq);
					} else {
						pushTags.push(unquoteYamlScalar(pkv.value));
					}
				} else {
					for (let m = k + 1; m < pushChildren.length; m += 1) {
						const item = pushChildren[m];
						if (item.indent < pushPropIndent) break;
						if (item.indent === pushPropIndent && !/^-\s+/.test(item.text)) break;
						const itemMatch = /^-\s+(.*)$/.exec(item.text);
						if (itemMatch) {
							pushTags.push(unquoteYamlScalar(itemMatch[1]));
						}
					}
				}
			}
		}
	}

	const normalizedTags = pushTags.map((tag) => tag.trim()).filter(Boolean);
	const hasPushTagTrigger = normalizedTags.length > 0;
	const hasPushVTagTrigger = normalizedTags.some((tag) => /^(?:v(?:\*|\[)|\*)/i.test(tag));
	return { pushTags: normalizedTags, hasPushTagTrigger, hasPushVTagTrigger };
}

function parseJobsSection(lines) {
	const section = getSectionSlice(lines, "jobs");
	if (!section || section.children.length === 0) {
		return [];
	}

	const jobs = [];
	const jobIndent = section.children[0].indent;
	let currentJob = null;
	let currentPropIndent = null;

	for (const line of section.children) {
		if (line.indent === jobIndent) {
			const kv = parseKeyValueLine(line.text);
			if (!kv) {
				currentJob = null;
				currentPropIndent = null;
				continue;
			}
			currentJob = {
				id: kv.key,
				lineNo: line.lineNo,
				uses: null,
				hasSteps: false,
				timeoutMinutesRaw: undefined,
				timeoutMinutes: null,
			};
			currentPropIndent = null;
			jobs.push(currentJob);
			continue;
		}

		if (!currentJob || line.indent < jobIndent) continue;
		if (currentPropIndent === null) {
			currentPropIndent = line.indent;
		}
		if (line.indent !== currentPropIndent) continue;

		const kv = parseKeyValueLine(line.text);
		if (!kv) continue;

		if (kv.key === "uses") {
			currentJob.uses = unquoteYamlScalar(kv.value);
		} else if (kv.key === "steps") {
			currentJob.hasSteps = true;
		} else if (kv.key === "timeout-minutes") {
			const raw = unquoteYamlScalar(kv.value);
			currentJob.timeoutMinutesRaw = raw;
			if (POSITIVE_INT_PATTERN.test(raw)) {
				currentJob.timeoutMinutes = Number.parseInt(raw, 10);
			}
		}
	}

	return jobs;
}

export function analyzeWorkflowYaml(content, relPath = "") {
	const lines = extractStructuralYamlLines(content);
	return {
		file: normalizeSlashes(relPath),
		jobs: parseJobsSection(lines),
		concurrency: parseConcurrencySection(lines),
		on: parsePushTagsFromOnSection(lines),
	};
}

function checkElectronBuilderContent(content) {
	const lines = extractStructuralYamlLines(content);
	let disableAutoUpdate = null;
	let publishRaw = null;
	let publishHasNestedBlock = false;

	const extraMeta = getSectionSlice(lines, "extraMetadata");
	if (extraMeta && extraMeta.children.length > 0) {
		const childIndent = extraMeta.children[0].indent;
		for (const child of extraMeta.children) {
			if (child.indent !== childIndent) continue;
			const kv = parseKeyValueLine(child.text);
			if (kv && kv.key === "disableAutoUpdate") {
				const val = unquoteYamlScalar(kv.value);
				disableAutoUpdate = val === "true" ? true : val === "false" ? false : val;
			}
		}
	}

	const publishSection = getSectionSlice(lines, "publish");
	if (publishSection) {
		publishRaw = publishSection.inlineValue ? unquoteYamlScalar(publishSection.inlineValue) : null;
		publishHasNestedBlock = publishSection.children.length > 0;
	}

	const publishIsNull =
		publishSection !== null && !publishHasNestedBlock && publishRaw === "null";

	return {
		disableAutoUpdate,
		publish: publishIsNull ? null : (publishRaw ?? (publishHasNestedBlock ? "<nested>" : undefined)),
		publishIsNull,
	};
}

async function readTextIfExists(absPath) {
	try {
		return await readFile(absPath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export async function verifyRepository(options = {}) {
	const rootDir = resolve(options.rootDir ?? DEFAULT_REPO_ROOT);
	const violations = [];

	// 1. Verify .github/CODEOWNERS
	const codeownersRel = ".github/CODEOWNERS";
	const codeownersText = await readTextIfExists(resolve(rootDir, codeownersRel));
	const activeOwners = [];
	let codeownersOk = true;

	if (codeownersText === null) {
		codeownersOk = false;
		violations.push({
			check: "codeowners",
			file: codeownersRel,
			message: "Missing .github/CODEOWNERS file.",
		});
	} else {
		for (const forbidden of FORBIDDEN_CODEOWNERS) {
			const forbiddenPattern = new RegExp(`${escapeRegExp(forbidden)}(?=$|[^A-Za-z0-9_-])`, "i");
			if (forbiddenPattern.test(codeownersText)) {
				codeownersOk = false;
				violations.push({
					check: "codeowners",
					file: codeownersRel,
					message: `Forbidden upstream owner "${forbidden}" found in .github/CODEOWNERS.`,
				});
			}
		}

		for (const line of codeownersText.split(/\r?\n/)) {
			const active = line.replace(/#.*$/, "").trim();
			if (!active) continue;
			const tokens = active.split(/\s+/);
			for (const token of tokens.slice(1)) {
				if (token.startsWith("@")) {
					activeOwners.push(token);
				}
			}
		}

		if (!activeOwners.includes(REQUIRED_CODEOWNER)) {
			codeownersOk = false;
			violations.push({
				check: "codeowners",
				file: codeownersRel,
				message: `Required maintainer "${REQUIRED_CODEOWNER}" is missing from active .github/CODEOWNERS rules.`,
			});
		}
	}

	// 2. Verify all .github/workflows/*.yml(yaml) files
	const workflowsDir = resolve(rootDir, ".github/workflows");
	let workflowFilenames = [];
	let workflowsOk = true;
	const workflowSummaries = [];
	const workflowsByName = new Map();
	let totalJobs = 0;
	let regularJobs = 0;
	let reusableCallerJobs = 0;

	try {
		const entries = await readdir(workflowsDir, { withFileTypes: true });
		workflowFilenames = entries
			.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			workflowsOk = false;
			violations.push({
				check: "workflows",
				file: ".github/workflows",
				message: "Missing .github/workflows directory.",
			});
		} else {
			throw error;
		}
	}

	if (workflowsOk && workflowFilenames.length === 0) {
		workflowsOk = false;
		violations.push({
			check: "workflows",
			file: ".github/workflows",
			message: "No workflow YAML files found under .github/workflows.",
		});
	}

	for (const filename of workflowFilenames) {
		const absFile = resolve(workflowsDir, filename);
		const relFile = normalizeSlashes(relative(rootDir, absFile));
		const content = await readFile(absFile, "utf8");
		const parsed = analyzeWorkflowYaml(content, relFile);
		workflowsByName.set(filename.toLowerCase(), parsed);

		if (parsed.jobs.length === 0) {
			workflowsOk = false;
			violations.push({
				check: "workflows",
				file: relFile,
				message: "Workflow defines no jobs under top-level `jobs:`.",
			});
		}

		for (const job of parsed.jobs) {
			totalJobs += 1;
			if (job.uses) {
				reusableCallerJobs += 1;
				if (job.timeoutMinutesRaw !== undefined) {
					workflowsOk = false;
					violations.push({
						check: "workflows",
						file: relFile,
						message: `Reusable workflow caller job "${job.id}" (uses: ${job.uses}) must NOT declare timeout-minutes.`,
					});
				}
			} else {
				regularJobs += 1;
				if (job.timeoutMinutesRaw === undefined) {
					workflowsOk = false;
					violations.push({
						check: "workflows",
						file: relFile,
						message: `Job "${job.id}" is missing explicit timeout-minutes (must be a positive integer <= ${MAX_JOB_TIMEOUT_MINUTES}).`,
					});
				} else if (
					job.timeoutMinutes === null ||
					job.timeoutMinutes <= 0 ||
					job.timeoutMinutes > MAX_JOB_TIMEOUT_MINUTES
				) {
					workflowsOk = false;
					violations.push({
						check: "workflows",
						file: relFile,
						message: `Job "${job.id}" has invalid timeout-minutes="${job.timeoutMinutesRaw}" (must be an integer in 1..${MAX_JOB_TIMEOUT_MINUTES}).`,
					});
				}
			}
		}

		workflowSummaries.push({
			file: relFile,
			jobs: parsed.jobs.map((job) => ({
				id: job.id,
				kind: job.uses ? "reusable-caller" : "regular",
				uses: job.uses,
				timeoutMinutes: job.timeoutMinutes,
			})),
		});
	}

	// 3a. Verify ci.yml concurrency group & cancel-in-progress: true
	const ciWorkflow = workflowsByName.get("ci.yml") ?? workflowsByName.get("ci.yaml") ?? null;
	let ciConcurrencyOk = true;
	if (!ciWorkflow) {
		ciConcurrencyOk = false;
		violations.push({
			check: "ciConcurrency",
			file: ".github/workflows/ci.yml",
			message: "Missing .github/workflows/ci.yml workflow.",
		});
	} else {
		if (!ciWorkflow.concurrency.present || !ciWorkflow.concurrency.group) {
			ciConcurrencyOk = false;
			violations.push({
				check: "ciConcurrency",
				file: ciWorkflow.file,
				message: 'Workflow ci.yml must define a non-empty top-level concurrency "group".',
			});
		}
		if (!ciWorkflow.concurrency.present || ciWorkflow.concurrency.cancelInProgress !== true) {
			ciConcurrencyOk = false;
			violations.push({
				check: "ciConcurrency",
				file: ciWorkflow.file,
				message: 'Workflow ci.yml must enable top-level concurrency with "cancel-in-progress: true".',
			});
		}
	}

	// 3b. Verify release.yml does not auto-trigger on any push tags
	const releaseWorkflow =
		workflowsByName.get("release.yml") ?? workflowsByName.get("release.yaml") ?? null;
	let releaseTriggerOk = true;
	if (releaseWorkflow?.on.hasPushTagTrigger) {
		releaseTriggerOk = false;
		violations.push({
			check: "releaseTrigger",
			file: releaseWorkflow.file,
			message: `Legacy release.yml must NOT auto-trigger on push tags (found: ${releaseWorkflow.on.pushTags.join(", ")}).`,
		});
	}

	// 4. Verify packages/desktop/electron-builder.wenyou.yml
	const builderRel = "packages/desktop/electron-builder.wenyou.yml";
	const builderText = await readTextIfExists(resolve(rootDir, builderRel));
	let electronBuilderOk = true;
	let builderStatus = {
		disableAutoUpdate: null,
		publish: undefined,
		publishIsNull: false,
	};

	if (builderText === null) {
		electronBuilderOk = false;
		violations.push({
			check: "electronBuilder",
			file: builderRel,
			message: `Missing ${builderRel} file.`,
		});
	} else {
		builderStatus = checkElectronBuilderContent(builderText);
		if (builderStatus.disableAutoUpdate !== true) {
			electronBuilderOk = false;
			violations.push({
				check: "electronBuilder",
				file: builderRel,
				message: `${builderRel} must keep extraMetadata.disableAutoUpdate: true.`,
			});
		}
		if (!builderStatus.publishIsNull) {
			electronBuilderOk = false;
			violations.push({
				check: "electronBuilder",
				file: builderRel,
				message: `${builderRel} must keep top-level "publish: null".`,
			});
		}
	}

	return {
		ok: violations.length === 0,
		mode: "verify",
		checks: {
			codeowners: {
				ok: codeownersOk,
				file: codeownersRel,
				owners: activeOwners,
			},
			workflows: {
				ok: workflowsOk,
				filesScanned: workflowFilenames.length,
				jobsChecked: totalJobs,
				regularJobs,
				reusableCallerJobs,
				maxAllowedTimeoutMinutes: MAX_JOB_TIMEOUT_MINUTES,
				files: workflowSummaries,
			},
			ciConcurrency: {
				ok: ciConcurrencyOk,
				file: ciWorkflow?.file ?? ".github/workflows/ci.yml",
				group: ciWorkflow?.concurrency.group ?? null,
				cancelInProgress: ciWorkflow?.concurrency.cancelInProgress ?? null,
			},
			releaseTrigger: {
				ok: releaseTriggerOk,
				file: releaseWorkflow?.file ?? ".github/workflows/release.yml",
				present: releaseWorkflow !== null,
				pushTags: releaseWorkflow?.on.pushTags ?? [],
				hasPushTagTrigger: releaseWorkflow?.on.hasPushTagTrigger ?? false,
				hasPushVTagTrigger: releaseWorkflow?.on.hasPushVTagTrigger ?? false,
			},
			electronBuilder: {
				ok: electronBuilderOk,
				file: builderRel,
				disableAutoUpdate: builderStatus.disableAutoUpdate,
				publish: builderStatus.publishIsNull ? null : builderStatus.publish,
			},
		},
		violations,
	};
}

export function buildGhApiArgs({ method, endpoint, hasBody = false }) {
	const args = [
		"api",
		"--method",
		method,
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version: 2022-11-28",
		endpoint,
	];
	if (hasBody) {
		args.push("--input", "-");
	}
	return args;
}

export function createGhApiRunner(options = {}) {
	const ghBin = options.ghBin ?? "gh";
	const timeoutMs = options.timeoutMs ?? 30_000;

	return function runGhApi({ method, endpoint, body }) {
		const hasBody = body !== undefined;
		const args = buildGhApiArgs({ method, endpoint, hasBody });

		return new Promise((resolvePromise, rejectPromise) => {
			const child = spawn(ghBin, args, {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			// Swallow EPIPE/EOF if child exits early before reading stdin.
			child.stdin.on("error", () => {});

			let stdout = "";
			let stderr = "";
			let settled = false;

			const finish = (err, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (err) {
					rejectPromise(err);
				} else {
					resolvePromise(value);
				}
			};

			const timer = setTimeout(() => {
				child.kill();
				finish(
					new Error(
						`gh api ${method} ${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s.`,
					),
				);
			}, timeoutMs);

			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				finish(new Error(`Failed to execute "${ghBin}": ${sanitizeTextForDisplay(error.message)}`));
			});
			child.on("close", (code) => {
				if (code !== 0) {
					const detail = sanitizeTextForDisplay((stderr || stdout || "").trim());
					finish(
						new Error(
							`gh api ${method} ${endpoint} failed with exit code ${code}${detail ? `: ${detail}` : ""}`,
						),
					);
					return;
				}
				const trimmed = stdout.trim();
				if (!trimmed) {
					finish(null, null);
					return;
				}
				try {
					finish(null, JSON.parse(trimmed));
				} catch (parseError) {
					finish(
						new Error(
							`gh api ${method} ${endpoint} returned non-JSON response: ${sanitizeTextForDisplay(parseError.message)}`,
						),
					);
				}
			});

			if (hasBody) {
				child.stdin.end(JSON.stringify(body));
			} else {
				child.stdin.end();
			}
		});
	};
}

export async function applyGitHubRepoConfig(options = {}) {
	const repo = validateRepoSlug(options.repo ?? DEFAULT_REPO);
	const runGh = options.runGh ?? createGhApiRunner();

	const workflowPermissionsPayload = buildWorkflowPermissionsPayload();
	const rulesetPayload = assertAntiLockoutRulesetPayload(buildAntiLockoutRulesetPayload());

	const permissionsEndpoint = `repos/${repo}/actions/permissions/workflow`;
	await runGh({
		method: "PUT",
		endpoint: permissionsEndpoint,
		body: workflowPermissionsPayload,
	});

	const rulesetsEndpoint = `repos/${repo}/rulesets`;
	const existingRulesets = await runGh({
		method: "GET",
		endpoint: rulesetsEndpoint,
	});
	if (!Array.isArray(existingRulesets)) {
		throw new Error(
			`Unexpected response from GET ${rulesetsEndpoint}: expected an array of rulesets.`,
		);
	}

	const existing = existingRulesets.find(
		(item) =>
			item &&
			item.name === ANTI_LOCKOUT_RULESET_NAME &&
			(item.source_type == null || item.source_type === "Repository"),
	);

	let rulesetResult;
	if (existing && existing.id != null) {
		const updateEndpoint = `${rulesetsEndpoint}/${existing.id}`;
		const updated = await runGh({
			method: "PUT",
			endpoint: updateEndpoint,
			body: rulesetPayload,
		});
		rulesetResult = {
			action: "updated",
			method: "PUT",
			endpoint: updateEndpoint,
			id: updated?.id ?? existing.id,
			name: ANTI_LOCKOUT_RULESET_NAME,
			payload: rulesetPayload,
		};
	} else {
		const created = await runGh({
			method: "POST",
			endpoint: rulesetsEndpoint,
			body: rulesetPayload,
		});
		rulesetResult = {
			action: "created",
			method: "POST",
			endpoint: rulesetsEndpoint,
			id: created?.id ?? null,
			name: ANTI_LOCKOUT_RULESET_NAME,
			payload: rulesetPayload,
		};
	}

	return {
		ok: true,
		mode: "apply",
		repo,
		workflowPermissions: {
			method: "PUT",
			endpoint: permissionsEndpoint,
			applied: true,
			payload: workflowPermissionsPayload,
		},
		ruleset: rulesetResult,
	};
}

export function parseConfigureArgs(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			verify: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			apply: { type: "boolean", default: false },
			repo: { type: "string" },
			root: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
		strict: true,
	});

	if (positionals.length > 0) {
		throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
	}

	const help = Boolean(values.help);
	const modes = [
		values.verify ? "verify" : null,
		values["dry-run"] ? "dry-run" : null,
		values.apply ? "apply" : null,
	].filter(Boolean);

	if (!help) {
		if (modes.length === 0) {
			throw new Error("Specify exactly one mode: --verify, --dry-run, or --apply.");
		}
		if (modes.length > 1) {
			throw new Error(
				`Modes ${modes.map((m) => `--${m}`).join(" and ")} are mutually exclusive.`,
			);
		}
	}

	const mode = modes[0] ?? null;
	const repo = values.repo !== undefined ? validateRepoSlug(values.repo) : DEFAULT_REPO;

	return {
		mode,
		repo,
		rootDir: values.root,
		help,
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/wenyou-release/configure-github-repo.mjs <mode> [options]",
			"",
			"Modes (mutually exclusive):",
			"  --verify                Run offline static anti-lockout verification on repo files",
			"  --dry-run               Print GitHub Actions permissions & Anti-Lockout Ruleset JSON",
			"  --apply                 Idempotently apply permissions & Anti-Lockout Ruleset via gh api",
			"",
			"Options:",
			`  --repo <owner/name>     Target GitHub repository (default: ${DEFAULT_REPO})`,
			"  --root <dir>            Override repository root directory for --verify",
			"  -h, --help              Show this help message",
		].join("\n"),
	);
}

function isMainModule() {
	if (!process.argv[1]) return false;
	const invoked = resolve(process.argv[1]);
	const self = resolve(MODULE_PATH);
	return process.platform === "win32"
		? invoked.toLowerCase() === self.toLowerCase()
		: invoked === self;
}

async function main() {
	const args = parseConfigureArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}

	if (args.mode === "verify") {
		const report = await verifyRepository({ rootDir: args.rootDir ?? DEFAULT_REPO_ROOT });
		console.log(JSON.stringify(report, null, 2));
		if (!report.ok) {
			for (const item of report.violations) {
				console.error(`[repo:guard] ${item.check} (${item.file}): ${item.message}`);
			}
			process.exitCode = 1;
		}
		return;
	}

	if (args.mode === "dry-run") {
		const plan = buildDryRunPlan(args.repo);
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	if (args.mode === "apply") {
		const result = await applyGitHubRepoConfig({ repo: args.repo });
		console.log(JSON.stringify(result, null, 2));
	}
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[repo:guard] ERROR: ${sanitizeTextForDisplay(message)}`);
		process.exitCode = 1;
	});
}
