export interface UpdateAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

const OFFICIAL_RELEASES_URL = "https://api.github.com/repos/SagerNet/sing-box/releases";
const CUSTOM_RELEASES_URL =
  "https://api.github.com/repos/mxh110708/sing-box-for-desktop-custom/releases";
const CUSTOM_DOWNLOAD_PATH_PREFIX =
  "/mxh110708/sing-box-for-desktop-custom/releases/download/";

const OFFICIAL_WINDOWS_UPDATE_ARCHITECTURES: Partial<
  Record<NodeJS.Architecture, string[]>
> = {
  arm64: ["arm64", "x64", "x86"],
  ia32: ["x86"],
  x64: ["x64"],
};

export function releasesURL(customBuild: boolean): string {
  return customBuild ? CUSTOM_RELEASES_URL : OFFICIAL_RELEASES_URL;
}

export function updatesSupported(
  customBuild: boolean,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  if (customBuild) {
    return architecture === "x64";
  }
  return OFFICIAL_WINDOWS_UPDATE_ARCHITECTURES[architecture] !== undefined;
}

export function isChannelVersion(customBuild: boolean, version: string): boolean {
  return !customBuild || /-custom\.[0-9]+$/u.test(version);
}

export function selectWindowsAsset(
  customBuild: boolean,
  architecture: NodeJS.Architecture,
  version: string,
  assets: UpdateAsset[],
): UpdateAsset | null {
  if (customBuild) {
    if (architecture !== "x64") {
      return null;
    }
    const expectedName = `sing-box-Custom-${version}-windows-x64.exe`;
    return assets.find((asset) => asset.name === expectedName) ?? null;
  }

  const architectureTokens = OFFICIAL_WINDOWS_UPDATE_ARCHITECTURES[architecture];
  if (architectureTokens === undefined) {
    return null;
  }
  const executables = assets.filter(
    (asset) => asset.name.startsWith("SFW-") && asset.name.endsWith(".exe"),
  );
  for (const token of architectureTokens) {
    const match = executables.find((asset) =>
      asset.name.endsWith(`-${token}.exe`),
    );
    if (match !== undefined) {
      return match;
    }
  }
  return null;
}

export function isTrustedDownloadURL(customBuild: boolean, value: string): boolean {
  if (!customBuild) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(CUSTOM_DOWNLOAD_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}
