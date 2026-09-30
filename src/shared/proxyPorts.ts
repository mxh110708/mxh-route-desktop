export interface ProxyPortSettings {
  mixed: { enabled: true; port: number };
  socks: { enabled: boolean; port: number };
  http: { enabled: boolean; port: number };
}

export interface ProxyPortPanelState {
  profileId: string | null;
  profileName: string | null;
  revision: string;
  ports: ProxyPortSettings | null;
  running: boolean;
  busy: boolean;
}
