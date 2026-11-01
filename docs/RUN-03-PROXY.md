# Restricted preview proxy checkpoint

RUN-03 step 3 connects an isolated Chromium sandbox to a host-controlled HTTPS proxy. This checkpoint tests owned offline fixtures. It does not yet dispatch a Trialoom assignment, register a host, submit evidence, or test Blokaz.

## Enforced connection path

```text
Chromium in gVisor, network=none
  -> sandbox-local TCP bridge
  -> one mounted Unix socket (read-only channel)
  -> separate trusted HTTPS proxy
  -> admitted IP, verified upstream TLS, approved HTTP authority
```

The dedicated `runsc-preview` runtime adds `--host-uds=open` and `--network=none`. The original `runsc` runtime is preserved. The browser has no non-loopback interface or external TCP/UDP route, including direct DNS. The one shared mount is a fresh, 1 MiB tmpfs volume containing the proxy socket and a public certificate pin. It is read-only in the browser. It contains no private key, host API credential, Docker socket, repository, or application data. Opening an explicitly mounted Unix socket is the deliberate exception to the earlier no-mount offline policy; no general host filesystem access is added.

The browser's loopback bridge is not trusted to enforce destinations. The separate proxy enforces every request, and direct connections still fail if the bridge is bypassed. In the test topology, the proxy and its owned HTTPS fixture are also in a resource-bounded, network-disabled container; only their loopback exchange is possible. A test-only transport adapter maps the checked synthetic public IP to that loopback fixture and asserts the IP, port, TLS hostname and verification settings it receives. It is never supplied by the browser. The proxy's default transport uses the checked IP literal with Node HTTPS; there is no fixture/private-address option in application target admission.

## HTTPS and request policy

`admitPreview` validates up to eight exact HTTPS origins using the existing public-address admission code. IP-literal origins, credentials, custom ports, paths and noncanonical names are refused. The host freezes the initial address set. Before each upstream request and redirect, DNS is revalidated; a private/reserved answer, lookup failure or newly introduced IP refuses access. The upstream connection uses that validated IP directly, with the approved hostname for TLS SNI, certificate verification and the HTTP Host header. No second DNS resolution occurs at connection time.

The proxy terminates the browser-side HTTPS connection with an ephemeral host-owned certificate and independently verifies the real upstream certificate. This permits checking HTTP authority and redirects inside TLS, including attempts to use a different Host through an allowed CONNECT tunnel. The browser trusts only the supplied ephemeral public-key pin; no CA is installed globally and upstream certificate verification is never disabled. The test supervisor generates fixture identities using the already installed OpenSSL, pipes them only to the unit-test/broker process, and removes its temporary files. Private keys live only in process memory and private scratch, never in the image, shared channel or logs.

The initial policy permits GET and HEAD only, with no request body. Plain HTTP, WebSocket upgrades, nested CONNECT, off-origin absolute URLs, forged authority and other methods are refused. Request headers use a small explicit allowlist; proxy credentials are not forwarded. Response hop-by-hop headers and alternate-service advertisements are removed. Redirects are released to the browser only after their destination passes admission. This policy constrains origins and HTTP methods; it is not a guarantee that an allowed website implements GET without side effects. Authenticated forms, wallets, WebSockets and broader journeys remain outside this checkpoint.

## Bounds and observations

| Control | Maximum |
| --- | --- |
| Connections | 64 total, 8 concurrent |
| HTTP requests inside admitted TLS tunnels | 100 |
| Headers | 8 KiB per block; 2 MiB accumulated parsed request metadata |
| Response | 1 MiB including headers per response; 8 MiB aggregate |
| Time | 60 seconds per proxy, 15 seconds per connection, 5 seconds idle |
| Sandbox | 1 GiB memory, no additional swap, 1 CPU, 256 tasks, 128 MiB scratch |
| Harness output | 64 KiB per attached process |

Request metadata and response-byte counters are application-level bounds, not whole-wire TLS bandwidth accounting. Request bodies are not forwarded. Parser, connection, time and OS resource limits also apply. Budget exhaustion, cancellation and expiry destroy active upstream requests and client sockets; a late DNS result cannot reopen access. A stopped proxy cannot become a direct-network fallback.

Observations come from the separate proxy process. They contain only admitted origins (or null for unapproved names), fixed reason codes, bounded counters and byte totals. No requested paths, query strings, unknown hostname strings, headers, cookies, page contents, certificate keys or raw error messages are recorded. The current snapshot is local test evidence; delivery and reconciliation through Trialoom's authenticated host witness API remain part of the next integration step.

## Run and verify

Requires the dedicated environment and cached image from [the gVisor checkpoint](RUN-03-HOST.md), Node 24 and local OpenSSL supporting `req -addext`. The test image is built offline from an inspected immutable browser image and explicit source/dependency copies; no dependency download or workspace dotenv is used.

```sh
orb start trialoom-runner
# Once; refuses another machine, altered runtime configuration or live containers.
orb -m trialoom-runner -u root -w /root bash -s < runners/setup-preview-runtime.sh
npm run runner:proxy-check
# Focused isolated policy/TLS suite:
npm run runner:proxy-check -- --unit-only
orb stop trialoom-runner
```

The check runs 13 policy/TLS/refusal groups inside gVisor, two fresh real Chromium journeys through the separate proxy, and an active-browser proxy-loss check. It verifies permitted navigation and redirects, denial of private/metadata/IPv6/direct UDP connections, changed DNS, forged hosts, certificate mismatch, unsupported methods/protocols, traffic/concurrency limits, cancellation including during DNS validation, deadlines and cleanup. The supervisor reads the proxy's private snapshot separately from browser output. For the loss check, an active browser first proves allowed access, the supervisor kills the proxy, and a fresh navigation must fail. All owned containers and the temporary channel volume must be absent before cleanup is reported as successful. [Evidence](evidence/RUN-03-proxy.json).

An initial request-budget check failed because Node's HTTP parser can bypass socket data events; enforcement now charges parsed request metadata and retains the parser's per-block limit. The browser fixture initially retried navigation before Chromium had completed its error-page transition; the blocked navigation was moved to the end. A first shutdown fixture stopped every channel user, which unmounted and cleared its tmpfs volume; the final check keeps a browser active during the actual proxy kill. Failed attempts do not count as passing evidence.

## Remaining RUN-03 work

The later [application integration](RUN-03-INTEGRATION.md) binds this proxy to live permissions, immutable host-witness receipts and bounded evidence/replay. The owned read-only journey passes; the authorized Blokaz homepage loads but records scope/budget blocks. The local external watchdog is verified. Durable production recovery, adversarial resource exhaustion, deployment and independent-operator validation remain open. This library/check itself still does not enable arbitrary-site execution.

Official sources checked on 2026-11-01: [installed gVisor release flags](https://github.com/google/gvisor/blob/release-20261026.0/runsc/config/flags.go), [gVisor networking](https://gvisor.dev/docs/user_guide/networking/), [Node TLS APIs](https://github.com/nodejs/node/blob/main/doc/api/tls.md), and [Docker tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/).
