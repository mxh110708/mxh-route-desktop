# System proxy quality monitoring

## mxh.6: priority failover and retained logs

`US-West Entry` uses a fixed provider priority: DMIT, then VMISS, then MoeCloud.
Existing IPv4/IPv6 order within a provider is preserved. Only concrete node
members of this selector participate; other selectors and DIRECT are untouched.
This is failover, not minimum-latency selection. Runtime-only loopback HTTP probe
listeners route independently through each candidate without changing the live
selector. Ports are allocated at startup; the source profile is not modified.
Both system-proxy and TUN capture modes use this monitor. Direct routing mode
suspends decisions. Keep the desktop application running (tray is sufficient).

Each candidate is tested against three certificate-verified HTTPS endpoints.
Two successes make a usable round; HTTP 403/429 is reachable. Slow completed
responses alone do not disqualify a node. Three failed rounds on the selected
node and two successful rounds on a backup permit failover. Higher-priority
nodes must have three successful rounds spanning at least 120 seconds before
failback, with a 60-second failback cooldown. A failure resets the stable window.
All-down leaves the selection unchanged; it never chooses DIRECT. Probe rounds
are serialized, with at least 10 seconds between failing rounds and 30 seconds
when all nodes are healthy. Failure detection also includes probe duration.

Manual selector changes pause automation until an explicit proxy start/reload.
The pause and runtime probe mapping survive a desktop restart for the same
profile and capture mode. Profile/mode/service changes cancel stale decisions.
Existing connections are not promised seamless migration. The selector's
configured interrupt policy remains unchanged.

`system-proxy-health.log` now retains 10 MiB per file and five backups, and includes per-node probe results, selected-node
changes and errors. Node recovery takes precedence over blind service reloads;
a whole-proxy failure can still request recovery when the selected node's
independent probe was recently healthy.

`core-runtime.log` archives the daemon log subscription in the application data
directory (10 MiB per file, five rotated backups). Restarting or clearing the
daemon's in-memory log does not delete this archive. Initial/reconnected buffer
replays are labelled historical, and reset boundaries are recorded. Timestamps
are receipt times; original core messages may also contain their own timestamps.
The archive can contain node names, destination addresses and domains: keep it
private. Credential-shaped fields are redacted; full profiles are never saved
by this logger. It cannot recover logs already lost before installation or while
the desktop application was closed. Normal app exit allows a bounded flush;
forced termination/disk errors can still lose the final records.

## Earlier system-proxy recovery policy

Version mxh.5 replaces CONNECT-only checks with certificate-verified TLS and a
small HTTPS HEAD request. Three fixed public endpoints are sampled: gstatic,
Cloudflare and ChatGPT. No cookies, credentials or user browsing data are sent.

Every sample records local TCP time, CONNECT time, TLS time, HTTP-header time,
total duration and HTTP status. CONNECT time is not a separate DNS measurement;
the proxy handles DNS/remote dialing internally. This is latency/availability
monitoring, not a bandwidth test. HTTP 403/429 remains a reachable response and
does not alone trigger a restart.

First sample is scheduled five seconds after the desktop monitor starts; normal
interval is 60 seconds. At least two targets must fail or take five seconds or
longer to count as a bad round. Three consecutive bad rounds (five-second retry
delay) permit one serialized reload. Continued failure remains logged without
repeated reloads until a satisfactory round rearms the gate. Changed profile,
service state, capture mode or Direct mode cancels a stale recovery request.

`system-proxy-health.log` in the application's configured data directory records
monitor startup, service changes, skips, samples and recovery operations. It
rotates at 2 MiB and retains one `.1` backup. It contains fixed probe hostnames
and timings, not profile contents, node credentials or visited URLs.

These probes cannot establish why a past outage occurred, nor guarantee every
website or a separate application's language initialization works correctly.
The testdata certificate/key are public, self-signed test-only fixtures and must
never be used by a deployed service.
