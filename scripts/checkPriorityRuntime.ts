import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildRuntimeConfig } from "../src/main/runtimeConfig";
import { addProbeRoutes, allocateProbePorts, priorityTags } from "../src/main/priorityFailover";
import { parsePrioritySettings } from "../src/main/prioritySettings";

const [configPath, corePath, group] = process.argv.slice(2);
if (!configPath || !corePath || !group) throw new Error("Usage: checkPriorityRuntime <config> <sing-box executable> <entry group>");
const settings = parsePrioritySettings({ group });
const work = await mkdtemp(join(tmpdir(), "mxh-priority-check-"));
try {
  const source = await readFile(configPath, "utf8");
  for (const mode of ["system-proxy", "tun"] as const) {
    const base = buildRuntimeConfig(source, mode);
    const tags = priorityTags(base, settings);
    if (!tags.length) throw new Error("Selected group is not an eligible entry proxy group");
    const prepared = addProbeRoutes(base, await allocateProbePorts(tags.length), settings);
    const path = join(work, mode + ".json"); await writeFile(path, prepared.content);
    const result = spawnSync(corePath, ["check", "-D", work, "-c", path], { encoding: "utf8", timeout: 30000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Core rejected ${mode} priority runtime; configuration details withheld`);
    console.log(`PASS ${mode}: ${prepared.candidates.length} independent probe routes; original profile unchanged`);
  }
} finally {
  const child = relative(tmpdir(), work);
  if (isAbsolute(child) || child.startsWith("..") || !child.startsWith("mxh-priority-check-")) throw new Error("Invalid temporary cleanup path");
  await rm(work, { recursive: true, force: true });
}
