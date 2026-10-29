import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

export function reviewRunKey(event, ctx) {
  return event?.runId ?? ctx?.runId ?? ctx?.sessionKey;
}

export async function inspectGitWorkspace(workspaceDir) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) {
    throw new Error("Workshop review has no workspace directory.");
  }
  const resolved = path.resolve(workspaceDir);
  const root = path.resolve(await git(resolved, ["rev-parse", "--show-toplevel"]));
  if (root !== resolved) {
    throw new Error(
      `Workshop Git root mismatch: expected ${resolved}, received ${root}.`,
    );
  }
  return {
    root,
    head: await git(root, ["rev-parse", "HEAD"]),
    status: await git(root, ["status", "--porcelain=v1"]),
  };
}

async function commitsHaveWorkshopProvenance(root, baselineHead) {
  const bodies = await git(root, [
    "log",
    "--format=%B%x00",
    `${baselineHead}..HEAD`,
  ]);
  const commits = bodies.split("\0").map((body) => body.trim()).filter(Boolean);
  return (
    commits.length > 0 &&
    commits.every((body) =>
      /^Change-Origin:\s*workshop-autonomous\s*$/mu.test(body),
    )
  );
}

export async function commitWorkshopChanges({ baseline, runId, agentId }) {
  const current = await inspectGitWorkspace(baseline.root);
  if (current.head !== baseline.head) {
    if (current.status) {
      throw new Error(
        "Workshop review created commits but left additional uncommitted changes.",
      );
    }
    if (!(await commitsHaveWorkshopProvenance(current.root, baseline.head))) {
      throw new Error(
        "Workshop review created a commit without workshop-autonomous provenance.",
      );
    }
    return { action: "verified", head: current.head };
  }

  if (!current.status) return { action: "nothing", head: current.head };

  await git(current.root, ["add", "-A"]);
  const staged = await git(current.root, ["diff", "--cached", "--name-only"]);
  if (!staged) return { action: "nothing", head: current.head };

  const source = runId || "unknown-review-run";
  const actor = agentId || "OpenClaw Workshop";
  await git(current.root, [
    "commit",
    "-m",
    "chore(workshop): record autonomous maintenance",
    "-m",
    `Initiated-By: ${actor}\nChange-Origin: workshop-autonomous\nSource-Context: ${source}`,
  ]);
  const committed = await inspectGitWorkspace(current.root);
  if (committed.status) {
    throw new Error("Workshop provenance commit left the repository dirty.");
  }
  return { action: "committed", head: committed.head };
}
