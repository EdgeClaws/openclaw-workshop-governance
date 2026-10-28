# OpenClaw Workshop Governance Context

A narrow OpenClaw hook plugin that gives autonomous Skill Workshop reviews the
same canonical skill/plugin lifecycle guidance used by foreground authoring.
It reads that guidance and its authority/publication registries at run time,
then adds a compact index of current repository/workspace skills. It does not
contain a second copy of policy and does not run a second review pass.

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
5. Restart the Gateway so the plugin receives the cron reconciliation baseline.

Non-bundled prompt hooks require
`plugins.entries.workshop-governance-context.hooks.allowConversationAccess` to
be `true`. Prompt injection must not be disabled.

By default, the plugin resolves the canonical workspace from the current
agent's OpenClaw configuration and reads
`skills/openclaw-skill-plugin-lifecycle/SKILL.md` plus:

- `references/authoring-ownership.json`
- `references/repository-publication.json`

`workspaceDir`, `lifecycleSkillPath`, and `governanceReferencePaths` are
optional overrides for nonstandard layouts. A missing registry is surfaced in
the injected context with an owner-only fallback; the plugin never invents a
grant.

## Runtime behavior

The plugin has one job: load the current canonical lifecycle bundle and skill
inventory during `before_prompt_build`, then prepend them to targeted Workshop
review system context. It does not add a second review or a separate model gate.
Unrelated turns are unaffected.

This plugin does not switch Workshop modes and does not satisfy `auto` mode's
separate Git-provenance and recovery requirements.

## Development

Run:

```sh
npm test
npm pack --dry-run
```

Tests cover experience reviews in both modes, weekly cron identification,
non-Workshop isolation, dynamic policy/registry loading, and the owner-only
missing-registry fallback.
