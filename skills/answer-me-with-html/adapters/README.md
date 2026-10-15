# DocReader credential adapters

This fork uploads every rendered page to a DocReader server. The skill core
knows the DocReader API but **never** knows where the credential lives — that is
each runtime's job, through an *adapter*. The same skill therefore installs
unchanged into Muse, Gemini, Grok Bot, Claude Code, or any other agent
container; only the adapter differs per environment.

## The two ways to provide a credential

1. **Environment key (zero setup).** Set `DOC_READER_API_KEY` and the core sends
   it as the `X-API-Key` header. This is enough for most containers.
2. **External adapter.** An executable the core calls to obtain the auth
   headers. Use it when the credential lives in a platform vault and must not
   be copied into an env var (Muse is the example below).

With neither configured, the upload is skipped and the render still succeeds.

## Adapter discovery

The core looks for an adapter in this order:

1. `AM_DOCREADER_ADAPTER` — path to any executable.
2. `$AM_HOME/adapters/docreader` — the conventional install location
   (`AM_HOME` defaults to `~/.answer-me-with-html`).

## Adapter protocol

The adapter is an executable in any language (a shebang is enough). The core:

- runs it with **no arguments**, with a 15-second timeout;
- writes one JSON object to its stdin: `{"base": "https://agent101.uk", "host": "agent101.uk"}`;
- expects exactly one JSON object on stdout, in one of two shapes:

```json
{"headers": {"X-API-Key": "…"}}     ← authenticate the upload with these headers
{"skip": "reason for this environment"}   ← skip the upload, render still succeeds
```

A non-zero exit, invalid JSON, or an empty `headers` object is a hard adapter
failure: the render still succeeds and the failure is printed on the
`✗ DocReader:` line. An adapter must never print anything else to stdout
(log to stderr), and must not read the document — it only answers
"which headers authenticate me here?". The core performs the HTTP upload
itself, so every runtime gets identical upload behavior.

## Per-runtime setup

### Muse

`adapters/muse.py` (shipped here) returns the `custom.agent101` connector
surrogate from Muse's authd; Sentinel exchanges it for the real key at
network egress. Install it at the conventional location:

```sh
mkdir -p ~/.answer-me-with-html/adapters
cp adapters/muse.py ~/.answer-me-with-html/adapters/docreader
chmod +x ~/.answer-me-with-html/adapters/docreader
```

Requires the `custom.agent101` connector to be connected in that Muse
environment. Outside Muse it prints `{"skip": …}` and uploads are skipped.

### Any other runtime (Gemini, Grok Bot, plain containers)

Either export `DOC_READER_API_KEY`, or point `AM_DOCREADER_ADAPTER` at a small
script that fetches the key from your secret store. A minimal example:

```sh
#!/bin/sh
# ~/.answer-me-with-html/adapters/docreader
key=$(cat /run/secrets/doc_reader_api_key)
printf '{"headers": {"X-API-Key": "%s"}}' "$key"
```
