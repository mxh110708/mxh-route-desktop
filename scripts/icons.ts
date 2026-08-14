import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const applicationIconSource = path.resolve(
  repositoryRoot,
  "..",
  "sing-box",
  "docs",
  "assets",
  "icon.svg",
);
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];
const windowsTraySizes = [16, 20, 24, 32, 48, 256];
const linuxSizes = [512, 1024];

if (!fs.existsSync(applicationIconSource)) {
  throw new Error(
    `missing official sing-box icon source: ${applicationIconSource}; keep the core checkout next to this repository`,
  );
}

const source = fs.readFileSync(applicationIconSource, "utf8");

function renderIcon(size: number): Buffer {
  const image = new Resvg(source, {
    fitTo: { mode: "width", value: size },
  }).render();
  return Buffer.from(image.asPng());
}

function writePng(size: number, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderIcon(size));
}

function writeIco(sizes: number[], outputPath: string): void {
  const frames = sizes.map((size) => ({ size, png: renderIcon(size) }));
  const headerSize = 6 + frames.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  let offset = headerSize;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat([header, ...frames.map(({ png }) => png)]));
}

const resources = path.join(repositoryRoot, "resources");
writeIco(windowsSizes, path.join(resources, "icon.ico"));
writeIco(windowsTraySizes, path.join(resources, "tray.ico"));
writePng(24, path.join(resources, "tray.png"));
writePng(48, path.join(resources, "tray@2x.png"));
writePng(16, path.join(resources, "trayTemplate.png"));
writePng(32, path.join(resources, "trayTemplate@2x.png"));

const linuxDirectory = path.join(resources, "icons");
for (const size of linuxSizes) {
  writePng(size, path.join(linuxDirectory, `${size}x${size}.png`));
}
