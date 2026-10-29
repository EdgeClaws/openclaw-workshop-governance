import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  commitWorkshopChanges,
  inspectGitWorkspace,
} from "../src/auto-provenance.mjs";
import {
  GOVERNANCE_CONTEXT_MARKER,
  extractCronJobId,
  isWorkshopReviewContext,
  loadGovernanceContext,
  resolveGovernanceReferencePaths,
} from "../src/governance-context.mjs";
import { registerWorkshopGovernance } from "../src/plugin.mjs";

const execFileAsync = promisify(execFile);

const lifecycleParts = ["skills", "openclaw-skill-plugin-lifecycle"];

function lifecyclePath(workspaceDir, ...parts) {
  return path.join(workspaceDir, ...lifecycleParts, ...parts);
}

async function fixtureWorkspace({ layout = "combined" } = {}) {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "workshop-governance-"),
  );
  await fs.mkdir(lifecyclePath(workspaceDir, "references"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspaceDir, "skills", "qa-device-control"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspaceDir, "skills", "folded-owner"), {
    recursive: true,
  });
  await fs.writeFile(
    lifecyclePath(workspaceDir, "SKILL.md"),
    "---\nname: openclaw-skill-plugin-lifecycle\ndescription: Canonical governance.\n---\n\n# Lifecycle\n\nOne owner per behavior.\n",
  );
  await fs.writeFile(
    path.join(workspaceDir, "skills", "qa-device-control", "SKILL.md"),
    "---\nname: qa-device-control\ndescription: Owns QA devices and light accounts.\n---\n",
  );
  await fs.writeFile(
    path.join(workspaceDir, "skills", "folded-owner", "SKILL.md"),
    "---\nname: folded-owner\ndescription: >\n  Owns folded descriptions\n  across lines.\n---\n",
  );

  if (layout === "combined") {
    await fs.writeFile(
      lifecyclePath(
        workspaceDir,
        "references",
        "workspace-skill-registry.json",
      ),
      JSON.stringify({
        schemaVersion: 1,
        marker: "combined-registry",
        authorization: {
          workspaceOwner: { principal: "workspace-owner" },
          skillEditorExceptions: {
            "qa-device-control": ["person:example-editor"],
          },
        },
        publication: {},
      }),
    );
  } else if (layout === "split") {
    await fs.writeFile(
      lifecyclePath(workspaceDir, "references", "authoring-ownership.json"),
      JSON.stringify({
        marker: "split-ownership",
        defaultPolicy: { workspaceOwner: "owner@example.com" },
      }),
    );
    await fs.writeFile(
      lifecyclePath(workspaceDir, "references", "repository-publication.json"),
      JSON.stringify({
        marker: "split-publication",
        defaults: { canonicalRepository: "enclosing-git-root" },
      }),
    );
  }
  return workspaceDir;
}

function fakeApi(workspaceDir, pluginConfig = {}) {
  const hooks = new Map();
  return {
    hooks,
    pluginConfig,
    config: {
      agents: {
        defaults: { workspace: workspaceDir },
      },
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  };
}

test("classifies experience and known weekly review lanes only", () => {
  const weekly = new Set(["weekly-1"]);
  assert.equal(
    isWorkshopReviewContext({ runId: "skill-workshop-review:abc" }, weekly),
    true,
  );
  assert.equal(
    isWorkshopReviewContext(
      { sessionKey: "agent:main:cron:weekly-1:run:session-1" },
      weekly,
    ),
    true,
  );
  assert.equal(
    isWorkshopReviewContext(
      { sessionKey: "agent:main:cron:other:run:session-1" },
      weekly,
    ),
    false,
  );
  assert.equal(isWorkshopReviewContext({ runId: "ordinary" }, weekly), false);
  assert.equal(
    extractCronJobId("agent:main:cron:weekly-1:run:session-1"),
    "weekly-1",
  );
});

test("auto-discovers a combined governance registry", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const paths = await resolveGovernanceReferencePaths(workspaceDir);
  assert.deepEqual(paths, [
    "skills/openclaw-skill-plugin-lifecycle/references/workspace-skill-registry.json",
  ]);

  const context = await loadGovernanceContext({
    pluginConfig: {},
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, new RegExp(GOVERNANCE_CONTEXT_MARKER));
  assert.match(context, /combined-registry/);
  assert.match(context, /person:example-editor/);
  assert.match(context, /`qa-device-control`/);
  assert.match(context, /Owns folded descriptions across lines\./);
  assert.doesNotMatch(context, /`openclaw-skill-plugin-lifecycle` —/);
});

test("auto-discovers Clawdia's split governance registries", async (t) => {
  const workspaceDir = await fixtureWorkspace({ layout: "split" });
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const paths = await resolveGovernanceReferencePaths(workspaceDir);
  assert.deepEqual(paths, [
    "skills/openclaw-skill-plugin-lifecycle/references/authoring-ownership.json",
    "skills/openclaw-skill-plugin-lifecycle/references/repository-publication.json",
  ]);

  const context = await loadGovernanceContext({
    pluginConfig: {},
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, /split-ownership/);
  assert.match(context, /split-publication/);
});

test("explicit reference lists win over the single-registry shortcut", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.writeFile(
    lifecyclePath(workspaceDir, "references", "custom-governance.json"),
    JSON.stringify({ marker: "explicit-reference" }),
  );
  const context = await loadGovernanceContext({
    pluginConfig: {
      governanceReferencePaths: [
        "skills/openclaw-skill-plugin-lifecycle/references/custom-governance.json",
      ],
      workspaceSkillRegistryPath: "missing/ignored.json",
    },
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, /explicit-reference/);
  assert.doesNotMatch(context, /combined-registry/);
  assert.doesNotMatch(context, /missing\/ignored/);
});

test("supports the single combined-registry shortcut", async (t) => {
  const workspaceDir = await fixtureWorkspace({ layout: "none" });
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(workspaceDir, "single-registry.json"),
    JSON.stringify({ marker: "single-registry-shortcut" }),
  );
  const context = await loadGovernanceContext({
    pluginConfig: { workspaceSkillRegistryPath: "single-registry.json" },
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, /single-registry-shortcut/);
});

test("missing or malformed governance references fall back owner-only", async (t) => {
  const workspaceDir = await fixtureWorkspace({ layout: "none" });
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspaceDir, "broken.json"), "{ nope\n");
  const context = await loadGovernanceContext({
    pluginConfig: {
      governanceReferencePaths: ["missing.json", "broken.json"],
    },
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, /MISSING: use the lifecycle skill's owner-only fallback/);
  assert.match(context, /INVALID JSON .*owner-only fallback/);
  assert.match(context, /never infer a grant/);
  assert.doesNotMatch(context, /\{ nope/);
});

test("unsupported combined registry schemas fall back owner-only", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await fs.writeFile(
    lifecyclePath(
      workspaceDir,
      "references",
      "workspace-skill-registry.json",
    ),
    JSON.stringify({ schemaVersion: 2, marker: "must-not-be-authority" }),
  );
  const context = await loadGovernanceContext({
    pluginConfig: {},
    openclawConfig: { agents: { defaults: { workspace: workspaceDir } } },
    ctx: { agentId: "main" },
  });
  assert.match(context, /UNSUPPORTED WORKSPACE REGISTRY SCHEMA \(2\)/);
  assert.match(context, /owner-only fallback/);
  assert.doesNotMatch(context, /must-not-be-authority/);
});

test("rejects malformed explicit reference configuration", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  await assert.rejects(
    resolveGovernanceReferencePaths(workspaceDir, {
      governanceReferencePaths: [],
    }),
    /nonempty array of paths/,
  );
  await assert.rejects(
    resolveGovernanceReferencePaths(workspaceDir, {
      governanceReferencePaths: "registry.json",
    }),
    /nonempty array of paths/,
  );
});

test("manifest declares hook startup, provenance, and registry configuration", async () => {
  const manifest = JSON.parse(
    await fs.readFile(
      new URL("../openclaw.plugin.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.activation.onStartup, true);
  assert.deepEqual(manifest.activation.onCapabilities, ["hook"]);
  assert.equal(
    manifest.configSchema.properties.governanceReferencePaths.minItems,
    1,
  );
  assert.equal(
    manifest.configSchema.properties.workspaceSkillRegistryPath.type,
    "string",
  );
  assert.equal(
    manifest.configSchema.properties.autoCommitProvenance.type,
    "boolean",
  );
});

test("commits successful autonomous edits with provenance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workshop-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await fs.writeFile(path.join(root, "SKILL.md"), "initial\n");
  await execFileAsync("git", ["-C", root, "add", "SKILL.md"]);
  await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
  const baseline = await inspectGitWorkspace(root);
  await fs.appendFile(path.join(root, "SKILL.md"), "updated\n");
  const result = await commitWorkshopChanges({
    baseline,
    runId: "skill-workshop-review:test",
    agentId: "main",
  });
  assert.equal(result.action, "committed");
  assert.equal((await inspectGitWorkspace(root)).status, "");
  const { stdout } = await execFileAsync("git", [
    "-C",
    root,
    "log",
    "-1",
    "--format=%B",
  ]);
  assert.match(stdout, /Change-Origin: workshop-autonomous/);
  assert.match(stdout, /Source-Context: skill-workshop-review:test/);
});

test("auto review hooks gate a clean baseline and commit at agent end", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  const workshopDir = await fs.mkdtemp(path.join(os.tmpdir(), "workshop-hook-"));
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  t.after(() => fs.rm(workshopDir, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q", workshopDir]);
  await execFileAsync("git", ["-C", workshopDir, "config", "user.name", "Test"]);
  await execFileAsync("git", [
    "-C",
    workshopDir,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await fs.writeFile(path.join(workshopDir, "SKILL.md"), "initial\n");
  await execFileAsync("git", ["-C", workshopDir, "add", "SKILL.md"]);
  await execFileAsync("git", [
    "-C",
    workshopDir,
    "commit",
    "-q",
    "-m",
    "initial",
  ]);

  const api = fakeApi(workspaceDir, { autoCommitProvenance: true });
  api.config.skills = { workshop: { autonomous: { mode: "auto" } } };
  registerWorkshopGovernance(api);
  await api.hooks.get("cron_reconciled")(
    { reason: "startup", enabled: true },
    {
      getCron: () => ({
        list: async () => [
          { id: "weekly-1", declarationKey: "skill-collection-review:main" },
        ],
      }),
    },
  );
  const ctx = {
    runId: "run-1",
    agentId: "main",
    sessionKey: "agent:main:cron:weekly-1:run:session-1",
    workspaceDir: workshopDir,
    hookInvocation: { assertActive() {} },
  };
  await api.hooks.get("before_prompt_build")(
    { prompt: "review", messages: [] },
    ctx,
  );
  assert.deepEqual(
    await api.hooks.get("before_agent_run")({ runId: "run-1" }, ctx),
    { outcome: "pass" },
  );
  await fs.appendFile(path.join(workshopDir, "SKILL.md"), "updated\n");
  await api.hooks.get("agent_end")(
    { runId: "run-1", messages: [], success: true },
    ctx,
  );
  const { stdout } = await execFileAsync("git", [
    "-C",
    workshopDir,
    "log",
    "-1",
    "--format=%B",
  ]);
  assert.match(stdout, /Change-Origin: workshop-autonomous/);
  assert.equal((await inspectGitWorkspace(workshopDir)).status, "");
});

test("injects into propose and auto reviews, never ordinary turns", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const api = fakeApi(workspaceDir);
  registerWorkshopGovernance(api);
  const promptHook = api.hooks.get("before_prompt_build");
  let activeChecks = 0;

  for (const modeLabel of ["propose", "auto"]) {
    const result = await promptHook(
      { prompt: modeLabel, messages: [] },
      {
        runId: `skill-workshop-review:${modeLabel}`,
        agentId: "main",
        workspaceDir:
          modeLabel === "auto" ? "/isolated/workshop-root" : workspaceDir,
        hookInvocation: { assertActive: () => activeChecks++ },
      },
    );
    assert.match(result.prependSystemContext, /# Lifecycle/);
  }
  assert.equal(activeChecks, 2);

  assert.equal(
    await promptHook(
      { prompt: "ordinary", messages: [] },
      { runId: "ordinary", agentId: "main", workspaceDir },
    ),
    undefined,
  );
});

test("reloads the canonical lifecycle and registry on every review", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const api = fakeApi(workspaceDir);
  registerWorkshopGovernance(api);
  const promptHook = api.hooks.get("before_prompt_build");
  const ctx = {
    runId: "skill-workshop-review:dynamic",
    agentId: "main",
    workspaceDir,
  };

  const first = await promptHook({ prompt: "first", messages: [] }, ctx);
  assert.match(first.prependSystemContext, /One owner per behavior\./);

  await fs.appendFile(
    lifecyclePath(workspaceDir, "SKILL.md"),
    "\nCurrent lifecycle revision.\n",
  );
  const second = await promptHook({ prompt: "second", messages: [] }, ctx);
  assert.match(second.prependSystemContext, /Current lifecycle revision\./);

  await fs.writeFile(
    lifecyclePath(
      workspaceDir,
      "references",
      "workspace-skill-registry.json",
    ),
    JSON.stringify({ schemaVersion: 1, marker: "current-registry-revision" }),
  );
  const third = await promptHook({ prompt: "third", messages: [] }, ctx);
  assert.match(third.prependSystemContext, /current-registry-revision/);
});

test("maps the weekly auto job and injects the same governance context", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const api = fakeApi(workspaceDir);
  registerWorkshopGovernance(api);
  await api.hooks.get("cron_reconciled")(
    { reason: "startup", enabled: true },
    {
      getCron: () => ({
        list: async () => [
          { id: "weekly-1", declarationKey: "skill-collection-review:main" },
          { id: "other", declarationKey: "other:main" },
        ],
      }),
    },
  );

  const injected = await api.hooks.get("before_prompt_build")(
    { prompt: "weekly", messages: [] },
    {
      agentId: "main",
      sessionKey: "agent:main:cron:weekly-1:run:session-1",
      workspaceDir: "/isolated/workshop-root",
    },
  );
  assert.match(injected.prependSystemContext, /WORKSHOP_GOVERNANCE_CONTEXT_V2/);
  assert.match(injected.prependSystemContext, /One owner per behavior\./);
  assert.match(injected.prependSystemContext, /qa-device-control/);
  assert.equal(api.hooks.has("before_agent_run"), true);
  assert.equal(api.hooks.has("agent_end"), true);
});

test("surfaces a missing canonical lifecycle file from the prompt hook", async () => {
  const api = fakeApi("/definitely/missing/workspace");
  registerWorkshopGovernance(api);
  await assert.rejects(
    api.hooks.get("before_prompt_build")(
      { prompt: "review", messages: [] },
      { runId: "skill-workshop-review:missing", agentId: "main" },
    ),
    /ENOENT/,
  );
});
