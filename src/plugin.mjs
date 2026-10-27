import {
  WEEKLY_REVIEW_DECLARATION_PREFIX,
  isWorkshopReviewContext,
  loadGovernanceContext,
} from "./governance-context.mjs";

export function registerWorkshopGovernance(api) {
  let weeklyReviewJobIds = new Set();

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
    return { prependSystemContext: governance };
  });
}
