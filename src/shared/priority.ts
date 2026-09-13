export interface PrioritySettings {
  enabled: boolean;
  group: string;
  order: string[];
  failureRounds: number;
  backupSuccessRounds: number;
  recoverySuccessRounds: number;
  recoveryStableMs: number;
  failbackCooldownMs: number;
  probeTimeoutMs: number;
  healthyIntervalMs: number;
  failureIntervalMs: number;
}
