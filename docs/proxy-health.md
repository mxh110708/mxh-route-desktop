# System proxy quality monitoring

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
