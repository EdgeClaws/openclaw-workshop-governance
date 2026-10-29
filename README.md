# OpenClaw Workshop Governance Context

A narrow OpenClaw hook plugin that gives autonomous Skill Workshop reviews the
same canonical skill/plugin lifecycle guidance used by foreground authoring.
It reads that guidance and its governance registries at run time, then adds a
compact index of current repository/workspace skills. It does not contain a
second copy of policy and does not run a second review pass. When
`autoCommitProvenance` is enabled, it also blocks dirty starting trees and
commits successful direct-auto maintenance with Git provenance.

The editable upstream is this repository. The
`openclaw-skill-plugin-lifecycle` skill also carries a checksum-verified
vendored copy so operators can install the adapter directly from the skill
bundle without a second clone.

## Covered lanes

- detached experience capture in Workshop `propose` mode;
- detached experience maintenance in Workshop `auto` mode;
- the weekly collection review that exists in `auto` mode.

Ordinary user turns and foreground repairs are not targeted. Those remain
governed by normal skill routing.

## Install

Requires OpenClaw 2026.9.4 or later and a host-supported Node release
(24.16+ or 26.1+).

1. Keep this checkout in a durable directory outside the OpenClaw install.
2. Run `openclaw plugins install --link --force .` from this directory.
3. Merge `openclaw-config-snippet.json5` into the existing config. Preserve all
   existing plugin paths, allowlist entries, and plugin entries.
4. Run `openclaw config validate` and
   `openclaw plugins inspect workshop-governance-context --runtime --json`.
5. Apply with `openclaw plugins reload workshop-governance-context`, then
   inspect the runtime again. Restart only if reload cannot establish the cron
   reconciliation baseline and the operator explicitly authorizes it.

Non-bundled prompt hooks require
`plugins.entries.workshop-governance-context.hooks.allowConversationAccess` to
be `true`. Prompt injection must not be disabled.

By default, the plugin resolves the canonical workspace from the current
agent's OpenClaw configuration and reads
`skills/openclaw-skill-plugin-lifecycle/SKILL.md`. It then auto-discovers one
of these governance layouts:

- combined registry:
  `references/workspace-skill-registry.json`;
- split registries:
  `references/authoring-ownership.json` and
  `references/repository-publication.json`.

`workspaceDir`, `lifecycleSkillPath`, and `governanceReferencePaths` are
optional overrides for nonstandard layouts. `workspaceSkillRegistryPath` is a
single-registry compatibility shortcut. An explicit reference list wins over
the shortcut. A missing or malformed registry is surfaced in the injected
context with an owner-only fallback; the plugin never invents a grant.

Set `autoCommitProvenance: true` only after the Workshop tree has a clean Git
baseline. Successful targeted `auto` reviews then end with either a clean no-op,
a verified agent-created provenance commit, or an adapter-created commit with
`Change-Origin: workshop-autonomous`. A dirty starting tree is blocked.

## Runtime behavior

The plugin loads the current canonical lifecycle bundle and skill inventory
during `before_prompt_build`, then prepends them to targeted Workshop review
system context. Optional provenance enforcement snapshots the clean Git baseline,
gates the run before model submission, and commits successful changes at
`agent_end`. It does not add a second model review. Unrelated turns are
unaffected.

This plugin does not switch Workshop modes. Recovery still comes from the
Workshop repository's Git history.

## Development

Run:

```sh
npm test
npm pack --dry-run
```

Tests cover experience reviews in both modes, weekly cron identification,
non-Workshop isolation, combined and split registry discovery, explicit
overrides, dynamic policy loading, and owner-only fallback behavior.
