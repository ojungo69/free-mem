# oboete contract probes

Verification-gate (R13) runs under the isolated dogfood user. Statuses: pass / fail / blocked / skipped.

## 2026-09-03 run 2026-09-03T10-22-04-666Z

| tool | version |
|---|---|
| date | 2026-09-03T10:22:04.667Z |
| claude | 2.1.259 (Claude Code) |
| codex | codex-cli 0.153.0 |
| grok | grok 1.0.17 (a549186d9d39) [alpha] |
| pi | 0.84.4 |
| node | v24.20.0 |

| id | R13 row | agent | status |
|---|---|---|---|
| claude-payload-shapes | Native tool payload shapes for read/write/edit/bash on all four agents | claude | pass |
| claude-oversized-stdin | Hook runner behaviour when the hook exits with unread stdin above 1 MB | claude | pass |
| codex-payload-shapes | Native tool payload shapes for read/write/edit/bash on all four agents | codex | pass |
| codex-oversized-stdin | Hook runner behaviour when the hook exits with unread stdin above 1 MB | codex | pass |
| grok-payload-shapes | Native tool payload shapes for read/write/edit/bash on all four agents | grok | pass |
| grok-oversized-stdin | Hook runner behaviour when the hook exits with unread stdin above 1 MB | grok | pass |
| pi-payload-shapes | Native tool payload shapes for read/write/edit/bash on all four agents | pi | pass |
| pi-oversized-stdin | Hook runner behaviour when the hook exits with unread stdin above 1 MB | pi | skipped |
| agent-cli-json | `agent-cli` preset: headless JSON output of `claude -p`, `codex exec`, `grok -p` for a summarization prompt | providers | pass |
| provider-nim | NIM / OpenRouter / Gemini / Anthropic transport, auth header, model id | providers | skipped |
| provider-openrouter | NIM / OpenRouter / Gemini / Anthropic transport, auth header, model id | providers | skipped |
| provider-gemini | NIM / OpenRouter / Gemini / Anthropic transport, auth header, model id | providers | skipped |
| provider-anthropic | NIM / OpenRouter / Gemini / Anthropic transport, auth header, model id | providers | skipped |
| provider-workers-ai | NIM / OpenRouter / Gemini / Anthropic transport, auth header, model id | providers | skipped |

- **claude-payload-shapes**: Read input=[file_path] output=[type,file] path=tool_input.file_path (absolute); echoed back at tool_response.file.filePath (camelCase) (match recon; out match recon); Write input=[file_path,content] output=[type,filePath,content,structuredPatch,originalFile,userModified] path=tool_input.file_path ; tool_response.filePath (match recon; out match recon); Edit input=[file_path,old_string,new_string,replace_all] output=[filePath,oldString,newString,originalFile,structuredPatch,userModified,replaceAll] path=tool_input.file_path ; tool_response.filePath (match recon; out match recon); Bash input=[command,description] output=[stdout,stderr,interrupted,isImage,noOutputExpected] path=tool_input.command ; tool_response has NO command echo — Pre/Post must be joined by tool_use_id (match recon; out match recon); exit=0 elapsed_s=14.2 session=b8f0a8f6-5c08-4543-a4ca-8fc7c007beca model=claude-opus-5[1m]
- **claude-oversized-stdin**: exit=0; DONE=true; Stop=true; SessionEnd=true; unread_handlers=1; read_PostToolUse=1 sizes=31438; hook_lines=none; elapsed_s=13.1
- **codex-payload-shapes**: bash-read input=[command] output=[(string)] path=tool_input.command — path is inside the shell command text; apply_patch-add input=[command] output=[(string)] path=tool_input.command *** Add File: <path>; apply_patch-update input=[command] output=[(string)] path=tool_input.command *** Update File: <path>; bash input=[command] output=[(string)] path=tool_input.command; exit=0 elapsed_s=28.6 session=01a066ca-abee-7091-bb4d-7f36c106d305 model=gpt-5.6-sol
- **codex-oversized-stdin**: exit=0; DONE=true; Stop=true; SessionEnd=true; unread_handlers=1; read_PostToolUse=1 sizes=1189; hook_lines=none; elapsed_s=9.7
- **grok-payload-shapes**: read_file input=[target_file] output=[type,FileContent] path=toolInput.target_file (relative); absolute at toolResult.FileContent.absolute_path (match recon; out match recon); write input=[file_path,content] output=[type,EditsApplied] path=toolInput.file_path (relative); absolute at toolResult.EditsApplied.absolute_path; toolResult.type is SearchReplace (match recon; out match recon); search_replace input=[file_path,old_string,new_string] output=[type,EditsApplied] path=toolInput.file_path (relative); absolute at toolResult.EditsApplied.absolute_path (match recon; out match recon); run_terminal_command input=[command,description] output=[type,output,output_for_prompt,exit_code,command,truncated,signal,timed_out,description,current_dir,output_file,total_bytes,was_bare_echo] path=toolInput.command; output is a byte array, output_for_prompt is the string (match recon; out match recon); exit=0 elapsed_s=10.7 session=01a066cb-3fb8-7473-8c38-9d659d74bf3d model=grok-4.6-build
- **grok-oversized-stdin**: exit=0; DONE=true; Stop=true; SessionEnd=true; unread_handlers=1; read_PostToolUse=1 sizes=164527; hook_lines=none; elapsed_s=6.7
- **pi-payload-shapes**: read input=[path] output=[(array)] path=input.path (match recon); write input=[path,content] output=[(array)] path=input.path (match recon); edit input=[path,edits] output=[(array),details] path=input.path (edits is [{oldText,newText}]) (match recon); bash input=[command] output=[(array)] path=input.command (match recon); exit=0 elapsed_s=21.4 session=01a066cb-82e1-778e-ba35-d29b422dd381 model=gpt-5.6-luna
- **pi-oversized-stdin**: Pi has no hook process; the equivalent is oboete's own capture child, probed after the child exists
- **agent-cli-json**: claude pass 6.21s text=result model=claude-opus-5[1m] ver=2.1.259 (Claude Code); codex pass 7.00s text=output-last-message model=none ver=codex-cli 0.153.0; grok pass 7.95s text=text model=grok-4.6-build ver=grok 1.0.17 (a549186d9d39) [alpha]; pi pass 5.74s text=turn_end text blocks model=gpt-5.6-luna ver=0.84.4
- **provider-nim**: dummy-key self-check: HTTP 410 (unexpected) 90ms; credential absent
- **provider-openrouter**: credential absent
- **provider-gemini**: credential absent
- **provider-anthropic**: credential absent
- **provider-workers-ai**: credential absent


## Findings 2026-09-03 (maintainer notes on the runs above)

Rows of research.md R13 closed or narrowed by today's runs; the evaluation against pass conditions is
recorded in docs/research/m1-amendments-2026-09.md (task T011).

- **Native tool payload shapes** (row 1): fixtures for 16 tool payloads are committed under
  `test/contracts/<agent>/`. Shapes that the adapters (T028) must handle: Claude Code `tool_input` is
  snake_case and `tool_response` camelCase with a different shape per tool (Read nests `file`, Edit has no
  `type`, Bash echoes no command); Codex has no read tool (reads arrive as Bash commands), writes and
  edits arrive as `apply_patch` whose path is only inside the patch text, and `tool_response` is a bare
  string; Grok Build `write` returns `toolResult.type = "SearchReplace"` (dispatch on `toolName`),
  `run_terminal_command.output` is a byte array (`output_for_prompt` is the string), and tool events carry
  no `promptId`; Pi's `tool_result` carries `input`, `content`, `isError` (and `details` for edit) and is
  the single subscription point.
- **Hook runner behaviour with unread stdin** (row "unread stdin above 1 MB"): Claude Code, Codex and
  Grok Build all completed the turn, ran the later hooks (Stop, SessionEnd) and surfaced no hook error
  when the PostToolUse handler exited 0 without reading. The runners also cap what a hook receives: after
  a 1.2 MB tool result the normally reading handler saw about 31 KB (Claude Code), 4.8 KB (Codex) and
  165–190 KB (Grok Build). So the 1 MB read bound of A7/A14 is never reached through a tool *result*;
  a large tool *input* (a Write with a huge `content`) was not probed.
- **Codex `[hooks.state] trusted_hash`**: the rule in docs/research/oboete-contracts-2026-09-02.md is
  incomplete. The preimage handler object must contain `"async": false`, and the group's `matcher` is part
  of the preimage when present (verified 12/12 hooks firing without `--dangerously-bypass-hook-trust`,
  and against 5 real hashes). `scripts/e2e/probe-lib/trusthash.mjs` is the corrected implementation and
  the installer (T049) must use the same rule.
- **`agent-cli` preset** (row "headless JSON output"): all four CLIs return the model text in a stable
  place (`claude -p --output-format json` → `result`; `codex exec --json --output-last-message <file>` →
  the file; `grok -p --output-format json` → `text`, but that field concatenates every assistant message,
  so the Stop hook's `lastAssistantMessage` is the clean source; `pi -p --mode json` → the `text` blocks of
  the last `turn_end` message, which can start with a `thinking` block). Codex's JSON stream carries no
  model id. Fence stripping was not exercised (no CLI returned fences today).
- **Model ids reported at runtime**: `claude-opus-5[1m]` (with a `claude-haiku-4-5` side call),
  `gpt-5.6-sol` (Codex), `grok-4.6-build`, `gpt-5.6-luna` (Pi via `openai-codex`). Their documented
  windows and the runtime-id → catalog-id rules are in docs/research/context-windows.md.
- **Provider presets** (rows "transport, auth header, model id" and "response_format"): not run; no key is
  present in `~/.oboete-credentials` (`OBOETE_<PRESET>_API_KEY`, A17). The probes skip with
  "credential absent" and re-run once keys exist.
- **Hermeticity**: every run left the isolated user's real configuration untouched (seven protected paths,
  sha256 or absence identical before and after).
