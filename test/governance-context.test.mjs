import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GOVERNANCE_CONTEXT_MARKER,
  extractCronJobId,
  isWorkshopReviewContext,
  loadGovernanceContext,
} from "../src/governance-context.mjs";
import { registerWorkshopGovernance } from "../src/plugin.mjs";

async function fixtureWorkspace() {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "workshop-governance-"),
  );
  await fs.mkdir(
    path.join(workspaceDir, "skills", "openclaw-skill-plugin-lifecycle"),
    { recursive: true },
  );
  await fs.mkdir(path.join(workspaceDir, "skills", "qa-device-control"), {
    recursive: true,
  });
  await fs.mkdir(path.join(workspaceDir, "skills", "folded-owner"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      workspaceDir,
      "skills",
      "openclaw-skill-plugin-lifecycle",
      "SKILL.md",
    ),
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
  return workspaceDir;
}

function fakeApi(workspaceDir) {
  const hooks = new Map();
  return {
    hooks,
    pluginConfig: {},
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

test("loads the canonical lifecycle and a compact external-owner index", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const context = await loadGovernanceContext({
    pluginConfig: {},
    openclawConfig: {
      agents: { defaults: { workspace: workspaceDir } },
    },
    ctx: { agentId: "main" },
  });
  assert.match(context, new RegExp(GOVERNANCE_CONTEXT_MARKER));
  assert.match(context, /One owner per behavior\./);
  assert.match(context, /`qa-device-control`/);
  assert.match(context, /Owns folded descriptions across lines\./);
  assert.doesNotMatch(context, /`openclaw-skill-plugin-lifecycle` —/);
});

test("manifest declares explicit startup activation", async () => {
  const manifest = JSON.parse(
    await fs.readFile(
      new URL("../openclaw.plugin.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.activation.onStartup, true);
});

test("injects into propose and auto experience reviews, never ordinary turns", async (t) => {
  const workspaceDir = await fixtureWorkspace();
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));
  const api = fakeApi(workspaceDir);
  registerWorkshopGovernance(api);
  const promptHook = api.hooks.get("before_prompt_build");

  for (const modeLabel of ["propose", "auto"]) {
    const result = await promptHook(
      { prompt: modeLabel, messages: [] },
      {
        runId: `skill-workshop-review:${modeLabel}`,
        agentId: "main",
        workspaceDir:
          modeLabel === "auto" ? "/isolated/workshop-root" : workspaceDir,
      },
    );
    assert.match(result.prependSystemContext, /# Lifecycle/);
  }

  assert.equal(
    await promptHook(
      { prompt: "ordinary", messages: [] },
      { runId: "ordinary", agentId: "main", workspaceDir },
    ),
    undefined,
  );
});

test("reloads the canonical lifecycle on every targeted review", async (t) => {
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
    path.join(
      workspaceDir,
      "skills",
      "openclaw-skill-plugin-lifecycle",
      "SKILL.md",
    ),
    "\nCurrent lifecycle revision.\n",
  );
  const second = await promptHook({ prompt: "second", messages: [] }, ctx);
  assert.match(second.prependSystemContext, /Current lifecycle revision\./);
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
          {
            id: "weekly-1",
            declarationKey: "skill-collection-review:main",
          },
          { id: "other", declarationKey: "other:main" },
        ],
      }),
    },
  );

  const ctx = {
    agentId: "main",
    sessionKey: "agent:main:cron:weekly-1:run:session-1",
    workspaceDir: "/isolated/workshop-root",
  };
  const injected = await api.hooks.get("before_prompt_build")(
    { prompt: "weekly", messages: [] },
    ctx,
  );
  assert.match(injected.prependSystemContext, /WORKSHOP_GOVERNANCE_CONTEXT_V1/);
  assert.match(injected.prependSystemContext, /One owner per behavior\./);
  assert.match(injected.prependSystemContext, /qa-device-control/);
  assert.equal(api.hooks.has("before_agent_run"), false);
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
