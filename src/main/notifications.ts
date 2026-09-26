import { Notification } from "electron";

import type {
  NotificationCancel,
  Notification as NotificationMessage,
} from "../shared/gen/daemon/started_service_pb";
import { startedService } from "./daemon";
import { daemonState } from "./state";

const RECONNECT_DELAY = 3000;

const shown = new Map<string, Notification>();
let systemProxyWarning: Notification | null = null;

export function showSystemProxyRecoveryWarning(): void {
  if (!Notification.isSupported()) return;
  systemProxyWarning?.close();
  const notification = new Notification({
    title: "MXH Route 系统代理未保持开启",
    body: "系统代理在自动恢复后再次被关闭。为避免与其他代理争夺，MXH Route 已暂停自动恢复；请检查代理软件或手动重启 MXH Route 代理。",
  });
  systemProxyWarning = notification;
  notification.on("close", () => {
    if (systemProxyWarning === notification) systemProxyWarning = null;
  });
  notification.show();
}

function notificationKey(typeID: number, identifier: string): string {
  return `${typeID}/${identifier}`;
}

function showNotification(message: NotificationMessage, open: (openURL: string) => void) {
  const key = notificationKey(message.typeID, message.identifier);
  shown.get(key)?.close();
  const notification = new Notification({
    title: message.title,
    subtitle: message.subtitle,
    body: message.body,
  });
  notification.on("click", () => {
    if (message.openURL !== "") {
      open(message.openURL);
    }
  });
  notification.on("close", () => {
    if (shown.get(key) === notification) {
      shown.delete(key);
    }
  });
  shown.set(key, notification);
  notification.show();
}

function cancelNotification(message: NotificationCancel) {
  const key = notificationKey(message.typeID, message.identifier);
  const notification = shown.get(key);
  if (notification === undefined) {
    return;
  }
  shown.delete(key);
  notification.close();
}

async function loopNotifications(signal: AbortSignal, open: (openURL: string) => void) {
  while (!signal.aborted) {
    try {
      for await (const event of startedService!.subscribeNotifications({}, { signal })) {
        switch (event.event.case) {
          case "send":
            showNotification(event.event.value, open);
            break;
          case "cancel":
            cancelNotification(event.event.value);
            break;
        }
      }
    } catch {}
    if (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
    }
  }
}

export function registerNotifications(open: (openURL: string) => void) {
  if (!Notification.isSupported() || startedService === null) {
    return;
  }
  daemonState.on("session", (signal: AbortSignal) => {
    void loopNotifications(signal, open);
  });
}
