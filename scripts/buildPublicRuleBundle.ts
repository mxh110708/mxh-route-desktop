import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Input directory must contain only upstream public SRS files; never read a profile.
const names = ["geosite-category-ads-all", "geosite-private", "geosite-cn", "geoip-cn", "geosite-geolocation-not-cn"];
const input = process.argv[2];
if (!input) throw new Error("usage: buildPublicRuleBundle.ts <public-srs-directory>");
const files = [];
for (const name of names) {
  const data = await readFile(join(input, `${name}.srs`));
  if (data.subarray(0, 3).toString() !== "SRS") throw new Error("invalid public SRS");
  files.push({ name, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") });
}
const bundle = JSON.stringify({ version: 1, source: "https://github.com/MetaCubeX/meta-rules-dat/tree/sing", files });
await mkdir("resources", { recursive: true });
await writeFile("resources/public-rules-v1.json", bundle);
console.log(createHash("sha256").update(bundle).digest("hex"));
