# Clash 对照审计与首批修订（2026-09-14）

## 范围与证据边界

本轮只读检查本机健康日志、Clash Verge 开关、Clash/Mihomo 与 sing-box 权威配置，及 MXH Route 本地源码。上游参考为检查当日的 Clash Verge Rev main 与 Mihomo Meta 分支，不代表本机安装版本源码完全一致。未切换代理、重启服务、修改权威配置或服务器；未做真实故障注入。

最近 10000 条健康事件含 344 次质量采样、2 次自动切换，没有自动重载事件。北京时间 11:41 的连续采样均为三个目标 TLS ECONNRESET（约 5002ms）；11:41:24 切换至备用入口，11:48:39 切回首选。这证明这段记录中故障切换实际发生，不证明历史断连均由同一原因引起。

## 对照结论

| 层面 | 观察 | 本轮处理 |
|---|---|---|
| 系统代理管理 | Clash Verge 将系统代理更新串行化，并提供可选守护；本机守护当前关闭 | 不强制抢占 Windows 代理，增加只读状态诊断 |
| 节点恢复 | Mihomo fallback 按存活状态选节点，拨号失败触发健康检查 | 保留 MXH Route 的独立节点探针及切回防抖，不把节点故障一律归因于内核 |
| 健康判断 | MXH Route 在无入口监测时，原逻辑可能把多站慢成功也计为重载依据 | 慢成功仅标记 degraded，至少两个真实失败才进入恢复判断 |
| 状态竞态 | 原检查只比较配置、模式和服务代数，没有比较分组选择 | 探测前后及排队重载前核对全部分组选择，丢弃不同选择下的旧样本 |
| 连续故障计数 | 让位节点恢复时可能保留之前的失败次数 | 让位时清空恢复计数，避免拼接不连续的证据 |
| DNS | Clash 权威配置采用 fake-IP；sing-box 权威配置使用远程 DoH、国内 DNS 和 evaluate/respond/备用规则，均限制 IPv6 解析 | 并非缺少备用 DNS；不直接照搬 fake-IP 或更改 DNS 路由，以免改变语义 |

## 新诊断日志

mxh.12 补强：自动切换与重载共用恢复操作代数，操作前立即使旧样本失效；操作结束（包括失败）后观察 30 秒，再要求观察期后开始的新整体代理采样及新独立节点证据。独立证据时效按一轮开始时间保守计算，过期证据不允许重载。观察期只限制自动重载，不阻止节点切换。重载执行前再次核对，避免状态订阅延迟导致紧接重载。

系统代理健康检查增加 `windows-proxy-diagnostic`：记录当前用户 ProxyEnable、HTTP/HTTPS 地址是否匹配本次检查端口、是否配置 PAC、注册表 AutoDetect 值。只读注册表，最多等待 2 秒；读取失败记录 readable=false，不打印 PAC URL、其他代理地址或凭据，不改注册表。

它用于区分“显式连接本地代理正常，但 Windows 代理被关闭或指向其他地址”。注册表摘要不是所有 WinINET 连接选项的完整快照，也不能证明 Git 等应用实际采用了系统代理；PAC/自动发现及各应用自己的代理设置仍须另查。

## 验证与下一步

类型检查及 35 项恢复、入口策略、运行时配置测试通过，包括慢成功不触发恢复、分组变更使样本失效、代理状态摘要不泄漏 URL。尚未打包、安装或进行线上故障回归；不宣称历史根因已确定或故障已经根治。

上线后若复现，按同一时间窗口对齐 `windows-proxy-diagnostic`、`quality-sample`、`priority-probe`、`priority-switch-*` 与核心日志，再判断是系统代理偏移、入口断连、DNS 或业务出口故障。保留 DNS/服务端参数，不继续叠加无依据的自动重启。

## 上游参考

- [Clash Verge Rev 系统代理管理](https://github.com/clash-verge-rev/clash-verge-rev/blob/main/src-tauri/src/core/sysopt.rs)
- [Mihomo fallback 分组](https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/outboundgroup/fallback.go)
