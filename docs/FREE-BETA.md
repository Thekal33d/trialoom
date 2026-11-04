# Public free beta

Scope accepted by the user on 2026-11-01 (D049). This document records an explicit change to the first release; the original PRD stays unchanged. Task state lives in [BACKLOG.md](BACKLOG.md).

## User promise

A builder signs up publicly with verified email or optional Celo wallet proof (D060), creates a workspace, authorizes a preview website, and requests a bounded browser test. They receive observed results, findings and recorded replay. Signup and the limited testing allowance are free. No customer wallet, deposit, spending approval, paid campaign or operator recruitment is required. [Wallet login and agent-access limits](WALLET-01.md).

Only advertise testing availability once the hosted execution path is verified. Account creation can be implemented first without pretending that an automatic test has run. Preserve existing invited workspaces and their obligations. Do not convert old paid records into free records.

Initial limits: one free workspace per verified account, three projects, one active test and three admitted test requests per account per UTC day. Cancelled requests count. FREE-02 adds one executing browser, ten queued/active requests, thirty requests per UTC day across the deployment and five per external target origin. These are conservative product defaults, not fraud prevention by themselves; trusted edge limits and abuse response remain release gates. Paid resources stay disabled until a separate sponsored spend ceiling and recovery journal exist. A user must authorize the target and any supporting origins; signup does not authorize arbitrary probing or relax runner restrictions. [Local execution and limits](FREE-02.md).

## Five release workstreams

| ID | Work | Completion evidence |
| --- | --- | --- |
| FREE-01 | Public signup and free workspace | Email possession before account creation; atomic identity/workspace creation; no role or money escalation; duplicate/expired/consumed link handling; desktop/mobile flow |
| FREE-02 | Free test request and execution | Authorized preview and bounded read-only journey; atomic quotas; durable dispatcher; RUN-03 isolation/resource/restart checks; real result and replay; zero customer payables |
| BUY-01 | Useful sponsored usebuy integration | Fresh catalog/quote, capped platform budget, durable purchase identity, useful output attached to the real report, actual Celo receipt and uncertain-settlement recovery; no customer charges |
| FREE-03 | Hosted staging and release operations | App/worker, Postgres, private evidence, HTTPS, email delivery/recovery, secrets/roles, backups/restore, monitoring, retention, abuse and target controls |
| FREE-04 | Real-user release and hackathon package | External user completes signup/test/replay; disclose service limitations; public-safe repository/demo; enrollment, ERC-8004 identity and submission evidence |

## Selected buy integration

Use Cencori inference through the buy gateway to explain a completed test's sanitized observations and suggest a next debugging step. The isolated Chromium runner remains the source of test evidence. A model summary cannot create or alter an assertion, severity, independent verification, acceptance or payment decision. Display it separately from observed results and retain evidence references.

The 2026-11-01 live catalog advertises `cencori.v1.chat.completions`, model `maximo-atlas-1.3`, and 256/1024/4096 output-token options. Catalog availability and prices do not prove paid output delivery; quote the exact request and validate its response. Start with the smallest useful bounded request. Do not send credentials, private traces, source code, raw page text or personal data. Provider output is untrusted text, never executable instructions or authorization.

The platform funds this resource from a separate, explicitly authorized wallet and aggregate cap. Public users cannot choose endpoints, recipients, tokens, models or spending amounts. Reserve before dispatch, settle against the same intent, and never blindly repurchase after an uncertain response. The existing ALPHA-09 reimbursement path is unsuitable for sponsored requests until customer charging is explicitly excluded and tested.

The buy browser remains an evaluated alternative. Its current command API does not establish Trialoom's proxy witness or Playwright trace-export requirements; do not substitute it for the verified runner merely to produce a transaction. VAL-04's browser-specific acceptance remains open if that path is pursued.

## Hackathon dependency

User selected **Build with buy** and confirmed no enrollment yet. The current event deadline is **2026-11-09 09:00 GMT / 10:00 Africa/Lagos**. See [HACKATHON.md](HACKATHON.md) for dated official requirements and unresolved attribution details. Free customer accounts can produce useful demand for paid external services, but signup counts and self-funded wallets do not establish the event's independent-user qualifier.

## Deferred from the free beta

The paid service catalog, customer payment authority, operator compensation, commissioned reproductions, repository repair delivery and independent repair verification remain later marketplace work. Preserve their existing foundations and debts. Their completion is not required to advertise a limited free testing service; do not advertise them as live features.

Public signup does not waive execution isolation, evidence privacy, account recovery, cost limits, or honest result labels. Hosting, a verified sending domain, a resource wallet/cap and the actual hackathon entry still need configuration. No spending or external publication is authorized merely by creating local commits.
