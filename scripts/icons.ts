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
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function centerViewBoxOnSquare(svg: string): string {
  const match = /viewBox=(["'])([^"']+)\1/u.exec(svg);
  if (match === null) {
    throw new Error("official sing-box icon contains no SVG viewBox");
  }
  const values = match[2].trim().split(/[\s,]+/u).map(Number);
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value)) ||
    values[2] <= 0 ||
    values[3] <= 0
  ) {
    throw new Error("official sing-box icon contains an invalid SVG viewBox");
  }
  const [minimumX, minimumY, width, height] = values;
  const canvasSize = Math.max(width, height);
  const squareViewBox = [
    minimumX - (canvasSize - width) / 2,
    minimumY - (canvasSize - height) / 2,
    canvasSize,
    canvasSize,
  ].join(" ");
  const squared = svg.replace(
    match[0],
    `viewBox=${match[1]}${squareViewBox}${match[1]}`,
  );
  const openingTag = /<svg\b[^>]*>/u.exec(squared);
  const closingTagIndex = squared.lastIndexOf("</svg>");
  if (
    openingTag === null ||
    closingTagIndex < openingTag.index + openingTag[0].length
  ) {
    throw new Error("official sing-box icon contains an invalid SVG root element");
  }
  const contentStart = openingTag.index + openingTag[0].length;
  const clipIdentifier = "mxh-route-original-icon-viewport";
  const clipDefinition =
    `<defs><clipPath id="${clipIdentifier}" clipPathUnits="userSpaceOnUse">` +
    `<rect x="${minimumX}" y="${minimumY}" width="${width}" height="${height}"/>` +
    "</clipPath></defs>";
  return (
    squared.slice(0, contentStart) +
    clipDefinition +
    `<g clip-path="url(#${clipIdentifier})">` +
    squared.slice(contentStart, closingTagIndex) +
    "</g>" +
    squared.slice(closingTagIndex)
  );
}

const squareSource = centerViewBoxOnSquare(source);

function renderIcon(size: number): Buffer {
  const image = new Resvg(squareSource, {
    fitTo: { mode: "width", value: size },
  }).render();
  const png = Buffer.from(image.asPng());
  if (
    !png.subarray(0, pngSignature.length).equals(pngSignature) ||
    png.readUInt32BE(16) !== size ||
    png.readUInt32BE(20) !== size
  ) {
    throw new Error(`generated icon frame is not ${size}x${size}`);
  }
  return png;
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
