# MXH Route 延迟测速口径

## 2026-09-30 测试目标对齐

桌面端手动节点/分组测速在未指定 URL 时，改用 Clash Verge 2.5.6 的默认目标
`http://cp.cloudflare.com/generate_204`。目标集中定义在核心仓库
`common/urltest/unified.go` 的 `DefaultUnifiedTestURL`；配置中显式指定的
URLTest 分组 URL 继续生效。

1.14.2-mxh.5 已对齐预热后的请求计时，但默认目标仍为 Google gstatic。
这会使两个应用测到不同网站的往返耗时，IPv4 落地尤其明显。
本次修订仅调整带 `WithUnifiedDelay` 标记的手动测速默认目标。
不带标记的后台健康探测仍使用其原有目标与计时方式。

本次固定 CORONA IPv4 入口、同一组落地参数，两轮隔离对照得到：

| IPv4 落地测试目标 | MXH Route 预热后 ms | Mihomo unified-delay ms |
| --- | --- | --- |
| `https://www.gstatic.com/generate_204` | 332 / 340 | 328 / 339 |
| `https://cp.cloudflare.com/generate_204` | 181 / 187 | 202 / 198 |
| `http://cp.cloudflare.com/generate_204` | 202 / 167 | 207 / 201 |

请求跟踪确认 gstatic 第二次 HEAD 复用了完整代理链路的连接，无额外 TLS
握手，写入请求后等到首字节约 337–342 ms。Google 目标的额外耗时不是
重复累加两次测试，也不是绕过入口直测落地；两个内核测相同目标时均可复现。
具体远端 DNS/CDN 路由原因尚未进一步定位。

样本为顺序测试，会受网络波动影响。Cloudflare 是比较基准，不表示所有
网站都能达到该时延；显示值仍是 HTTP 请求响应耗时，不是单程网络时延。
保留完整 detour 和第二次请求计时，没有对结果除以二。

新增默认目标回归测试验证 HEAD 主机、路径、两次请求和同一 outbound 的
连接复用。带发布标签的 `go test ./common/urltest ./protocol/group ./daemon`
通过。重新编译后直接调用空 URL，IPv4 落地两轮得到 197 / 199 ms，入口
197 / 190 ms，ATT IPv6 为 242 / 258 ms；仍测量完整入口与落地链路。
源码修改需要包含新核心的安装包才能在已安装应用中生效。

Clash Verge 2.5.6 参考：
https://github.com/clash-verge-rev/clash-verge-rev/blob/v2.5.6/src/components/proxy/proxy-head.tsx

## 2026-09-29 修订

桌面端手动节点/分组 URL 测速改为预热后 HTTP HEAD 请求耗时，参考
Mihomo `adapter/adapter.go` 的 `unified-delay` 行为。首次请求建立完整连接，
第二次请求尽可能复用连接并独立计时。它仍是请求响应耗时，不是网络单程时延，
不能将旧结果除以二，也不能将两个节点的测试值简单相加。

实现位于核心仓库 `common/urltest/unified.go`，由桌面 daemon 的 URLTest
接口通过请求上下文显式启用。无该标记的后台 URL 测试保持原有行为；
自定义自动故障切换的探测调度、连续失败确认和切回阈值均未修改。
原有 URLTest 类型分组仍共享其延迟历史及分组选优机制。

本次最初使用 `https://www.gstatic.com/generate_204`（已由 9 月 30 日修订
替换手动测速默认目标）。使用完整 outbound 的
DialContext，保留配置的 detour 链路；连接被服务器关闭后再次拨号仍走同一
outbound，不回退到系统直连。第二次请求失败但首次成功时返回首次样本；
父上下文取消或总超时时返回错误。显示值最小 1 ms，避免 0 被解释为不可用。

## 落地链路

本次核对的权威配置中，两个美西 A 出口均配置 `detour: US-West Entry`。
实际测试路径是本机 -> 当前选中的入口 -> 落地 -> 测试网站 -> 返回本机。
没有直接连接落地来代替链路测速，也没有通过算术相加伪造端到端结果。
入口选择发生变化后应重新测速；历史样本不是新路径的实时值。

## 验证

- 新增 7 个测试：预热并复用完整拨号链路、冷健康探测不变、关闭保活后仍经
  outbound 重拨、入口失败不直连、取消传播、第二次失败的首次样本回退、数值边界。
- `go test ./common/urltest ./protocol/group ./daemon` 通过；同一组带
  `with_utls,with_quic,with_clash_api` 标签也通过。urltest 连续三轮通过。
- 使用无入站的隔离 sing-box 实例和仅回环控制接口的隔离 Mihomo 实例。
  固定 CORONA IPv4 入口及相同 HTTPS 测试地址，各两轮；没有切换系统代理/TUN，
  没有修改或重载已安装的客户端。隔离实例均已退出。

| 路径 | MXH 首次请求 ms | MXH 预热后 ms | Mihomo unified-delay ms |
| --- | --- | --- | --- |
| CORONA IPv4 | 410 / 383 | 173 / 183 | 171 / 173 |
| 美西 A IPv4 落地 | 831 / 868 | 317 / 338 | 345 / 333 |
| 美西 A ATT IPv6 落地 | 678 / 557 | 439 / 233 | 295 / 245 |

样本按顺序采集，不是同时测量；IPv6 有明显波动，不保证两个内核数字完全一致。
该修订已随 1.14.2-mxh.5 发布。本节表格保留当时使用 gstatic 的验收结果；
9 月 30 日发现并修正了与 Clash Verge 默认测试目标不同的问题。

参考：https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/adapter.go
