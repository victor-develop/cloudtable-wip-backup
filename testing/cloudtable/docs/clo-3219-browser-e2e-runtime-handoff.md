# CLO-3219 Browser E2E Runtime Handoff

Date: 2026-08-04

## Runtime Repair

- Installed `opencode-ai@1.18.13`, exposing `opencode` at `/Users/victorzhou/.local/share/mise/installs/node/22.22.3/bin/opencode`.
- Confirmed the Paperclip service process PATH includes `/Users/victorzhou/.local/share/mise/installs/node/22.22.3/bin`, so new `opencode_local` agent runs can resolve the command.
- Confirmed `opencode --version` returns `1.18.13`.
- Confirmed `opencode run --help` supports the adapter-required `run --format json` invocation.
- Confirmed `opencode models` can return model IDs when XDG data/state/cache paths are writable. In the restricted Codex shell, use:

```bash
XDG_DATA_HOME="$PAPERCLIP_SCRATCH_DIR/xdg-data" \
XDG_STATE_HOME="$PAPERCLIP_SCRATCH_DIR/xdg-state" \
XDG_CACHE_HOME="$PAPERCLIP_SCRATCH_DIR/xdg-cache" \
opencode models
```

The first model IDs returned included:

```text
opencode/big-pickle
opencode/deepseek-v4-flash-free
opencode/laguna-s-2.1-free
opencode/ling-3.0-flash-free
opencode/mimo-v2.5-free
opencode/nemotron-3-ultra-free
opencode/north-mini-code-free
```

## Browser E2E Path

The local Worker can be started with:

```bash
npm run dev -- --port 8788 --local --persist-to "$PAPERCLIP_SCRATCH_DIR/wrangler-state"
```

In this sandbox, Wrangler loopback binding requires elevated execution permissions. Once running, real browser screenshots were captured with Playwright Chromium:

```bash
npx playwright screenshot --browser chromium --viewport-size=1440,1000 --wait-for-timeout=2500 \
  http://127.0.0.1:8788/studio testing/cloudtable/artifacts/clo-3219/cloudtable-studio-desktop.png

npx playwright screenshot --browser chromium --viewport-size=390,844 \
  --user-agent='Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' \
  --wait-for-timeout=2500 \
  http://127.0.0.1:8788/studio testing/cloudtable/artifacts/clo-3219/cloudtable-studio-mobile.png
```

Artifacts:

- `testing/cloudtable/artifacts/clo-3219/cloudtable-studio-desktop.png`
- `testing/cloudtable/artifacts/clo-3219/cloudtable-studio-mobile.png`

## Observed Studio State

- `GET /studio` returned `200 OK`.
- `HEAD /studio` returned `404 Not Found`; browser navigation uses `GET` and succeeded.
- The unauthenticated Studio shell rendered correctly in both desktop and mobile viewports.
- The shell made `/v1/auth/session` and received `401 Unauthorized`, which is expected before login.

## Handoff

CLO-3218 can return to Quality Architect for the required desktop/mobile browser verification. Quality Architect should use the repaired `opencode_local` runtime and the Playwright Chromium path above for browser evidence.
