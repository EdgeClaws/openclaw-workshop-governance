import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EXPERIENCE_REVIEW_RUN_PREFIX = "skill-workshop-review:";
export const WEEKLY_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";
export const GOVERNANCE_CONTEXT_MARKER = "WORKSHOP_GOVERNANCE_CONTEXT_V2";
export const DEFAULT_LIFECYCLE_SKILL_PATH =
  "skills/openclaw-skill-plugin-lifecycle/SKILL.md";
export const DEFAULT_COMBINED_GOVERNANCE_REFERENCE_PATH =
  "skills/openclaw-skill-plugin-lifecycle/references/workspace-skill-registry.json";
export const DEFAULT_SPLIT_GOVERNANCE_REFERENCE_PATHS = [
  "skills/openclaw-skill-plugin-lifecycle/references/authoring-ownership.json",
  "skills/openclaw-skill-plugin-lifecycle/references/repository-publication.json",
];

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveConfiguredPath(workspaceDir, configuredPath) {
  const expanded = expandHome(configuredPath);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceDir, expanded);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function xmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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
  if (typeof explicit === "string" && explicit.trim()) {
    return path.resolve(expandHome(explicit));
  }
  const configured = resolveAgentWorkspace(openclawConfig, ctx?.agentId);
  if (configured) return path.resolve(expandHome(configured));
  if (typeof ctx?.workspaceDir === "string" && ctx.workspaceDir.trim()) {
    return path.resolve(expandHome(ctx.workspaceDir));
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

export async function resolveGovernanceReferencePaths(
  workspaceDir,
  pluginConfig = {},
) {
  if (pluginConfig.governanceReferencePaths !== undefined) {
    const configuredPaths = pluginConfig.governanceReferencePaths;
    if (
      !Array.isArray(configuredPaths) ||
      configuredPaths.length === 0 ||
      configuredPaths.some(
        (configuredPath) =>
          typeof configuredPath !== "string" || !configuredPath.trim(),
      )
    ) {
      throw new Error(
        "governanceReferencePaths must be a nonempty array of paths.",
      );
    }
    return [...new Set(configuredPaths)];
  }

  if (pluginConfig.workspaceSkillRegistryPath !== undefined) {
    const configuredPath = pluginConfig.workspaceSkillRegistryPath;
    if (typeof configuredPath !== "string" || !configuredPath.trim()) {
      throw new Error("workspaceSkillRegistryPath must be a nonempty path.");
    }
    return [configuredPath];
  }

  const combinedPath = resolveConfiguredPath(
    workspaceDir,
    DEFAULT_COMBINED_GOVERNANCE_REFERENCE_PATH,
  );
  if (await exists(combinedPath)) {
    return [DEFAULT_COMBINED_GOVERNANCE_REFERENCE_PATH];
  }

  const splitPresence = await Promise.all(
    DEFAULT_SPLIT_GOVERNANCE_REFERENCE_PATHS.map((configuredPath) =>
      exists(resolveConfiguredPath(workspaceDir, configuredPath)),
    ),
  );
  if (splitPresence.some(Boolean)) {
    return DEFAULT_SPLIT_GOVERNANCE_REFERENCE_PATHS;
  }

  return [DEFAULT_COMBINED_GOVERNANCE_REFERENCE_PATH];
}

export async function loadGovernanceReferences(workspaceDir, configuredPaths) {
  return Promise.all(
    configuredPaths.map(async (configuredPath) => {
      const absolutePath = resolveConfiguredPath(workspaceDir, configuredPath);
      const relativePath = path.relative(workspaceDir, absolutePath);
      try {
        const source = await fs.readFile(absolutePath, "utf8");
        if (path.extname(absolutePath).toLowerCase() === ".json") {
          try {
            const parsed = JSON.parse(source);
            const isWorkspaceRegistry =
              path.basename(absolutePath) === "workspace-skill-registry.json";
            if (
              (isWorkspaceRegistry || parsed?.schemaVersion !== undefined) &&
              parsed?.schemaVersion !== 1
            ) {
              return {
                relativePath,
                source: undefined,
                issue: `UNSUPPORTED WORKSPACE REGISTRY SCHEMA (${String(parsed?.schemaVersion ?? "missing")})`,
              };
            }
          } catch (error) {
            return {
              relativePath,
              source: undefined,
              issue: `INVALID JSON (${error.message})`,
            };
          }
        }
        return {
          relativePath,
          source,
        };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        return { relativePath, source: undefined, issue: "MISSING" };
      }
    }),
  );
}

export function renderGovernanceContext({
  lifecycleSource,
  lifecyclePath,
  owners,
  references = [],
}) {
  const ownerLines = owners.length
    ? owners.map(
        ({ name, description, relativePath }) =>
          `- \`${name}\` — ${description} (\`${relativePath}\`)`,
      )
    : ["- No repository/workspace skills were found."];

  const referenceLines = references.flatMap(({ relativePath, source, issue }) => [
    `<governance_reference path="${xmlAttribute(relativePath)}">`,
    source?.trim() ||
      `${issue ?? "UNAVAILABLE"}: use the lifecycle skill's owner-only fallback; never infer a grant.`,
    "</governance_reference>",
  ]);

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
    "<governance_references>",
    ...referenceLines,
    "</governance_references>",
    "",
    "<current_repository_skill_inventory>",
    ...ownerLines,
    "</current_repository_skill_inventory>",
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
    ? path.resolve(expandHome(configuredPath))
    : path.resolve(workspaceDir, expandHome(configuredPath));
  const configuredReferencePaths = await resolveGovernanceReferencePaths(
    workspaceDir,
    pluginConfig,
  );
  const [lifecycleSource, owners, references] = await Promise.all([
    fs.readFile(lifecyclePath, "utf8"),
    listWorkspaceSkillOwners(workspaceDir, lifecyclePath),
    loadGovernanceReferences(workspaceDir, configuredReferencePaths),
  ]);
  return renderGovernanceContext({
    lifecycleSource,
    lifecyclePath: path.relative(workspaceDir, lifecyclePath),
    owners,
    references,
  });
}
