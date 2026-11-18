# LAN RPC v2

This protocol is transport-neutral, business-neutral, and request-scoped. HTTP remains anonymous; non-loopback direct HTTP clients must explicitly consent with `--allow-http`. HTTPS still requires verified TLS and the existing Bearer credential. SSH is the default discovery/remote-access prerequisite. Claims and request IDs are correlation/concurrency identifiers, not authentication credentials. There is no Feishu identity, messaging, approval, group-routing, or bot implementation here; a downstream Feishu developer must adapt that bot's bind syntax separately for session selection.

## One machine, one SSH ingress

All sessions on a machine are reachable through its existing SSH port (normally 22, configurable with OpenSSH). A long-lived user binding identifies an IP and full `sessionId`. Before admitting a new request, the client may resolve that logical session to its current descriptor and pin `instanceId` and `generation` for that request. Events, tool replies, retries and downloads for an existing request keep its original pin; uncertain work is never moved to a new runtime or replayed. Sessions retain separate internal listeners, with no machine-wide HTTP daemon or fixed discovery port. Direct HTTP/HTTPS remains an explicit alternative.

## Migration and conversation execution

V2 is a deliberate breaking protocol revision. Use `/v2/session` and `/v2/requests`; v1 API requests return HTTP 410 `protocol_upgraded`, rather than accepting a request under changed semantics. Existing request records are memory-only and cannot be migrated across a restart. Drain/query the old generation before upgrading; never replay an uncertain request automatically. Local discovery descriptors retain their `sessionId`, instance/generation/endpoint fields and identify protocol version 2.

Requests execute visibly in the selected real OMP or Pi conversation. The host appends `request.message` as a displayed custom user message and preserves that message, assistant replies, and tool history in the conversation. Existing history is neither rewritten nor hidden. There is no child agent, separate branch, or alternate execution fallback.

The selected conversation retains its existing system/developer instructions, tools, permissions, and approval behavior. RPC content is subordinate user task context. Optional `request.instructions` and result guidance affect only that request's provider context, never the persistent system prompt or displayed transcript, and are not reinjected after OMP accepts later CLI input. Caller tools and `rpc_result`/`rpc_artifact` are request-scoped additions, removed when the request ends; ordinary host tools are preserved. Hosts without these real-conversation boundaries reject submissions with `host_unsupported`, never a child-agent fallback. Isolated schema-validator processes are not agent executors.

After a structured result is accepted, request tools are removed but the caller's request instructions remain available for the original native turn's final provider step. The context explicitly marks the result already accepted, so it does not request another submission. This allows caller-specific completion guidance, such as a short acknowledgement instead of repeating the answer, without enforcing presentation policy or aborting the model in the transport. Instructions disappear when the native turn ends or later native user input is accepted; they are never written into conversation history.

Pi uses the same wire contract through its public extension APIs. Because Pi exposes no tool-unregister operation, “removed” means deactivated and replaced by non-executable generic registry entries; old captured handlers reject with `host_cancelled`, and request-specific handler closures, descriptions and schemas are cleared. Conversation history is not erased. Retired names can be safely reused; 8192 distinct owned names per extension lifetime is the hard cap, after which execution fails without installing additional tools. Pi cancellation preserves native scheduling: legacy 0.73/0.74 may enter the provider callback with an already-aborted signal after cancellation during context preparation, so provider implementations must honor that signal. No uncertain request is replayed.

OMP owns input, steering, interruption and conversation navigation. Raw CLI input does not cancel structured RPC work, rebuild a listener, or force the native turn to stop. A structured request can still publish its explicit `rpc_result` after native CLI steering; ordinary CLI prose is never interpreted as its result. Successful result submission commits the RPC outcome without aborting OMP's turn. Native transcript forwarding ends at a later native user-message boundary so unrelated CLI content is not returned to the caller. Native cancellation is reported as `interrupted`, including in structured mode. Explicit wire cancellation and deadlines can stop only a still-owned RPC turn, not subsequent CLI work. Committed outcomes are immutable and side effects are never rolled back.

History navigation within the same Session ID and working directory preserves the listener, instance, generation, queued work and retained results. Before-navigation events are observations only, including when navigation is cancelled. If OMP removes an in-flight request's anchor from the active history, only that request association ends; the plugin does not abort OMP or cancel other queued requests. A genuinely different session or working directory, explicit listener configuration/restart, or process shutdown can replace the listener.

Endpoint shutdown allows at most 1500 ms for an aborted executor to drain before reporting `host_drain_timeout` and attempting owned artifact cleanup. This does not claim that an uncooperative host tool's side effects were stopped. Already terminal records remain immutable even if later cleanup fails.

## Common conventions

JSON timestamps are Unix milliseconds. IDs are case-sensitive strings. `requestId`, `workerId`, and `claimId` match `[A-Za-z0-9_-]{1,128}`. Server IDs are UUIDs. All mutation bodies and request-scoped query strings carry both `instanceId` and a positive safe-integer `generation`. They must match this listener, not merely a current session with a reused port. User-facing `sessionId` selection resolves to this identity; it never replaces either wire field. Every record also carries server-owned `requestId`, `instanceId`, `generation`, and `sessionId`; native tools receive these through closures, never model arguments.

Errors are HTTP `{ "error": { "code": "machine_readable_code", "message": "English explanation", "details": optional_JSON } }`. No stack, token, credentials, file source path, or provider request is returned. Terminal request/tool errors use the same inner `{code,message,details?}` structure. Unknown body fields, malformed JSON, non-JSON bodies, Origin headers, and redirects are rejected. GET routes accept only their documented query parameters.

Schema dialect: JSON Schema draft 2020-12, accepting boolean or object schemas. Standard assertions such as `pattern`, `patternProperties`, `uniqueItems`, and local recursive references are supported instead of prohibited as a semantic subset. Compilation and evaluation run outside the OMP/HTTP event loop in killable, resource-limited Node processes. `$id`, anchors and dynamic references follow the validator's draft-2020-12 semantics for resources included in the schema document; unresolved external references are rejected, with no network fetch. `$async` and executable extension keywords are not accepted. `format` remains annotation-only. Validation errors identify `instancePath`, `schemaPath`, `keyword`, and `message`. No coercion, default insertion, removal of properties, or mutation of caller data occurs in LAN RPC validation.

Each isolated validation operation has a default 2000 ms wall-clock budget, including queue time. At most two workers run concurrently, with at most 32 queued operations; each Node worker has a 64 MiB V8 heap limit (not an OS total-memory guarantee). Timeout/abort terminates the worker; the event loop remains available for CLI input, request cancellation and HTTP queries. Size/depth limits still apply, but regex and unique-item semantics are not silently disabled. `validation_timeout`, `validation_capacity`, `validation_aborted`, and `validation_worker_failed` are explicit errors. Accepted request identity, terminal state and callback lease are rechecked after every asynchronous validation before committing any data.

Current OMP hosts synchronously inspect native tool parameter schemas. LAN RPC therefore exposes a safe structural parameter projection and includes the complete original schema in the tool description; only the isolated validator is authoritative for complex constraints. The schema supplied by the caller is not rewritten for validation. Existing host argument normalization remains host behavior, not an RPC business transformation. Native-mode message/event payloads do not pass through result-schema validation.

## Session discovery

`GET /v2/session` returns:

```json
{
  "protocolVersion": 2,
  "instanceId": "SERVER_UUID",
  "generation": 123,
  "sessionId": "OMP_SESSION_ID",
  "cwd": "/workspace",
  "busy": false,
  "queueDepth": 0,
  "capabilities": { "structuredResults": true, "callerTools": true, "artifacts": true, "conversationExecution": true }
}
```

No token is returned. `busy` includes conversation or RPC work. `conversationExecution: false` means that this host cannot safely accept v2 work in the selected real conversation. User-facing local and SSH selectors match `sessionId`: an explicit selection must resolve to exactly one PID-live descriptor, while an omitted selection is accepted only when exactly one PID-live descriptor exists. Missing/stale selections produce `session_not_found`, duplicate live matches produce `session_ambiguous`, and multiple live sessions without a selector produce `session_selection_required`. Ordinary callers need not provide runtime instance UUIDs.

After selection, the client verifies `/v2/session` against the descriptor and pins its `sessionId`, `instanceId`, and `generation` once. `SshRpcClient` performs this discovery lazily on its first operation and shares it across concurrent first operations. Later `session()` calls query and revalidate the pinned endpoint for current state; they do not rediscover or rebind. A new client may rediscover the same session after listener restart and pin the new runtime identity, but an uncertain request remains attached to the old instance/generation and must not be replayed or substituted.

## Requests and structured results

`POST /v2/requests` (HTTP 202):

```json
{
  "instanceId": "SERVER_UUID",
  "generation": 123,
  "requestId": "job_001",
  "message": "Use lookup_item for item 42. Create a short report file, register it, and submit the result.",
  "instructions": "Keep the report concise; this context applies only to this request.",
  "responseMode": "structured",
  "resultSchema": {
    "type": "object",
    "properties": { "summary": { "type": "string" }, "artifactId": { "type": "string" } },
    "required": ["summary", "artifactId"],
    "additionalProperties": false
  },
  "tools": [{
    "name": "lookup_item",
    "description": "Read the caller's item by numeric ID.",
    "inputSchema": { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"], "additionalProperties": false },
    "resultSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"], "additionalProperties": false }
  }],
  "timeoutMs": 7200000,
  "queueTimeoutMs": 7200000,
  "toolTimeoutMs": 60000
}
```

`responseMode` is `native` (default) or `structured`. Native mode needs no `rpc_result` and forbids `resultSchema`; it returns unmodified native host messages/events for ordinary chat clients, including thinking and tool calls/results. Structured mode requires `resultSchema` and exposes `rpc_result`; the caller should request its use in this request's prompt. No heuristic chooses or changes modes. `tools` defaults to `[]` (maximum 16). Names match `[A-Za-z][A-Za-z0-9_]{0,63}` and cannot duplicate a host tool or use the reserved `rpc_` prefix. Tool input schemas must describe objects. `timeoutMs` is the execution budget: default 7200000, range 1000..86400000, starting when the request becomes `running`, not at acceptance. `queueTimeoutMs` independently bounds waiting before execution: default 7200000, range 1000..86400000, starting at acceptance. `toolTimeoutMs` defaults to 60000, range 1000..300000, capped by the execution deadline. Messages are nonblank and at most 48 KiB; the complete request body is at most 64 KiB. There are at most 64 unfinished requests and 256 retained request IDs per generation; IDs are never silently evicted.

`instructions` is an optional string, normalized to `""` when omitted. Empty and whitespace-only strings are allowed; supplied text is preserved without trimming. Both `message` and `instructions` are independently limited to 48 KiB of UTF-8, and the complete request still has the 64 KiB body limit. A non-string or oversized `instructions` value is `invalid_request`. These instructions are subordinate user context for this request only, not persistent conversation policy or visible transcript content. CLI `submit --request-file` and SDK `submit()`/`run()` accept the same field.

A request record is:

```json
{
  "instanceId": "SERVER_UUID", "generation": 123, "sessionId": "OMP_SESSION_ID", "requestId": "job_001",
  "responseMode": "structured", "state": "queued", "createdAt": 1000, "updatedAt": 1000,
  "queueDeadlineAt": 3601000, "deadlineAt": 3601000
}
```

Running records add `startedAt`; terminal records add `finishedAt`. Only `completed` records have `result`: in structured mode this is exactly the accepted JSON value; in native mode it is the ordered array of native messages from this request's conversation turn, without extracting text, dropping thinking/tool data, or interpreting embedded JSON. Native result size is limited to 4 MiB; exceeding it fails explicitly instead of truncating. Structured results are limited to 256 KiB. Failed/interrupted/cancelled records have `error`. Request payload (including `instructions`), internal AbortControllers, schemas, credentials, and prior conversation history are not echoed in records.

`queueDeadlineAt` records the acceptance-time queue cutoff and remains available after dispatch. While queued, `deadlineAt` equals `queueDeadlineAt`. Starting execution sets `startedAt` and replaces `deadlineAt` with `startedAt + timeoutMs` exactly once; polling, duplicate submission and lease renewal never extend it. Queue expiration is `failed / queue_timeout` and never dispatches the task; execution expiration is `failed / request_timeout`. This is an additive v2 request-field change: existing callers need not set `queueTimeoutMs` to receive the corrected default. Previously expired requests remain terminal and are not automatically replayed. A bounded queue is not a durable scheduler for “after approval/acceptance” business events; the consumer must own such deferred tasks.

State transitions:

```text
queued -> running -> completed
queued/running -> failed | interrupted | cancelled
terminal -> immutable
```

`GET /v2/requests/:requestId?instanceId=...&generation=...` returns the record. Resubmitting the same normalized request with the same ID returns its existing record; different content, instructions, schemas, tools, or deadlines gives 409 `request_conflict`. Property order is irrelevant; explicit defaults and omitted defaults are equivalent, including omitted `instructions` and `instructions: ""`. Instruction whitespace remains significant.

In structured mode, the active request temporarily exposes native tool `rpc_result({result})` in the selected conversation. Validation atomically commits the result to its bound request and ends the RPC association, not OMP's native turn; its tool result remains in history and OMP continues normally. Equal duplicate submissions acknowledge the same result; differing duplicates give `result_conflict`. Unresolved intermediate caller tools give `tools_pending`. Terminal/cancelled identities reject late writes. Plain prose, thinking, progress and textual tool-call imitations are never parsed as results. A normally completed structured turn without a result gives `result_missing`; native abort instead gives `interrupted`. Schema errors remain correctable while the request runs. Native mode completes on normal host turn completion without a result tool.

`POST /v2/requests/:requestId/cancel` with `{instanceId,generation}` returns the current request. Repeated cancellation is idempotent; an already terminal record is returned unchanged. No result is fabricated for uncertain work.

## Caller-executed native tools

Each declared tool is temporarily exposed as a real native tool in the selected conversation under its declared name, with its description and input schema. Its execution validates arguments, creates a server-owned `toolCallId`, then awaits the caller result without blocking HTTP polling or native CLI scheduling. These are native tool calls/results, not an agent rollout, shell command, or Agent-authored HTTP request. Calls are intermediate operations, never final results. At most 64 tool calls are created per request. Tool arguments and successful caller results are bounded JSON (64 KiB and 256 KiB respectively).

`nativeToolCallId` preserves the host tool-execution ID for association with unmodified native events. The server-generated `toolCallId` remains the callback API key; neither identity is accepted from model tool arguments.

`GET /v2/requests/:requestId/tool-calls?instanceId=...&generation=...` returns `{toolCalls:[...]}`. `GET` on the same path followed by `/:toolCallId` returns one record:

```json
{
  "instanceId": "SERVER_UUID", "generation": 123, "sessionId": "OMP_SESSION_ID", "requestId": "job_001",
  "toolCallId": "CALL_UUID", "nativeToolCallId": "HOST_CALL_ID", "name": "lookup_item", "arguments": { "id": 42 },
  "state": "pending", "createdAt": 2000, "updatedAt": 2000, "deadlineAt": 62000,
  "attempt": 0
}
```

`POST .../tool-calls/:toolCallId/claim`:

```json
{ "instanceId": "SERVER_UUID", "generation": 123, "workerId": "worker_1", "claimId": "claim_1", "leaseMs": 30000 }
```

Returns HTTP 200 tool record with `state: claimed`, incremented `attempt`, `workerId`, `claimId`, server-generated `leaseId`, and `leaseExpiresAt`. Lease duration defaults to 30000, range 1000..60000, capped by the absolute call deadline. The same live worker/claim retry returns the same lease. A competing claim returns 409 `tool_claimed`. Expired leases return the call to pending; re-claim requires a new `claimId`. An expired claim cannot be revived by retrying it. No automatic worker execution replay occurs.

`POST .../tool-calls/:toolCallId/result`:

```json
{
  "instanceId": "SERVER_UUID", "generation": 123, "leaseId": "LEASE_UUID",
  "outcome": { "status": "completed", "result": { "title": "Example" } }
}
```

Failure/cancellation outcomes are `{status:"failed"|"cancelled",error:{code,message}}`. Success is validated against that tool's result schema; invalid data returns HTTP 422 `schema_validation` and leaves the lease active for correction. Accepted outcomes return the terminal tool record and resolve the Agent's pending native call (failures/cancellation become tool errors, not final request results). Exact retries with the accepted lease and outcome are idempotent; a different outcome gives 409 `tool_result_conflict`. A wrong/expired lease gives 409 `lease_mismatch`/`lease_expired`; cancellation/timeouts forbid late results.

Tool states:

```text
pending -> claimed -> completed | failed | cancelled
claimed -> pending (lease expired, before absolute deadline)
pending/claimed -> timed_out | cancelled
```

A timeout returns a tool error to the Agent; the absolute request deadline separately fails the request with `request_timeout`. Request termination cancels unresolved calls immediately and unblocks waiters. Querying original records after a network timeout is always preferred to re-execution. For external side effects, callers must deduplicate by toolCallId in their own durable execution ledger; leases cannot provide exactly-once external execution after a worker crash.

A consumer must poll tool calls while awaiting a final request. SDK `run` pumps tool calls and request state together; it must not first await completion before executing callbacks. A worker may renew its lease before expiry by repeating claim with the same workerId/claimId and `renew:true`; ordinary claim retries do not extend a lease. Renewal cannot extend the absolute call deadline.

## Artifact registration and retrieval

Native `rpc_artifact({path,name?,mediaType})` registers a regular file already created by the Agent inside the request working directory. The server validates containment/ownership-independent file safety, rejects symlink escapes and non-regular files, and copies an immutable snapshot into a private per-instance store. It returns:

Secure source traversal currently requires Linux with a verified `/proc/self/fd` facility. Each directory component is opened relative to a pinned directory descriptor with no-follow/nonblocking flags, rather than trusting a pathname checked before open. On other platforms or when this facility is unavailable, `capabilities.artifacts` is false and `rpc_artifact` is not exposed; registration fails `host_unsupported` without weakening file safety. Native and structured chat remain available. Clients requiring files must check this capability before submitting work.

```json
{
  "artifactId": "ARTIFACT_UUID", "name": "report.txt", "mediaType": "text/plain",
  "size": 123, "sha256": "HEX_DIGEST", "createdAt": 3000, "expiresAt": 1803000
}
```

Registration is request-bound; no model-supplied request identity is accepted. The same native tool-call ID and same registration retry returns the same artifact; conflicting reuse fails. Names must be single safe filenames; media types must be valid non-parameterized types. No source path is exposed. Limits: 20 MiB/file, 16 files/request, 64 MiB/request, 256 MiB/instance. Expiry is 30 minutes from registration, including running time.

The plugin runtime directory (including TLS keys, tokens and snapshot storage) is never a permitted registration source, even if it lies under the working directory. Ownership means association with the bound request, not separate per-client authentication: any caller authorized by the existing transport can access that request's artifacts. Anonymous HTTP provides no caller identity or per-user isolation; artifact/request IDs are not substitute credentials.

`GET /v2/requests/:requestId/artifacts?instanceId=...&generation=...` returns `{artifacts:[metadata...]}`. `GET .../artifacts/:artifactId?instanceId=...&generation=...` downloads the immutable bytes with Content-Type, Content-Length, Content-Disposition attachment, Cache-Control no-store, and X-Content-Type-Options nosniff. It is a repeatable, non-consuming claim until expiry. Wrong ownership returns 404; expired/deleted artifacts return 410 `artifact_expired`. There is no arbitrary-path download, base64 result embedding, range/resume protocol, or implicit filename-to-path resolution.

Artifacts remain available after terminal request completion until expiry, but never across instance shutdown/generation rotation. Periodic cleanup removes expired snapshots; clean shutdown removes this instance's files. Startup removes only sufficiently old expired stores, not another live instance's files. A crash can lose memory records and leaves files inaccessible; cleanup must bound abandoned disk usage.

## Events and recovery

`GET /v2/requests/:requestId/events?instanceId=...&generation=...&after=0` returns:

```json
{
  "events": [{ "sequence": 1, "at": 1000, "type": "request.state", "data": { "state": "queued" } }],
  "nextSequence": 1
}
```

Sequences increase within a request. Types: `request.state` with `{state,error?}`, `tool.state` with `{toolCallId,state}`, and `artifact.registered` with `{artifactId}`. Native mode additionally emits `native` events whose `data` is the original JSON-serializable host event, including native text/thinking deltas, tool calls, and tool results; no content extraction, filtering or rewriting is applied. Native payload shapes remain host-version-dependent, and clients must handle unknown event types. These payloads are model/tool output, not transport credentials or parent-session history. Keep at most the latest 256 events and 4 MiB per request; oversized individual payloads fail explicitly. A cursor older than retained history returns 410 `event_history_expired` with the latest cursor. Snapshot queries recover terminal state, but cannot recreate evicted deltas. Consumers needing a complete live transcript must poll promptly and persist their own event history. Events are observations, not execution acknowledgements.

### Persistent operations evidence

The host also maintains out-of-band operations JSONL at `<rootDir>/logs/operations-<pid>.jsonl`. This is not a protocol event stream and is never returned over HTTP. Each process owns a non-blocking file family that survives process exit, rotates at 10 MiB, and retains five backups. Cleanup at initialization and rotation retains all live families plus the eight newest retired PID families and never prunes a live process. Directories are 0700 and files are 0600. Sink failure cannot change request scheduling or HTTP/CLI output; stderr receives the unchanged allowlisted record and a separate sanitized `logging.write_failed` record.

Records use UTC `timestamp`, `component`, `pid`, and dot-delimited `event`, with bounded allowlisted identity/state metadata. They cover admission, terminal reasons, caller tools, native tool outcomes, result/artifact registration, HTTP failure categories, listener lifecycle and native host events. `host.event.triggered` alone does not mean replacement; `host.listener.preserved` confirms reuse after same-session history navigation. Actual listener stop/start records identify real replacement. Messages, instructions, prompts, histories, tool payloads, artifact contents/paths, credentials, raw URLs/query strings and arbitrary exception text are excluded. Logs cannot reconstruct or authorize business replay.

## Error codes

400: `invalid_request`, `invalid_request_id`, `invalid_identity`, `invalid_message`, `invalid_schema`, `invalid_tool`, `invalid_query`, `invalid_json`, `invalid_outcome`, `invalid_claim`, `invalid_artifact`.

404: `not_found`, `request_not_found`, `tool_call_not_found`, `artifact_not_found`.

409: `instance_mismatch`, `generation_mismatch`, `request_conflict`, `request_terminal`, `result_conflict`, `tools_pending`, `tool_claimed`, `lease_mismatch`, `lease_expired`, `tool_result_conflict`, `artifact_conflict`, `validation_aborted`.

410: `protocol_upgraded`, `artifact_expired`, `event_history_expired`.

413: `body_too_large`, `value_too_large`, `artifact_too_large`.

422: `schema_validation` (with validation details).

429: `queue_full`, `request_capacity`, `tool_capacity`, `artifact_capacity`, `validation_capacity`.

501: `host_unsupported`. 503: `session_closed`, `host_drain_timeout`, `validation_timeout`, `validation_worker_failed`. Existing transport errors retain 401 `unauthorized`, 403 `origin_not_allowed`, 405 `method_not_allowed`, 408 timeout, 415 content-type rejection, and 500 `internal_error`.

Terminal request reasons additionally include `result_missing`, `queue_timeout`, `request_timeout`, `native_user_message`, `history_changed`, `host_cancelled`, `session_changed`, `endpoint_closed`, `client_cancelled`, `host_failed`, and `value_too_large`. Native host cancellation is not a missing structured result. Malformed/unserializable executor output is a host failure, not caller validation failure. Terminal tool reasons include `tool_timeout` and `request_terminated`. Clients branch on codes/states, never English wording.

SSH `relay --instance` remains a hidden internal selector, not a public session-selection input. Discovery client errors are `session_not_found` (missing/stale selected descriptor), `session_ambiguous` (more than one live descriptor matches a selected session), `session_selection_required` (more than one live session and no selection), and `session_mismatch` (the verified endpoint reports a different session). Once pinned, `instance_not_found` means that exact relay descriptor vanished; `instance_mismatch` and `generation_mismatch` preserve exact identity failures, including rejection before an HTTP call. None triggers rediscovery, rebinding, or request replay. Other sanitized SSH/remote CLI setup failures may report `relay_failed`; these are not acceptance acknowledgements and must not trigger blind request replay.
