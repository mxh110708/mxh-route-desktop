import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildRuntimeConfig } from "../src/main/runtimeConfig";
import { addProbeRoutes, allocateProbePorts, priorityTags } from "../src/main/priorityFailover";

const [configPath, corePath] = process.argv.slice(2);
if (!configPath || !corePath) throw new Error("Usage: checkPriorityRuntime <config> <sing-box executable>");
const work = await mkdtemp(join(tmpdir(), "mxh-priority-check-"));
try {
  const source = await readFile(configPath, "utf8");
  for (const mode of ["system-proxy", "tun"] as const) {
    const base = buildRuntimeConfig(source, mode);
    const prepared = addProbeRoutes(base, await allocateProbePorts(priorityTags(base).length));
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
