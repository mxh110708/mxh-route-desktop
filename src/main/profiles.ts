import { ConnectError } from "@connectrpc/connect";
import { assertConfigRpcSize } from "./rpcLimits";
import { BrowserWindow, app, dialog, ipcMain, net } from "electron";
import { PublicRuleCache, portablePublicRules } from "./publicRules";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { networkInterfaces } from "node:os";
import { createHash, randomUUID } from "node:crypto";

import { ServiceStatus_Type } from "../shared/gen/daemon/started_service_pb";
import { ProfileContent_Type } from "../shared/gen/experimental/boxdd/desktop_service_pb";
import { PROFILES_CALL, PROFILES_CHANGED } from "../shared/ipc";
import type {
  ProfileCreate,
  ProfileMetadata,
  ProfileMetadataPatch,
  ProfileType,
  ProfilesResult,
  ProfilesState,
} from "../shared/ipc";
import { writeApplicationCacheFile } from "./appCache";
import { desktopService, managedService, startedService } from "./daemon";
import { Preference, settingsDatabase } from "./database";
import {
  buildRuntimeConfig,
  parseCaptureMode,
  readSystemProxyEndpoint,
  type CaptureMode,
} from "./runtimeConfig";
import { serviceStartOptions } from "./settings";
import { userAgent } from "./userAgent";
import { applicationService } from "./worker";
import { daemonState } from "./state";
import { HealthLog } from "./healthLog";
import { CoreLogArchive } from "./coreLogArchive";
import { showSystemProxyRecoveryWarning } from "./notifications";
import { PriorityFailover, addProbeRoutes, allocateProbePorts, priorityTags, priorityGroups, type Candidate } from "./priorityFailover";
import { loadPrioritySettings, parsePrioritySettings, prioritySettingsSnapshot, savePrioritySettings } from "./prioritySettings";
import type { PriorityPanelState } from "../shared/ipc";
import {
  ConsecutiveFailureRecovery,
  nextSystemProxyProbeDelay,
  probeSystemProxy,
  classifyProxyQuality,
  proxySelectionSnapshot,
  readWindowsProxyDiagnostic,
  classifyWindowsProxyOwnership,
  classifyPriorityRecoveryEvidence,
  RecoveryCoordinator,
  WindowsProxyRecoveryGate,
} from "./systemProxyRecovery";

const MINIMUM_UPDATE_INTERVAL_MINUTES = 15;
const DEFAULT_UPDATE_INTERVAL_MINUTES = 60;
const REMOTE_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_REMOTE_PROFILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_REMOTE_ERROR_BYTES = 64 * 1024;
const SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS = 60_000;
const SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS = 5_000;
const SYSTEM_PROXY_HEALTH_TIMEOUT_MILLISECONDS = 8_000;
const SYSTEM_PROXY_CONTROL_TIMEOUT_MILLISECONDS = 3_000;
const SYSTEM_PROXY_RECOVERY_THRESHOLD = 3;

interface ProfileRow {
  id: string;
  name: string;
  type: string;
  remote_url: string | null;
  auto_update: number;
  auto_update_interval_minutes: number;
  last_updated: number | null;
  item_order: number;
}

function profilesDirectory(): string {
  return join(app.getPath("userData"), "profiles");
}

function contentPath(id: string): string {
  return join(profilesDirectory(), `${id}.json`);
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  content = portablePublicRules(content);
  await mkdir(profilesDirectory(), { recursive: true });
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

const profileOperations = new Map<string, Promise<void>>();

function runProfileOperation<Result>(
  id: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = profileOperations.get(id) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  profileOperations.set(id, settled);
  return result.finally(() => {
    if (profileOperations.get(id) === settled) {
      profileOperations.delete(id);
    }
  });
}

const selectedProfilePreference = new Preference<string | null>(
  "selected_profile_id",
  null,
  (value) => {
    if (typeof value !== "string" || value === "") {
      throw new Error("invalid selected profile preference");
    }
    return value;
  },
);

const captureModePreference = new Preference<CaptureMode>(
  "capture_mode",
  "tun",
  parseCaptureMode,
);

function profileFromRow(row: ProfileRow): ProfileMetadata {
  const profile: ProfileMetadata = {
    id: row.id,
    name: row.name,
    type: row.type as ProfileType,
    autoUpdate: row.auto_update !== 0,
    autoUpdateIntervalMinutes: row.auto_update_interval_minutes,
  };
  if (row.remote_url !== null) {
    profile.remoteUrl = row.remote_url;
  }
  if (row.last_updated !== null) {
    profile.lastUpdated = row.last_updated;
  }
  return profile;
}

function listProfiles(): ProfileMetadata[] {
  const rows = settingsDatabase()
    .prepare("SELECT * FROM profiles ORDER BY item_order ASC")
    .all() as unknown as ProfileRow[];
  return rows.map(profileFromRow);
}

function selectedProfileId(): string | null {
  return selectedProfilePreference.get();
}

function writeSelectedProfileId(id: string | null): void {
  selectedProfilePreference.set(id);
}

function findProfile(id: string): ProfileMetadata {
  const row = settingsDatabase()
    .prepare("SELECT * FROM profiles WHERE id = ?")
    .get(id) as ProfileRow | undefined;
  if (row === undefined) {
    throw new Error(`profile not found: ${id}`);
  }
  return profileFromRow(row);
}

// Mirrors the Apple client's ProfileManager.uniqueName: appends " (n)" until
// the name is free, so imported or created profiles never collide.
function uniqueName(baseName: string): string {
  const existing = new Set(listProfiles().map((profile) => profile.name));
  if (!existing.has(baseName)) {
    return baseName;
  }
  let counter = 1;
  while (existing.has(`${baseName} (${counter})`)) {
    counter += 1;
  }
  return `${baseName} (${counter})`;
}

const changeListeners: (() => void)[] = [];

export function onProfilesChanged(listener: () => void) {
  changeListeners.push(listener);
}

export function profilesState(): ProfilesState {
  return {
    selectedId: selectedProfileId(),
    profiles: listProfiles(),
    captureMode: captureModePreference.get(),
  };
}

function notifyChanged() {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(PROFILES_CHANGED);
    }
  }
  for (const listener of changeListeners) {
    listener();
  }
}

async function checkConfig(content: string): Promise<void> {
  assertConfigRpcSize(content);
  content = await preparePublicRules(content);
  await applicationService.checkConfig({ content });
}

let publicRuleCache: PublicRuleCache | undefined;
function preparePublicRules(content: string): Promise<string> {
  publicRuleCache ??= new PublicRuleCache(join(app.getPath("userData"), "public-rule-cache"),
    ((url, options) => net.fetch(url instanceof URL ? url.toString() : url, options)) as typeof fetch);
  return publicRuleCache.prepare(content);
}

async function readLimitedResponse(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`response exceeds ${maximumBytes} bytes`);
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    totalLength += result.value.byteLength;
    if (totalLength > maximumBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, totalLength).toString("utf-8");
}

// Mirrors libbox's HTTPClient (experimental/libbox/http.go): SetURL turns
// URL userinfo into a basic Authorization header, and Execute accepts only
// HTTP 200, reporting other statuses as "HTTP <Status>: <body>".
async function fetchRemoteContent(remoteUrl: string): Promise<string> {
  const requestUrl = new URL(remoteUrl);
  const headers = new Headers({ "User-Agent": userAgent() });
  if (requestUrl.username !== "" || requestUrl.password !== "") {
    const credentials = `${decodeURIComponent(requestUrl.username)}:${decodeURIComponent(requestUrl.password)}`;
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(credentials).toString("base64")}`,
    );
    requestUrl.username = "";
    requestUrl.password = "";
  }
  const response = await fetch(requestUrl, {
    headers,
    signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 200) {
    const status =
      response.statusText === ""
        ? String(response.status)
        : `${response.status} ${response.statusText}`;
    let body: string;
    try {
      body = await readLimitedResponse(response, MAXIMUM_REMOTE_ERROR_BYTES);
    } catch (error) {
      throw new Error(
        `HTTP ${status}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(`HTTP ${status}: ${body}`);
  }
  return await readLimitedResponse(response, MAXIMUM_REMOTE_PROFILE_BYTES);
}

async function insertProfile(
  profile: ProfileMetadata,
  content: string,
): Promise<ProfileMetadata> {
  await atomicWriteFile(contentPath(profile.id), content);
  const store = settingsDatabase();
  store.transaction(() => {
    const nextOrder = (
      store
        .prepare(
          "SELECT COALESCE(MAX(item_order) + 1, 0) AS next_order FROM profiles",
        )
        .get() as {
        next_order: number;
      }
    ).next_order;
    store
      .prepare(
        `INSERT INTO profiles (id, name, type, remote_url, auto_update,
          auto_update_interval_minutes, last_updated, item_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.id,
        profile.name,
        profile.type,
        profile.remoteUrl ?? null,
        profile.autoUpdate ? 1 : 0,
        profile.autoUpdateIntervalMinutes,
        profile.lastUpdated ?? null,
        nextOrder,
      );
    writeSelectedProfileId(profile.id);
  })();
  notifyChanged();
  reconfigureAutoUpdate();
  return profile;
}

async function importProfileData(
  fileName: string,
  data: Uint8Array,
): Promise<void> {
  if (fileName.toLowerCase().endsWith(".bpf")) {
    const content = await applicationService.decodeProfile({ data });
    await checkConfig(content.config);
    const remote = content.type === ProfileContent_Type.REMOTE;
    // Shared profile files carry LastUpdated in either seconds or milliseconds.
    let lastUpdated: number | undefined;
    if (remote && content.lastUpdated > 0n) {
      lastUpdated =
        content.lastUpdated > 100_000_000_000n
          ? Number(content.lastUpdated)
          : Number(content.lastUpdated) * 1000;
    }
    await insertProfile(
      {
        id: crypto.randomUUID(),
        name: uniqueName(content.name || basename(fileName, ".bpf")),
        type: remote ? "remote" : "local",
        remoteUrl: remote ? content.remotePath : undefined,
        autoUpdate: remote ? content.autoUpdate : false,
        autoUpdateIntervalMinutes:
          remote && content.autoUpdateInterval > 0
            ? content.autoUpdateInterval
            : DEFAULT_UPDATE_INTERVAL_MINUTES,
        lastUpdated,
      },
      content.config,
    );
    return;
  }
  throw new Error(`unsupported profile file: ${fileName}`);
}

async function encodeProfileData(id: string): Promise<Uint8Array> {
  const profile = findProfile(id);
  const remote = profile.type === "remote";
  const encoded = await applicationService.encodeProfile({
    type: remote ? ProfileContent_Type.REMOTE : ProfileContent_Type.LOCAL,
    name: profile.name,
    config: portablePublicRules(await readFile(contentPath(id), "utf-8")),
    remotePath: remote ? profile.remoteUrl : undefined,
    autoUpdate: remote ? profile.autoUpdate : false,
    autoUpdateInterval: remote ? profile.autoUpdateIntervalMinutes : 0,
    lastUpdated:
      remote && profile.lastUpdated !== undefined
        ? BigInt(profile.lastUpdated)
        : 0n,
  });
  return encoded.data;
}

let serviceOperation: Promise<void> = Promise.resolve();
let priorityCandidates: Candidate[] = [];
let priorityPolicy: PriorityFailover | null = null;
let priorityBusy = false;
let priorityGeneration = 0;
let coreArchive: CoreLogArchive | null = null;
let archiveAbort: AbortController | null = null;
let priorityNextAt = 0;
let priorityLastResults: { at: number; finishedAt: number; reachable: Map<string, boolean> } | null = null;
let prioritySelectedEvidence: { tag: string; at: number; reachable: boolean } | null = null;
let priorityProfileHash = "";
let priorityProfileId: string | null = null;
let priorityCaptureMode: CaptureMode | null = null;
let priorityStateWrite: Promise<void> = Promise.resolve();
let restoringPriority = false;
let priorityConfiguring = false;
let priorityLastSwitch: PriorityPanelState["lastSwitch"] = null;
function priorityCachePath(): string { return join(app.getPath("userData"), "priority-runtime.json"); }
function prioritySettingsPath(): string { return join(app.getPath("userData"), "priority-failover.json"); }
async function priorityPanelState(): Promise<PriorityPanelState> {
  const snapshot = await prioritySettingsSnapshot(prioritySettingsPath());
  const profileId = selectedProfileId();
  const rawContent = profileId ? await readFile(contentPath(profileId), "utf8") : null;
  const content = rawContent ? buildRuntimeConfig(rawContent, captureModePreference.get()) : null;
  const groups = content ? priorityGroups(content) : [];
  const running = daemonState.status === ServiceStatus_Type.STARTED;
  const directMode = running && startedService !== null &&
    (await startedService.getClashModeStatus({}, { timeoutMs: 1000 }).catch(() => ({ currentMode: "" }))).currentMode.toLowerCase() === "direct";
  const selected = daemonState.groups.find(group => group.tag === (priorityPolicy?.settings.group ?? snapshot.settings.group))?.selected ?? null;
  return { ...snapshot, profileId, groups, path: prioritySettingsPath(), running, directMode,
    active: running && !directMode && priorityCandidates.length > 0 && !!priorityPolicy?.settings.enabled,
    preferred: priorityPolicy?.preferred ?? null,
    monitoredSelected: selected !== null && (priorityPolicy?.isMonitored(selected) ?? false),
    needsReload: running && (JSON.stringify(priorityPolicy?.settings) !== JSON.stringify(snapshot.settings) ||
      rawContent !== null && createHash("sha256").update(rawContent).digest("hex") !== priorityProfileHash),
    selected,
    lastSwitch: priorityLastSwitch };
}
async function savePriorityRuntime(): Promise<void> {
  const generation = priorityGeneration;
  const snapshot = JSON.stringify({ profile: priorityProfileId, hash: priorityProfileHash,
    mode: priorityCaptureMode ?? captureModePreference.get(), candidates: priorityCandidates,
    settings: priorityPolicy?.settings, preferred: priorityPolicy?.preferred });
  const task = priorityStateWrite.catch(() => {}).then(async () => {
    if (generation !== priorityGeneration) return;
    const temporary = `${priorityCachePath()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, snapshot, { flag: "wx" });
      if (generation === priorityGeneration) await rename(temporary, priorityCachePath());
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  });
  priorityStateWrite = task;
  try {
    await task;
  } catch (error) { recordSystemProxyHealth("priority-state-write-error", { error: systemProxyHealthError(error) }); }
}
function savedPriorityPreference(saved: any, tags: string[], group: string): string | null {
  // Older caches only recorded a pause flag. Their selection could have changed
  // during a probe without updating that flag, so use the live selector once.
  const preferred = typeof saved.preferred === "string" ? saved.preferred :
    typeof saved.paused === "boolean" ? daemonState.groups.find(item => item.tag === group)?.selected : null;
  return typeof preferred === "string" && tags.includes(preferred) ? preferred : null;
}
async function loadSavedPriorityPreference(profile: string | null, hash: string, group: string, tags: string[]): Promise<string | null> {
  if (!profile) return null;
  try {
    const saved = JSON.parse(await readFile(priorityCachePath(), "utf8"));
    if (saved.profile !== profile || saved.hash !== hash || saved.settings?.group !== group) return null;
    return savedPriorityPreference(saved, tags, group);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") recordSystemProxyHealth("priority-state-read-error", { error: systemProxyHealthError(error) });
    return null;
  }
}
async function restorePriorityRuntime(): Promise<void> {
  if (restoringPriority || priorityConfiguring || priorityPolicy || daemonState.status !== ServiceStatus_Type.STARTED) return;
  restoringPriority = true;
  const generation = priorityGeneration;
  try {
    const saved = JSON.parse(await readFile(priorityCachePath(), "utf8"));
    const profile = selectedProfileId();
    if (!profile || saved.profile !== profile || saved.mode !== captureModePreference.get()) return;
    const content = await readFile(contentPath(profile), "utf8");
    if (saved.hash !== createHash("sha256").update(content).digest("hex") || !Array.isArray(saved.candidates)) return;
    const settings = await loadPrioritySettings(prioritySettingsPath());
    if (JSON.stringify(saved.settings) !== JSON.stringify(settings)) return;
    const tags = priorityTags(buildRuntimeConfig(content, captureModePreference.get()), settings);
    if (saved.candidates.length !== tags.length || saved.candidates.some((c: Candidate, i: number) => c.tag !== tags[i] || !Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)) return;
    if (generation !== priorityGeneration) return;
    priorityCandidates = saved.candidates; priorityProfileHash = saved.hash; priorityProfileId = profile;
    priorityCaptureMode = captureModePreference.get();
    priorityPolicy = new PriorityFailover(tags, settings, savedPriorityPreference(saved, tags, settings.group));
    recordSystemProxyHealth("priority-monitor-restored", { order: tags, preferred: priorityPolicy.preferred });
    if (typeof saved.preferred !== "string") {
      await savePriorityRuntime();
      recordSystemProxyHealth("priority-preference-migrated", { preferred: priorityPolicy.preferred });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") recordSystemProxyHealth("priority-state-read-error", { error: systemProxyHealthError(error) }); }
  finally { restoringPriority = false; }
}

async function archiveBoundary(event: string): Promise<void> {
  try { await coreArchive?.event(event); await coreArchive?.flush(); }
  catch (error) { recordSystemProxyHealth("core-log-write-error", { error: systemProxyHealthError(error) }); }
}

function startCoreArchive(): void {
  coreArchive ??= new CoreLogArchive(join(app.getPath("userData"), "core-runtime.log"));
  archiveAbort = new AbortController();
  const signal = archiveAbort.signal;
  let quitting = false;
  app.on("before-quit", event => {
    if (quitting) return;
    quitting = true; event.preventDefault(); archiveAbort?.abort();
    void Promise.race([archiveBoundary("application-stopping"), new Promise(resolve => setTimeout(resolve, 2000))]).finally(() => app.quit());
  });
  void (async () => {
    while (!signal.aborted) {
      try {
        if (startedService === null) return;
        await coreArchive!.event("subscription-started");
        let historical = true;
        for await (const batch of startedService.subscribeLog({}, { signal })) {
          if (batch.reset) await coreArchive!.event("source-buffer-reset");
          for (const message of batch.messages) await coreArchive!.write(message.level, message.message, historical);
          historical = false;
        }
      } catch (error) {
        if (!signal.aborted) recordSystemProxyHealth("core-log-subscription-error", { error: systemProxyHealthError(error) });
      }
      if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  })();
}

async function observePrioritySelection(policy: PriorityFailover, selected: string, phase: string): Promise<void> {
  const previous = policy.preferred;
  if (!policy.observeSelection(selected)) return;
  priorityLastResults = null;
  prioritySelectedEvidence = null;
  recordSystemProxyHealth("priority-manual-preference", { from: previous, to: selected, phase, monitored: policy.isMonitored(selected) });
  await savePriorityRuntime();
}

async function runPriorityCheck(): Promise<void> {
  if (priorityBusy || Date.now() < priorityNextAt) return;
  priorityNextAt = Date.now() + (priorityPolicy?.settings.healthyIntervalMs ?? 10000);
  if (!priorityPolicy) await restorePriorityRuntime();
  if (priorityBusy || !priorityPolicy || !priorityCandidates.length || startedService === null ||
      daemonState.status !== ServiceStatus_Type.STARTED) return;
  priorityBusy = true;
  const generation = priorityGeneration, epoch = serviceEpoch, policy = priorityPolicy;
  const profile = selectedProfileId(), capture = captureModePreference.get();
  const stillCurrent = () => generation === priorityGeneration && epoch === serviceEpoch &&
    profile === selectedProfileId() && capture === captureModePreference.get() && daemonState.status === ServiceStatus_Type.STARTED;
  try {
    if ((await startedService.getClashModeStatus({}, { timeoutMs: 3000 })).currentMode.toLowerCase() === "direct") return;
    const group = daemonState.groups.find(g => g.tag === policy.settings.group);
    if (!group) return;
    await observePrioritySelection(policy, group.selected, "before-probe");
    const selected = group.selected;
    const roundStartedAt = Date.now();
    const results = new Map<string, boolean>();
    // One candidate at a time, three small independent HEADs in parallel. No bandwidth test.
    for (const candidate of priorityCandidates) {
      if (!stillCurrent()) return;
      const candidateStartedAt = Date.now();
      const samples = await Promise.allSettled(["www.gstatic.com", "www.cloudflare.com", "chatgpt.com"].map(targetHost =>
        probeSystemProxy({ server: "127.0.0.1", port: candidate.port }, { targetHost, path: "/", timeoutMs: policy.settings.probeTimeoutMs })));
      if (!stillCurrent()) return;
      // Slow but completed requests remain usable: congestion alone must not cause flapping.
      const reachable = samples.filter(s => s.status === "fulfilled").length >= 2;
      results.set(candidate.tag, reachable);
      if (candidate.tag === selected && daemonState.groups.find(g => g.tag === policy.settings.group)?.selected === selected) {
        prioritySelectedEvidence = { tag: selected, at: candidateStartedAt, reachable };
      }
      recordSystemProxyHealth("priority-probe", { node: candidate.tag, reachable,
        samples: samples.map(s => s.status === "fulfilled" ? s.value : { error: systemProxyHealthError(s.reason) }) });
    }
    if (!stillCurrent()) return;
    priorityLastResults = { at: roundStartedAt, finishedAt: Date.now(), reachable: results };
    const current = daemonState.groups.find(g => g.tag === policy.settings.group)?.selected;
    if (current !== selected) {
      // A manual choice during the probe invalidates the entire old round.
      priorityLastResults = null;
      prioritySelectedEvidence = null;
      priorityNextAt = Date.now() + 1_000;
      if (current) await observePrioritySelection(policy, current, "during-probe");
      return;
    }
    recordSystemProxyHealth("priority-round", { selected, preferred: policy.preferred, captureMode: capture,
      available: [...results].filter(([, ok]) => ok).map(([tag]) => tag) });
    const next = policy.record(results, Date.now());
    priorityNextAt = Date.now() + policy.nextProbeDelay(selected, results);
    if (!next || next === selected) return;
    await runServiceOperation(async () => {
      if (!stillCurrent() ||
          daemonState.groups.find(g => g.tag === policy.settings.group)?.selected !== selected) return;
      if ((await startedService!.getClashModeStatus({}, { timeoutMs: 3000 })).currentMode.toLowerCase() === "direct") return;
      recordSystemProxyHealth("priority-switch-requested", { from: selected, to: next, preferred: policy.preferred });
      await archiveBoundary("before-priority-switch");
      if (!stillCurrent() || daemonState.groups.find(g => g.tag === policy.settings.group)?.selected !== selected) return;
      recoveryCoordinator.begin();
      systemProxyRecovery.reset();
      priorityLastResults = null;
      prioritySelectedEvidence = null;
      try {
        await startedService!.selectOutbound({ groupTag: policy.settings.group, outboundTag: next }, { timeoutMs: 3000 });
        policy.switched(next, Date.now());
        priorityLastSwitch = { from: selected, to: next, at: new Date().toISOString(),
          reason: !results.get(selected) ? "当前节点连续失败" : next === policy.preferred ? "首选恢复稳定" : "较高优先级入口恢复" };
        recordSystemProxyHealth("priority-switch-completed", { from: selected, to: next, preferred: policy.preferred });
      } finally {
        recoveryCoordinator.finish(Date.now());
        recordSystemProxyHealth("recovery-observation-started", { reason: "node-switch", durationMs: 30000 });
      }
    });
  } catch (error) { recordSystemProxyHealth("priority-check-error", { error: systemProxyHealthError(error) }); }
  finally { priorityBusy = false; }
}
const systemProxyRecovery = new ConsecutiveFailureRecovery(
  SYSTEM_PROXY_RECOVERY_THRESHOLD,
);
const windowsProxyRecovery = new WindowsProxyRecoveryGate();
let windowsProxyWarningShown = false;
const recoveryCoordinator = new RecoveryCoordinator();
let systemProxyHealthTimer: NodeJS.Timeout | null = null;
let systemProxyHealthCheckRunning = false;

function runServiceOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = serviceOperation.catch(() => {}).then(operation);
  serviceOperation = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function startServiceWithContent(
  content: string,
  captureMode = captureModePreference.get(),
  reason = "user-or-profile-change",
): Promise<void> {
  if (desktopService === null || managedService === null) {
    throw new Error("daemon is not available");
  }
  recordSystemProxyHealth("service-start-requested", { captureMode, reason });
  priorityConfiguring = true;
  recoveryCoordinator.begin();
  try {
    const previousPriorityPolicy = priorityPolicy;
    const previousProfileId = priorityProfileId;
    const previousProfileHash = priorityProfileHash;
    priorityGeneration++;
    priorityCandidates = []; priorityPolicy = null; priorityProfileId = null; priorityCaptureMode = null; priorityLastResults = null; prioritySelectedEvidence = null; priorityNextAt = 0;
    await archiveBoundary("before-service-start-or-reload");
    const baseContent = buildRuntimeConfig(await preparePublicRules(content), captureMode);
    const settings = await loadPrioritySettings(prioritySettingsPath());
    const tags = priorityTags(baseContent, settings);
    const profileId = selectedProfileId();
    const profileHash = createHash("sha256").update(content).digest("hex");
    const carriedPreferred = previousPriorityPolicy && previousProfileId === profileId && previousProfileHash === profileHash &&
      previousPriorityPolicy.settings.group === settings.group && previousPriorityPolicy.preferred && tags.includes(previousPriorityPolicy.preferred)
      ? previousPriorityPolicy.preferred : null;
    const preferred = carriedPreferred ?? await loadSavedPriorityPreference(profileId, profileHash, settings.group, tags);
    const prepared = addProbeRoutes(baseContent, await allocateProbePorts(tags.length), settings);
    const runtimeContent = prepared.content;
    await desktopService.startService({ configContent: runtimeContent, options: await serviceStartOptions() });
    await managedService.setSystemProxyEnabled({ enabled: captureMode === "system-proxy" });
    priorityCandidates = prepared.candidates;
    priorityPolicy = new PriorityFailover(tags, settings, preferred);
    priorityProfileId = profileId; priorityProfileHash = profileHash; priorityCaptureMode = captureMode;
    await savePriorityRuntime();
    recordSystemProxyHealth("priority-policy-started", { ...settings, order: tags, preferred: priorityPolicy.preferred, settingsPath: prioritySettingsPath() });
    if (reason !== "health-recovery") {
      systemProxyRecovery.reset();
      windowsProxyRecovery.reset();
      windowsProxyWarningShown = false;
    }
    recordSystemProxyHealth("service-start-completed", { captureMode, reason });
  } catch (error) {
    recordSystemProxyHealth("service-start-failed", { captureMode, reason, error: systemProxyHealthError(error) });
    throw error;
  } finally {
    priorityConfiguring = false;
    recoveryCoordinator.finish(Date.now());
    recordSystemProxyHealth("recovery-observation-started", { reason: "service-start-or-reload", durationMs: 30000 });
  }
}

function systemProxyHealthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 512);
}

let healthLog: HealthLog | undefined;
let serviceEpoch = 0;
function recordSystemProxyHealth(
  event: string,
  details: Record<string, unknown> = {},
): void {
  healthLog ??= new HealthLog(join(app.getPath("userData"), "system-proxy-health.log"), 10 * 1024 * 1024, 5);
  void healthLog.write(event, details).catch(
    (error) => console.error("write system proxy health log:", error),
  );
}

async function runSystemProxyHealthCheck(): Promise<number> {
  if (systemProxyHealthCheckRunning) {
    return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
  }
  systemProxyHealthCheckRunning = true;
  try {
    if (
      captureModePreference.get() !== "system-proxy" ||
      daemonState.status !== ServiceStatus_Type.STARTED
    ) {
      systemProxyRecovery.reset();
      windowsProxyRecovery.reset();
      windowsProxyWarningShown = false;
      recordSystemProxyHealth("check-skipped", { captureMode: captureModePreference.get(), serviceStatus: daemonState.status });
      return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
    }
    const selectedId = selectedProfileId();
    if (selectedId === null) {
      systemProxyRecovery.reset();
      windowsProxyRecovery.reset();
      windowsProxyWarningShown = false;
      recordSystemProxyHealth("check-skipped", { reason: "no-selected-profile" });
      return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
    }
    if (startedService !== null) {
      const clashMode = await startedService.getClashModeStatus(
        {},
        { timeoutMs: SYSTEM_PROXY_CONTROL_TIMEOUT_MILLISECONDS },
      );
      if (clashMode.currentMode.toLowerCase() === "direct") {
        systemProxyRecovery.reset();
        windowsProxyRecovery.reset();
        windowsProxyWarningShown = false;
        recordSystemProxyHealth("check-skipped", { reason: "direct-mode" });
        return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
      }
    }
    const content = await readFile(contentPath(selectedId), "utf-8");
    const endpoint = readSystemProxyEndpoint(content);
    const probeEpoch = serviceEpoch;
    const recoveryEpoch = recoveryCoordinator.snapshot();
    const probeStartedAt = Date.now();
    const probeSelection = proxySelectionSnapshot(daemonState.groups);
    const probes = await Promise.allSettled([
      probeSystemProxy(endpoint, { timeoutMs: SYSTEM_PROXY_HEALTH_TIMEOUT_MILLISECONDS }),
      probeSystemProxy(endpoint, { targetHost: "www.cloudflare.com", path: "/cdn-cgi/trace", timeoutMs: SYSTEM_PROXY_HEALTH_TIMEOUT_MILLISECONDS }),
      probeSystemProxy(endpoint, { targetHost: "chatgpt.com", path: "/", timeoutMs: SYSTEM_PROXY_HEALTH_TIMEOUT_MILLISECONDS }),
    ]);
    const windowsProxy = await readWindowsProxyDiagnostic(endpoint);
    // Do not restart a different profile/mode/selection if it changed during the probes.
    if (serviceEpoch !== probeEpoch || selectedProfileId() !== selectedId || captureModePreference.get() !== "system-proxy" || daemonState.status !== ServiceStatus_Type.STARTED || proxySelectionSnapshot(daemonState.groups) !== probeSelection) {
      systemProxyRecovery.reset();
      windowsProxyRecovery.reset();
      windowsProxyWarningShown = false;
      recordSystemProxyHealth("check-discarded", { reason: "state-changed" });
      return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
    }
    const quality = classifyProxyQuality(probes);
    recordSystemProxyHealth("windows-proxy-diagnostic", windowsProxy);
    recordSystemProxyHealth("quality-sample", {
      ...quality,
      activeInterfaceCount: Object.values(networkInterfaces()).filter(v => v?.some(a => !a.internal)).length,
      samples: probes.map((r, i) => r.status === "fulfilled" ? r.value : { target: ["www.gstatic.com", "www.cloudflare.com", "chatgpt.com"][i], error: systemProxyHealthError(r.reason) }),
    });
    if (!recoveryCoordinator.accepts(recoveryEpoch, probeStartedAt, Date.now())) {
      recordSystemProxyHealth("recovery-deferred", { reason: "recovery-observation-or-stale-sample" });
      return SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS;
    }
    const ownership = classifyWindowsProxyOwnership(windowsProxy);
    const ownershipDecision = windowsProxyRecovery.observe(ownership);
    if (ownershipDecision !== "healthy" && ownershipDecision !== "unknown") {
      systemProxyRecovery.reset();
      recordSystemProxyHealth("windows-proxy-ownership", { state: ownership, action: ownershipDecision });
      if (ownershipDecision === "suspended" && !windowsProxyWarningShown) {
        windowsProxyWarningShown = true;
        showSystemProxyRecoveryWarning();
      }
      if (ownershipDecision === "repair" && managedService !== null) {
        await runServiceOperation(async () => {
          if (serviceEpoch !== probeEpoch || selectedProfileId() !== selectedId ||
              captureModePreference.get() !== "system-proxy" || daemonState.status !== ServiceStatus_Type.STARTED ||
              proxySelectionSnapshot(daemonState.groups) !== probeSelection ||
              !recoveryCoordinator.accepts(recoveryEpoch, probeStartedAt, Date.now())) {
            windowsProxyRecovery.cancelPendingRepair();
            recordSystemProxyHealth("windows-proxy-repair-skipped", { reason: "state-changed" });
            return;
          }
          if (classifyWindowsProxyOwnership(await readWindowsProxyDiagnostic(endpoint)) !== "detached") {
            windowsProxyRecovery.cancelPendingRepair();
            recordSystemProxyHealth("windows-proxy-repair-skipped", { reason: "ownership-changed" });
            return;
          }
          recoveryCoordinator.begin();
          try {
            await managedService!.setSystemProxyEnabled({ enabled: true });
            const after = classifyWindowsProxyOwnership(await readWindowsProxyDiagnostic(endpoint));
            recordSystemProxyHealth("windows-proxy-repair-result", { state: after });
          } catch (error) {
            recordSystemProxyHealth("windows-proxy-repair-failed", { error: systemProxyHealthError(error) });
          } finally {
            recoveryCoordinator.finish(Date.now());
          }
        });
      }
      return ownershipDecision === "retry" || ownershipDecision === "repair"
        ? SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS
        : SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
    }
    if (!quality.recoverable) {
      systemProxyRecovery.recordSuccess();
      return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
    }
    const selectedEntry = daemonState.groups.find(g => g.tag === priorityPolicy?.settings.group)?.selected;
    const priorityEvidence = classifyPriorityRecoveryEvidence(selectedEntry, priorityLastResults, recoveryCoordinator, Date.now(), prioritySelectedEvidence);
    const priorityOwnsRecovery = priorityCandidates.length > 0 && priorityPolicy?.ownsNodeRecovery === true;
    if (priorityOwnsRecovery && priorityEvidence === "unavailable") {
      systemProxyRecovery.reset();
      recordSystemProxyHealth("recovery-deferred", { reason: "priority-failover-owns-node-recovery" });
      return SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS;
    }
    if (priorityOwnsRecovery && priorityEvidence === "all-down") {
      recordSystemProxyHealth("recovery-evidence", { reason: "all-priority-candidates-unreachable" });
    }
    if (!systemProxyRecovery.recordFailure()) {
      recordSystemProxyHealth("recovery-deferred", { failures: systemProxyRecovery.consecutiveFailures, armed: systemProxyRecovery.recoveryArmed });
      return nextSystemProxyProbeDelay(systemProxyRecovery, SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS, SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS);
    }

    recordSystemProxyHealth("automatic-reload-started");
    try {
      await runServiceOperation(async () => {
        if (serviceEpoch !== probeEpoch || selectedProfileId() !== selectedId || captureModePreference.get() !== "system-proxy" || daemonState.status !== ServiceStatus_Type.STARTED || proxySelectionSnapshot(daemonState.groups) !== probeSelection || await readFile(contentPath(selectedId), "utf-8") !== content) {
          recordSystemProxyHealth("automatic-reload-skipped", { reason: "state-changed" }); return;
        }
        if (startedService !== null && (await startedService.getClashModeStatus({}, { timeoutMs: SYSTEM_PROXY_CONTROL_TIMEOUT_MILLISECONDS })).currentMode.toLowerCase() === "direct") {
          recordSystemProxyHealth("automatic-reload-skipped", { reason: "direct-mode" }); return;
        }
        // Recheck after all awaited work, including a switch queued ahead of us.
        const entry = daemonState.groups.find(g => g.tag === priorityPolicy?.settings.group)?.selected;
        const priorityEvidence = classifyPriorityRecoveryEvidence(entry, priorityLastResults, recoveryCoordinator, Date.now(), prioritySelectedEvidence);
        if (!recoveryCoordinator.accepts(recoveryEpoch, probeStartedAt, Date.now()) ||
            serviceEpoch !== probeEpoch || proxySelectionSnapshot(daemonState.groups) !== probeSelection ||
            (priorityCandidates.length > 0 && priorityPolicy?.ownsNodeRecovery === true && priorityEvidence === "unavailable")) {
          recordSystemProxyHealth("automatic-reload-skipped", { reason: "recovery-evidence-invalidated" }); return;
        }
        if (classifyWindowsProxyOwnership(await readWindowsProxyDiagnostic(endpoint)) !== "owned") {
          recordSystemProxyHealth("automatic-reload-skipped", { reason: "windows-proxy-not-owned" }); return;
        }
        await startServiceWithContent(content, "system-proxy", "health-recovery");
        recordSystemProxyHealth("automatic-reload-completed");
      });
    } catch (error) {
      recordSystemProxyHealth("automatic-reload-failed", {
        error: systemProxyHealthError(error),
      });
    }
    return SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS;
  } catch (error) {
    recordSystemProxyHealth("health-check-failed", {
      error: systemProxyHealthError(error),
    });
    return SYSTEM_PROXY_HEALTH_NORMAL_INTERVAL_MILLISECONDS;
  } finally {
    systemProxyHealthCheckRunning = false;
  }
}

function scheduleSystemProxyHealthCheck(delayMs: number): void {
  if (systemProxyHealthTimer !== null) {
    return;
  }
  systemProxyHealthTimer = setTimeout(() => {
    systemProxyHealthTimer = null;
    void runSystemProxyHealthCheck().then(scheduleSystemProxyHealthCheck);
  }, delayMs);
  systemProxyHealthTimer.unref();
}

function startSystemProxyHealthMonitor(): void {
  recordSystemProxyHealth("monitor-started", { version: app.getVersion(), startedAtLogin: process.argv.includes("--start-at-login"), captureMode: captureModePreference.get(), probe: "tls-https", slowThresholdMs: 5_000 });
  let previous = "";
  daemonState.on("change", () => {
    const current = JSON.stringify({ connection: daemonState.connection.phase, status: daemonState.status });
    if (previous !== current) { previous = current; serviceEpoch++; recordSystemProxyHealth("daemon-state", JSON.parse(current)); }
  });
  scheduleSystemProxyHealthCheck(SYSTEM_PROXY_HEALTH_RETRY_INTERVAL_MILLISECONDS);
}

async function reloadIfSelectedAndRunning(id: string): Promise<void> {
  if (selectedProfileId() !== id) {
    return;
  }
  if (daemonState.status !== ServiceStatus_Type.STARTED) {
    return;
  }
  const content = await readFile(contentPath(id), "utf-8");
  await runServiceOperation(() => startServiceWithContent(content));
}

function intervalOrDefault(profile: ProfileMetadata): number {
  if (profile.autoUpdateIntervalMinutes > 0) {
    return Math.max(
      profile.autoUpdateIntervalMinutes,
      MINIMUM_UPDATE_INTERVAL_MINUTES,
    );
  }
  return DEFAULT_UPDATE_INTERVAL_MINUTES;
}

function updateRemoteProfile(id: string): Promise<void> {
  return runProfileOperation(id, async () => {
    const profile = findProfile(id);
    if (profile.type !== "remote" || !profile.remoteUrl) {
      throw new Error("not a remote profile");
    }
    const remoteContent = await fetchRemoteContent(profile.remoteUrl);
    await checkConfig(remoteContent);
    try {
      const oldContent = await readFile(contentPath(profile.id), "utf-8");
      if (oldContent !== remoteContent) {
        await atomicWriteFile(contentPath(profile.id), remoteContent);
        await reloadIfSelectedAndRunning(profile.id);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await atomicWriteFile(contentPath(profile.id), remoteContent);
      await reloadIfSelectedAndRunning(profile.id);
    }
    settingsDatabase()
      .prepare("UPDATE profiles SET last_updated = ? WHERE id = ?")
      .run(Date.now(), profile.id);
    notifyChanged();
  });
}

export async function selectProfile(id: string): Promise<void> {
  findProfile(id);
  if (selectedProfileId() === id) {
    return;
  }
  writeSelectedProfileId(id);
  notifyChanged();
  await reloadIfSelectedAndRunning(id);
}

export async function startSelectedProfile(): Promise<void> {
  const selectedId = selectedProfileId();
  if (selectedId === null) {
    throw new Error("no profile selected");
  }
  const content = await readFile(contentPath(selectedId), "utf-8");
  await runServiceOperation(() => startServiceWithContent(content));
}

async function setCaptureMode(modeValue: unknown): Promise<void> {
  const mode = parseCaptureMode(modeValue);
  const previousMode = captureModePreference.get();
  if (mode === previousMode) {
    return;
  }
  await runServiceOperation(async () => {
    if (daemonState.status === ServiceStatus_Type.STARTED) {
      const selectedId = selectedProfileId();
      if (selectedId === null) {
        throw new Error("no profile selected");
      }
      const content = await readFile(contentPath(selectedId), "utf-8");
      try {
        await startServiceWithContent(content, mode);
      } catch (error) {
        try {
          await startServiceWithContent(content, previousMode);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "capture mode switch and rollback both failed",
          );
        }
        throw error;
      }
    }
    captureModePreference.set(mode);
    notifyChanged();
  });
}

let updateTimer: NodeJS.Timeout | null = null;

async function runDueProfileUpdates(): Promise<void> {
  const now = Date.now();
  const dueProfiles = listProfiles().filter((profile) => {
    if (profile.type !== "remote" || !profile.autoUpdate) {
      return false;
    }
    const intervalMs = intervalOrDefault(profile) * 60 * 1000;
    return profile.lastUpdated === undefined || profile.lastUpdated <= now - intervalMs;
  });
  await Promise.all(
    dueProfiles.map(async (profile) => {
      try {
        await updateRemoteProfile(profile.id);
      } catch (error) {
        console.error(`update profile ${profile.name}:`, error);
      }
    }),
  );
}

function reconfigureAutoUpdate(): void {
  if (updateTimer !== null) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  const enabled = listProfiles().filter(
    (profile) => profile.type === "remote" && profile.autoUpdate,
  );
  if (enabled.length === 0) {
    return;
  }
  const intervalMs = Math.min(...enabled.map(intervalOrDefault)) * 60 * 1000;
  const earliest = Math.max(
    Date.now(),
    Math.min(
      ...enabled.map((profile) => (profile.lastUpdated ?? 0) + intervalMs),
    ),
  );
  updateTimer = setTimeout(() => {
    void runDueProfileUpdates().finally(() => {
      reconfigureAutoUpdate();
    });
  }, earliest - Date.now());
}

const handlers: Record<
  string,
  (...callArguments: never[]) => Promise<unknown>
> = {
  async priorityState(): Promise<PriorityPanelState> { return priorityPanelState(); },
  async prioritySave(value: PriorityPanelState["settings"], revision: string, profileId: string | null): Promise<PriorityPanelState> {
    if (profileId !== selectedProfileId()) throw new Error("当前配置已切换，请刷新面板后重试。");
    const settings = parsePrioritySettings(value);
    if (settings.enabled) {
      const view = await priorityPanelState();
      const group = view.groups.find(item => item.tag === settings.group);
      if (!group) throw new Error("请选择成员全部为实际代理节点的入口组；业务、汇总、直连及混合分组不能用于自动故障切换。");
      if (settings.order.some(tag => !group.nodes.includes(tag))) throw new Error("顺序包含不属于当前分组的代理节点，请刷新后重试。");
    }
    if (profileId !== selectedProfileId()) throw new Error("保存前当前配置发生变化，请刷新后重试。");
    await savePrioritySettings(prioritySettingsPath(), settings, revision);
    recordSystemProxyHealth("priority-settings-saved", { group: settings.group, enabled: settings.enabled });
    return priorityPanelState();
  },
  async priorityApply(revision: string, profileId: string | null): Promise<void> {
    await runServiceOperation(async () => {
      if (!profileId || profileId !== selectedProfileId()) throw new Error("当前配置已切换，请刷新后重试。");
      if ((await prioritySettingsSnapshot(prioritySettingsPath())).revision !== revision) throw new Error("配置文件已改变，请刷新并确认后再重载。");
      if (daemonState.status !== ServiceStatus_Type.STARTED) throw new Error("代理当前未运行；下次启动会读取已保存配置。");
      await startServiceWithContent(await readFile(contentPath(profileId), "utf8"));
    });
  },
  async list(): Promise<ProfilesState> {
    return profilesState();
  },

  async create(init: ProfileCreate): Promise<ProfileMetadata> {
    const profile: ProfileMetadata = {
      id: crypto.randomUUID(),
      name: uniqueName(init.name),
      type: init.type,
      autoUpdate: init.autoUpdate ?? init.type === "remote",
      autoUpdateIntervalMinutes:
        init.autoUpdateIntervalMinutes ?? DEFAULT_UPDATE_INTERVAL_MINUTES,
    };
    let content: string;
    if (init.type === "remote") {
      if (!init.remoteUrl) {
        throw new Error("missing remote URL");
      }
      profile.remoteUrl = init.remoteUrl;
      content = await fetchRemoteContent(init.remoteUrl);
      await checkConfig(content);
      profile.lastUpdated = Date.now();
    } else {
      content = init.content ?? "{}";
      if (init.content !== undefined) {
        await checkConfig(content);
      }
    }
    return await insertProfile(profile, content);
  },

  async updateMetadata(id: string, patch: ProfileMetadataPatch): Promise<void> {
    await runProfileOperation(id, async () => {
      const profile = findProfile(id);
      let remoteContent: string | null = null;
      if (
        patch.remoteUrl !== undefined &&
        profile.type === "remote" &&
        patch.remoteUrl !== profile.remoteUrl
      ) {
        remoteContent = await fetchRemoteContent(patch.remoteUrl);
        await checkConfig(remoteContent);
        await atomicWriteFile(contentPath(id), remoteContent);
      }
      const store = settingsDatabase();
      store.transaction(() => {
        if (patch.name !== undefined) {
          store
            .prepare("UPDATE profiles SET name = ? WHERE id = ?")
            .run(patch.name, id);
        }
        if (patch.remoteUrl !== undefined && profile.type === "remote") {
          store
            .prepare(
              "UPDATE profiles SET remote_url = ?, last_updated = ? WHERE id = ?",
            )
            .run(
              patch.remoteUrl,
              remoteContent === null
                ? (profile.lastUpdated ?? null)
                : Date.now(),
              id,
            );
        }
        if (patch.autoUpdate !== undefined) {
          store
            .prepare("UPDATE profiles SET auto_update = ? WHERE id = ?")
            .run(patch.autoUpdate ? 1 : 0, id);
        }
        if (patch.autoUpdateIntervalMinutes !== undefined) {
          store
            .prepare(
              "UPDATE profiles SET auto_update_interval_minutes = ? WHERE id = ?",
            )
            .run(
              Math.max(
                patch.autoUpdateIntervalMinutes,
                MINIMUM_UPDATE_INTERVAL_MINUTES,
              ),
              id,
            );
        }
      })();
      notifyChanged();
      reconfigureAutoUpdate();
      if (remoteContent !== null) {
        await reloadIfSelectedAndRunning(id);
      }
    });
  },

  async remove(id: string): Promise<void> {
    await runProfileOperation(id, async () => {
      findProfile(id);
      const store = settingsDatabase();
      store.transaction(() => {
        store.prepare("DELETE FROM profiles WHERE id = ?").run(id);
        if (selectedProfileId() === id) {
          const firstRow = store
            .prepare("SELECT id FROM profiles ORDER BY item_order ASC LIMIT 1")
            .get() as { id: string } | undefined;
          writeSelectedProfileId(firstRow === undefined ? null : firstRow.id);
        }
      })();
      try {
        await unlink(contentPath(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      notifyChanged();
      reconfigureAutoUpdate();
    });
  },

  async reorder(ids: string[]): Promise<void> {
    const store = settingsDatabase();
    store.transaction(() => {
      const currentIds = (
        store
          .prepare("SELECT id FROM profiles ORDER BY item_order ASC")
          .all() as { id: string }[]
      ).map((row) => row.id);
      const known = new Set(currentIds);
      const ordered = ids.filter((id) => known.has(id));
      const orderedSet = new Set(ordered);
      ordered.push(...currentIds.filter((id) => !orderedSet.has(id)));
      const updateOrderStatement = store.prepare(
        "UPDATE profiles SET item_order = ? WHERE id = ?",
      );
      for (const [index, id] of ordered.entries()) {
        updateOrderStatement.run(index, id);
      }
    })();
    notifyChanged();
  },

  async select(id: string): Promise<void> {
    await selectProfile(id);
  },

  async readContent(id: string): Promise<string> {
    findProfile(id);
    return await readFile(contentPath(id), "utf-8");
  },

  async writeContent(id: string, content: string): Promise<void> {
    await runProfileOperation(id, async () => {
      findProfile(id);
      await atomicWriteFile(contentPath(id), content);
      notifyChanged();
    });
  },

  async updateRemote(id: string): Promise<void> {
    await updateRemoteProfile(id);
  },

  async setCaptureMode(mode: CaptureMode): Promise<void> {
    await setCaptureMode(mode);
  },

  async startService(): Promise<void> {
    await startSelectedProfile();
  },

  async takeOverService(): Promise<void> {
    if (desktopService === null) {
      throw new Error("daemon is not available");
    }
    await desktopService.takeOverService({});
    daemonState.retryConnection();
  },

  async pickImportFile(): Promise<{
    fileName: string;
    data: Uint8Array;
  } | null> {
    const result = await dialog.showOpenDialog({
      filters: [{ name: "sing-box profile", extensions: ["json", "bpf"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    return { fileName: basename(filePath), data: await readFile(filePath) };
  },

  async importData(fileName: string, data: Uint8Array): Promise<void> {
    await importProfileData(fileName, data);
  },

  async decodeData(data: Uint8Array): Promise<{ name: string }> {
    const content = await applicationService.decodeProfile({ data });
    return { name: content.name };
  },

  async exportFile(id: string): Promise<boolean> {
    const profile = findProfile(id);
    const result = await dialog.showSaveDialog({
      defaultPath: `${profile.name}.json`,
      filters: [{ name: "sing-box configuration", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return false;
    }
    await writeFile(result.filePath, portablePublicRules(await readFile(contentPath(id), "utf-8")));
    return true;
  },

  async exportData(id: string): Promise<boolean> {
    const profile = findProfile(id);
    const result = await dialog.showSaveDialog({
      defaultPath: `${profile.name}.bpf`,
      filters: [{ name: "sing-box profile", extensions: ["bpf"] }],
    });
    if (result.canceled || !result.filePath) {
      return false;
    }
    const data = await encodeProfileData(id);
    const cachePath = await writeApplicationCacheFile("share", ".bpf", data);
    await copyFile(cachePath, result.filePath);
    return true;
  },

  async encodeData(id: string): Promise<Uint8Array> {
    return await encodeProfileData(id);
  },
};

export function registerProfiles() {
  ipcMain.handle(
    PROFILES_CALL,
    async (
      _event,
      method: string,
      ...callArguments: unknown[]
    ): Promise<ProfilesResult> => {
      const handler = handlers[method];
      if (!handler) {
        return { ok: false, error: `unknown profiles method: ${method}` };
      }
      try {
        const value = await handler(...(callArguments as never[]));
        return { ok: true, value };
      } catch (error) {
        if (error instanceof ConnectError) {
          return { ok: false, error: error.rawMessage };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  reconfigureAutoUpdate();
  startCoreArchive();
  const priorityTimer = setInterval(() => { void runPriorityCheck(); }, 1_000);
  priorityTimer.unref();
  app.once("before-quit", () => clearInterval(priorityTimer));
  startSystemProxyHealthMonitor();
}
