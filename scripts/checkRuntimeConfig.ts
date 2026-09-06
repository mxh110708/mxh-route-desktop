import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRuntimeConfig, type CaptureMode } from "../src/main/runtimeConfig";

import { RPC_MAX_MESSAGE_BYTES, assertConfigRpcSize } from "../src/main/rpcLimits";
const CHECK_TIMEOUT_MILLISECONDS = 60_000;

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(
      /("(?:uuid|password|private[_-]?key|token|short[_-]?id)"\s*:\s*")[^"]*(")/giu,
      "$1<redacted>$2",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "<redacted-uuid>",
    )
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/gu, "<redacted-token>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 800);
}

async function main(): Promise<void> {
  const configPath = process.argv.slice(2).find((argument) => argument !== "--");
  const corePath = process.env.SING_BOX_CHECK_BINARY;
  if (!configPath || !corePath) {
    throw new Error("usage: set SING_BOX_CHECK_BINARY and pass a configuration path");
  }

  const source = await readFile(configPath, "utf8");
  assertConfigRpcSize(source);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sing-box-runtime-check-"));
  const results: Array<{ mode: CaptureMode; bytes: number; underGrpcLimit: boolean }> = [];

  try {
    for (const mode of ["system-proxy", "tun"] as const) {
      const runtime = buildRuntimeConfig(source, mode);
      const bytes = Buffer.byteLength(runtime);
      assertConfigRpcSize(runtime);
      const underGrpcLimit = bytes < RPC_MAX_MESSAGE_BYTES;
      if (!underGrpcLimit) {
        throw new Error(`runtime configuration exceeds the desktop IPC limit in ${mode} mode`);
      }

      const runtimePath = join(temporaryDirectory, `${mode}.json`);
      await writeFile(runtimePath, runtime, { encoding: "utf8", mode: 0o600 });
      const check = spawnSync(corePath, ["check", "-c", runtimePath], {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CHECK_TIMEOUT_MILLISECONDS,
      });
      if (check.error || check.status !== 0) {
        const rawDiagnostic = `${check.stdout ?? ""}\n${check.stderr ?? ""}`;
        const diagnosticHash = createHash("sha256")
          .update(rawDiagnostic)
          .digest("hex");
        const safeDiagnostic = sanitizeDiagnostic(rawDiagnostic);
        throw new Error(
          `core check failed in ${mode} mode (code ${check.status ?? "unavailable"}, diagnostic sha256 ${diagnosticHash})${safeDiagnostic ? `: ${safeDiagnostic}` : ""}`,
        );
      }
      results.push({ mode, bytes, underGrpcLimit });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(results)}\n`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`runtime configuration check failed: ${reason}; no configuration content was logged\n`);
  process.exitCode = 1;
});
