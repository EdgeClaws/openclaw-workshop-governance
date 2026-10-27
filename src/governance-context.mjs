import fs from "node:fs/promises";
import path from "node:path";

export const EXPERIENCE_REVIEW_RUN_PREFIX = "skill-workshop-review:";
export const WEEKLY_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";
export const GOVERNANCE_CONTEXT_MARKER = "WORKSHOP_GOVERNANCE_CONTEXT_V1";
export const DEFAULT_LIFECYCLE_SKILL_PATH =
  "skills/openclaw-skill-plugin-lifecycle/SKILL.md";

function scalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  if (/^[>|][-+]?$/u.test(value)) {
    const tail = frontmatter.slice(match.index + match[0].length);
    const block = [];
    for (const line of tail.split(/\r?\n/u)) {
      if (!line.trim()) {
        if (block.length) block.push("");
        continue;
      }
      if (!/^\s/u.test(line)) break;
      block.push(line.trim());
    }
    return block.join(" ").trim() || undefined;
  }
  return value.replace(/^['"]|['"]$/g, "").trim();
}

export function parseSkillSummary(source, fallbackName, relativePath) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const name = scalar(frontmatter, "name") ?? fallbackName;
  const description = scalar(frontmatter, "description") ?? "No description.";
  return {
    name,
    description: description.replace(/\s+/g, " ").slice(0, 240),
    relativePath,
  };
}

export function extractCronJobId(sessionKey) {
  if (typeof sessionKey !== "string") return undefined;
  return sessionKey.match(/(?:^|:)cron:([^:]+)(?::run:|$)/)?.[1];
}

export function isWorkshopReviewContext(ctx, weeklyReviewJobIds) {
  if (ctx?.runId?.startsWith(EXPERIENCE_REVIEW_RUN_PREFIX)) return true;
  const jobId = ctx?.jobId ?? extractCronJobId(ctx?.sessionKey);
  return typeof jobId === "string" && weeklyReviewJobIds.has(jobId);
}

export function resolveAgentWorkspace(openclawConfig, agentId) {
  const agents = openclawConfig?.agents;
  const entries = agents?.entries;
  if (entries && !Array.isArray(entries)) {
    const configured = entries[agentId]?.workspace;
    if (typeof configured === "string" && configured.trim()) return configured;
  }
  if (Array.isArray(entries)) {
    const configured = entries.find((entry) => entry?.id === agentId)?.workspace;
    if (typeof configured === "string" && configured.trim()) return configured;
  }
  const fallback = agents?.defaults?.workspace;
  if (typeof fallback === "string" && fallback.trim()) return fallback;
  return undefined;
}

export function resolveGovernanceWorkspace({ pluginConfig, openclawConfig, ctx }) {
  const explicit = pluginConfig?.workspaceDir;
  if (typeof explicit === "string" && explicit.trim()) return path.resolve(explicit);
  const configured = resolveAgentWorkspace(openclawConfig, ctx?.agentId);
  if (configured) return path.resolve(configured);
  if (typeof ctx?.workspaceDir === "string" && ctx.workspaceDir.trim()) {
    return path.resolve(ctx.workspaceDir);
  }
  throw new Error("No canonical agent workspace is configured.");
}

export async function listWorkspaceSkillOwners(workspaceDir, lifecyclePath) {
  const skillsDir = path.join(workspaceDir, "skills");
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const summaries = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (path.resolve(skillPath) === path.resolve(lifecyclePath)) continue;
    try {
      const source = await fs.readFile(skillPath, "utf8");
      summaries.push(
        parseSkillSummary(
          source,
          entry.name,
          path.relative(workspaceDir, skillPath),
        ),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return summaries;
}

export function renderGovernanceContext({ lifecycleSource, lifecyclePath, owners }) {
  const ownerLines = owners.length
    ? owners.map(
        ({ name, description, relativePath }) =>
          `- \`${name}\` — ${description} (\`${relativePath}\`)`,
      )
    : ["- No repository/workspace skills were found."];

  return [
    GOVERNANCE_CONTEXT_MARKER,
    "# Autonomous Skill Workshop governance",
    `The canonical lifecycle source below was loaded at run time from \`${lifecyclePath}\`.`,
    "It remains the single policy authority; this plugin is only its runtime adapter.",
    "",
    "<canonical_lifecycle_skill>",
    lifecycleSource.trim(),
    "</canonical_lifecycle_skill>",
    "",
    "<current_repository_skill_owners>",
    ...ownerLines,
    "</current_repository_skill_owners>",
  ].join("\n");
}

export async function loadGovernanceContext({ pluginConfig, openclawConfig, ctx }) {
  const workspaceDir = resolveGovernanceWorkspace({
    pluginConfig,
    openclawConfig,
    ctx,
  });
  const configuredPath =
    pluginConfig?.lifecycleSkillPath ?? DEFAULT_LIFECYCLE_SKILL_PATH;
  const lifecyclePath = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(workspaceDir, configuredPath);
  const [lifecycleSource, owners] = await Promise.all([
    fs.readFile(lifecyclePath, "utf8"),
    listWorkspaceSkillOwners(workspaceDir, lifecyclePath),
  ]);
  return renderGovernanceContext({
    lifecycleSource,
    lifecyclePath: path.relative(workspaceDir, lifecyclePath),
    owners,
  });
}
