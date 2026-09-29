# MXH Route 延迟测速口径

## 2026-09-29 修订

桌面端手动节点/分组 URL 测速改为预热后 HTTP HEAD 请求耗时，参考
Mihomo `adapter/adapter.go` 的 `unified-delay` 行为。首次请求建立完整连接，
第二次请求尽可能复用连接并独立计时。它仍是请求响应耗时，不是网络单程时延，
不能将旧结果除以二，也不能将两个节点的测试值简单相加。

实现位于核心仓库 `common/urltest/unified.go`，由桌面 daemon 的 URLTest
接口通过请求上下文显式启用。无该标记的后台 URL 测试保持原有行为；
自定义自动故障切换的探测调度、连续失败确认和切回阈值均未修改。
原有 URLTest 类型分组仍共享其延迟历史及分组选优机制。

测试地址保持 `https://www.gstatic.com/generate_204`。使用完整 outbound 的
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
已验证源码行为和真实链路，尚未打包安装验收，已安装应用仍使用旧测速逻辑。

参考：https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/adapter.go
