import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface VersionMetadata {
  version?: unknown;
  go_version?: unknown;
}

interface CustomVersionMetadata {
  revision?: unknown;
}

function readVersionMetadata(): VersionMetadata {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, "version.json"), "utf-8"),
  ) as VersionMetadata;
}

export function readApplicationVersion(): string {
  const versionMetadata = readVersionMetadata();
  if (typeof versionMetadata.version !== "string" || versionMetadata.version === "") {
    throw new Error("version.json contains no application version");
  }
  const customVersionPath = path.join(repositoryRoot, "custom-version.json");
  if (!existsSync(customVersionPath)) {
    return versionMetadata.version;
  }
  const customMetadata = JSON.parse(
    readFileSync(customVersionPath, "utf-8"),
  ) as CustomVersionMetadata;
  if (
    typeof customMetadata.revision !== "number" ||
    !Number.isInteger(customMetadata.revision) ||
    customMetadata.revision < 1
  ) {
    throw new Error("custom-version.json contains no valid revision");
  }
  return versionMetadata.version.includes("-")
    ? `${versionMetadata.version}.mxh.${customMetadata.revision}`
    : `${versionMetadata.version}-mxh.${customMetadata.revision}`;
}

export function readGoVersion(): string {
  const versionMetadata = readVersionMetadata();
  if (
    typeof versionMetadata.go_version !== "string" ||
    !/^go[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(versionMetadata.go_version)
  ) {
    throw new Error("version.json contains no valid Go version");
  }
  return versionMetadata.go_version;
}
