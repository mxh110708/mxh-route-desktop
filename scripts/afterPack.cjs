const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function verifyPackagedPublicRules(context) {
  const bundleName = "public-rules-v1.json";
  const source = fs.readFileSync(path.join(context.packager.projectDir, "resources", bundleName));
  const packaged = fs.readFileSync(path.join(context.packager.getResourcesDir(context.appOutDir), bundleName));
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  if (digest(source) !== digest(packaged)) {
    throw new Error("packaged public rule bundle differs from the verified source");
  }
}

function normalizeModificationTimes(directory, timestamp) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeModificationTimes(entryPath, timestamp);
      fs.utimesSync(entryPath, timestamp, timestamp);
    } else if (entry.isSymbolicLink()) {
      fs.lutimesSync(entryPath, timestamp, timestamp);
    } else {
      fs.utimesSync(entryPath, timestamp, timestamp);
    }
  }
  fs.utimesSync(directory, timestamp, timestamp);
}

exports.afterPack = async (context) => {
  verifyPackagedPublicRules(context);
  if (context.electronPlatformName === "linux") {
    const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
    if (sourceDateEpoch === undefined || !/^[0-9]+$/u.test(sourceDateEpoch)) {
      throw new Error("SOURCE_DATE_EPOCH is not set");
    }
    normalizeModificationTimes(
      context.appOutDir,
      new Date(Number(sourceDateEpoch) * 1000),
    );
    return;
  }
  if (context.electronPlatformName !== "win32") {
    return;
  }
  for (const relativePath of [
    ["daemon", "sing-box-daemon.exe"],
    ["native", "windows_share.node"],
  ]) {
    const executablePath = path.join(context.appOutDir, "resources", ...relativePath);
    const signed = await context.packager.signIf(executablePath);
    if (!signed) {
      throw new Error(`failed to sign ${relativePath.join("/")}`);
    }
  }
};
