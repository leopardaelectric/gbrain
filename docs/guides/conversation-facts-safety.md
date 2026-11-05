# Conversation facts: preview and retry safety

`extract-conversation-facts --dry-run` previews deterministic segmentation. It does not estimate fact counts. It does not call the fact extractor, the parser's optional AI fallback, or an injected extractor. It does not acquire a writer lock or write facts, checkpoints, receipts, or rollups.

```sh
gbrain extract-conversation-facts --source-id example-source \
  --slug conversations/example --dry-run
```

## Paid execution

Remove `--dry-run` only after approval for the selected source, page, and cost cap. Use one worker for a tightly bounded run. Do not use `--background` when you need the current checkout's code: an existing worker can load a different checkout.

```sh
bun run /path/to/reviewed-checkout/src/cli.ts extract-conversation-facts \
  --source-id example-source --slug conversations/example \
  --workers 1 --max-cost-usd 0.50
```

This runs the reviewed source without linking or installing it globally. It does not update another worker's code.

Each segment permits at most two chat calls: one initial call and one output-repair retry. The retry uses a 250 ms delay. Truncated output can receive twice the initial output-token limit. Malformed output receives a JSON-only reminder. These retry classes share one retry allowance. Each call must pass the same budget reservation. Extraction disables the chat SDK's internal retries so they cannot multiply paid attempts.

Provider errors, including ambiguous timeouts and rate-limit errors, are not replayed automatically by this extractor. A caller cancellation stops the output retry. The gateway's request deadline remains active; `GBRAIN_AI_CHAT_TIMEOUT_MS` can override its default 300000 ms for one process. A timeout does not prove that the provider incurred no charge.

Successful facts can also require embedding calls. The two-call limit applies to chat extraction, not to every AI operation in a run. Budget accounting still applies to embedding calls.

An unfinished page remains retryable. Review its error before a new paid invocation. Do not use `--since` to repair a failed whole-page replay: replay first removes unfinished facts, so a time filter can omit earlier segments. `--segment-limit` is an explicit partial run, not proof of page completion.

## Entity stub titles

The markdown-first fact writer uses the shared YAML serializer when it creates an entity page. Numeric titles and YAML keywords remain strings through a file import. This prevents new malformed titles; it does not rewrite existing source files.
