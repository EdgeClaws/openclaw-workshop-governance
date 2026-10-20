import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerWorkshopGovernance } from "./plugin.mjs";

export default definePluginEntry({
  id: "workshop-governance-context",
  name: "Workshop Governance Context",
  description:
    "Injects canonical lifecycle governance into autonomous Skill Workshop reviews.",
  register: registerWorkshopGovernance,
});

