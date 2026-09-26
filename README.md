# MXH Route

MXH Route is a personal Windows routing client derived from the upstream
[`SagerNet/sing-box-for-desktop`](https://github.com/SagerNet/sing-box-for-desktop)
project. It is independently named and is not an official SagerNet release.

The maintained personal changes add:

- Rule, Global, and Direct routing controls on Overview.
- System Proxy and TUN traffic-capture controls on Overview.
- Adaptive System Proxy recovery that checks both the actual CONNECT path and
  Windows proxy ownership, confirms failures, and avoids repeated takeovers.
- A parallel Windows installation that does not take over the official
  desktop client's service, registry key, IPC pipe, or data directories.
- A public personal Release channel with exact asset-name, repository-path,
  version, and signer checks.

See [CUSTOM.md](CUSTOM.md) for upstream synchronization, local signed builds,
security boundaries, and release maintenance.
The [1.14.2 audit](docs/AUDIT-1.14.2.zh-CN.md) classifies retained customizations,
recovery boundaries, and remaining validation limits.

## 图形化故障切换设置与日志保存

- 首次使用需明确选择由实际代理节点组成的入口组；不按组名或服务商名称硬编码。可修改本地 `priority-failover.json` 指定顺序、调整阈值或关闭功能。修改后重载代理即可，无需重新发包。
- 设置页提供独立“自动故障切换”入口：进入后可选择分组、拖拽或上下移动节点、调整高级参数，并查看运行状态和最近切换原因。保存与重载分开，重载前确认，外部配置变化时拒绝覆盖。
- 每个节点独立进行三个 HTTPS 目标探测，不切换主入口来测速。当前节点连续三轮失败、备用连续两轮可用才切换；首选至少三轮成功且稳定两分钟后自动切回。
- 单个网站失败不触发切换；全部不可用时不回落 DIRECT。手动选中受监测节点会把它设为首选，该节点故障仍自动切到健康备用，稳定恢复后切回。
- 系统代理和 TUN 模式均支持；Direct 路由模式暂停自动决策。需保持桌面应用运行，最小化到托盘即可。
- 核心日志 `core-runtime.log` 与探针日志 `system-proxy-health.log` 各保留当前文件及五份滚动备份，每份最多约 10 MiB。关开代理不会清除磁盘历史。
- 日志可能含节点名称、目标域名或地址，请仅作为本机私有诊断资料。应用未运行期间的核心日志不能完整补录，切换也不保证已有连接无缝迁移。

详见 [探测、恢复与日志规则](docs/proxy-health.md)。

配置位置、完整示例与参数说明见 [配置驱动故障切换](docs/PRIORITY-FAILOVER.zh-CN.md)。

## Security

This repository and its CI contain no proxy profiles, VPS archives, passwords,
tokens, private keys, or code-signing material. Signed releases are produced
locally. The public application update channel does not embed a GitHub token.

## Upstream and license

The desktop, dashboard, and core source retain their upstream copyright and
license notices. See [LICENSE](LICENSE). The application name MXH Route is used
to comply with the upstream requirement that derivative works not use the
original application's name or imply official association without consent.
