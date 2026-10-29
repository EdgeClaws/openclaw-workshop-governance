import {
  WEEKLY_REVIEW_DECLARATION_PREFIX,
  isWorkshopReviewContext,
  loadGovernanceContext,
} from "./governance-context.mjs";
import {
  commitWorkshopChanges,
  inspectGitWorkspace,
  reviewRunKey,
} from "./auto-provenance.mjs";

export function registerWorkshopGovernance(api) {
  let weeklyReviewJobIds = new Set();
  const reviewBaselines = new Map();
  const activeRoots = new Map();

  const autoProvenanceEnabled = () =>
    api.pluginConfig?.autoCommitProvenance === true &&
    api.config?.skills?.workshop?.autonomous?.mode === "auto";

  const replaceWeeklyJobs = async (cron) => {
    const jobs = cron ? await cron.list({ includeDisabled: true }) : [];
    weeklyReviewJobIds = new Set(
      jobs
        .filter((job) =>
          job.declarationKey?.startsWith(WEEKLY_REVIEW_DECLARATION_PREFIX),
        )
        .map((job) => job.id),
    );
  };

  api.on("cron_reconciled", async (event, ctx) => {
    if (!event.enabled) {
      weeklyReviewJobIds = new Set();
      return;
    }
    await replaceWeeklyJobs(ctx.getCron?.());
  });

  api.on("cron_changed", (event) => {
    if (event.action === "removed") {
      weeklyReviewJobIds.delete(event.jobId);
      return;
    }
    if (
      event.job?.declarationKey?.startsWith(WEEKLY_REVIEW_DECLARATION_PREFIX)
    ) {
      weeklyReviewJobIds.add(event.jobId);
    } else if (event.action === "updated") {
      weeklyReviewJobIds.delete(event.jobId);
    }
  });

  api.on("before_prompt_build", async (_event, ctx) => {
    if (!isWorkshopReviewContext(ctx, weeklyReviewJobIds)) return;
    const governance = await loadGovernanceContext({
      pluginConfig: api.pluginConfig,
      openclawConfig: api.config,
      ctx,
    });
    if (autoProvenanceEnabled()) {
      const key = reviewRunKey(_event, ctx);
      if (!key) throw new Error("Workshop review has no stable run identity.");
      const baseline = await inspectGitWorkspace(ctx.workspaceDir);
      if (baseline.status) {
        throw new Error(
          "Workshop Git tree is dirty; autonomous maintenance is blocked.",
        );
      }
      const activeKey = activeRoots.get(baseline.root);
      if (activeKey && activeKey !== key) {
        throw new Error(
          "Another autonomous Workshop review already owns this Git tree.",
        );
      }
      reviewBaselines.set(key, baseline);
      activeRoots.set(baseline.root, key);
    }
    ctx.hookInvocation?.assertActive?.();
    return { prependSystemContext: governance };
  });

  api.on("before_agent_run", async (event, ctx) => {
    if (!autoProvenanceEnabled()) return;
    if (!isWorkshopReviewContext(ctx, weeklyReviewJobIds)) return;
    const key = reviewRunKey(event, ctx);
    const baseline = key ? reviewBaselines.get(key) : undefined;
    if (!baseline) {
      return {
        outcome: "block",
        reason: "workshop-provenance-baseline-missing",
        message: "Workshop autonomous maintenance was blocked before editing.",
      };
    }
    const current = await inspectGitWorkspace(baseline.root);
    if (current.head !== baseline.head || current.status) {
      reviewBaselines.delete(key);
      activeRoots.delete(baseline.root);
      return {
        outcome: "block",
        reason: "workshop-provenance-baseline-changed",
        message:
          "Workshop autonomous maintenance was blocked by a changed Git baseline.",
      };
    }
    return { outcome: "pass" };
  });

  api.on("agent_end", async (event, ctx) => {
    if (!autoProvenanceEnabled()) return;
    if (!isWorkshopReviewContext(ctx, weeklyReviewJobIds)) return;
    const key = reviewRunKey(event, ctx);
    const baseline = key ? reviewBaselines.get(key) : undefined;
    if (key) reviewBaselines.delete(key);
    if (!baseline) {
      throw new Error("Workshop provenance baseline is missing at agent end.");
    }
    try {
      if (!event.success) return;
      await commitWorkshopChanges({
        baseline,
        runId: event.runId ?? ctx.runId,
        agentId: ctx.agentId,
      });
    } finally {
      activeRoots.delete(baseline.root);
    }
  });
}
