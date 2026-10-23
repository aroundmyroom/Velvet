# Running a security scan

How the v0.7.0 audit was done, so it can be repeated.

## 1. Install opengrep

```bash
mkdir -p /opt/opengrep && cd /opt/opengrep
gh release download --repo opengrep/opengrep --pattern 'opengrep_manylinux_x86' --clobber
chmod +x opengrep_manylinux_x86 && ln -sfn /opt/opengrep/opengrep_manylinux_x86 /usr/local/bin/opengrep
opengrep --version
```

## 2. Get the rules

```bash
mkdir -p /tmp/og/rules && cd /tmp/og
gh api repos/opengrep/opengrep-rules/tarball/main > r.tgz && tar -xzf r.tgz -C rules --strip-components=1
mkdir -p cfg && i=0
find rules/javascript rules/typescript rules/generic rules/dockerfile rules/yaml rules/bash rules/html rules/json \
  -name '*.yaml' ! -name '*.test.yaml' ! -path '*/test*' | while read f; do i=$((i+1)); cp "$f" "cfg/r$i.yaml"; done
```

## 3. Scan

```bash
cd /home/velvet
opengrep scan --config /tmp/og/cfg --json --output /tmp/og/results.json \
  --exclude node_modules --exclude save --exclude image-cache --exclude waveform-cache \
  --exclude bin --exclude dist --exclude .sonostest --exclude '*.min.js' --exclude releases --exclude docs \
  -j 4 --timeout 120 --max-target-bytes 0 .
```

`--max-target-bytes 0` matters: without it `webapp/app.js` and `webapp/admin/index.js` (both over 1 MB) are skipped silently. Ignore `webapp/assets/js/lib/` in the results; it is vendored third-party code.

## 4. Triage

Expect about 2,000 findings. Most are not issues:

| Rule | Verdict |
|---|---|
| `html-in-template-string`, `insecure-innerhtml`, `insecure-document-method`, `raw-html-*` | Pattern matches on every HTML template; they cannot see `esc()`/`xmlEsc()`. Check the interpolations, not the sink. |
| `missing-template-string-indicator` | All false positives (nested template literals). Proven with an AST check: no plain string literal contains `${…}`. |
| `i18next-key-format`, `no-replaceall`, `javascript-confirm`, `unsafe-formatstring`, `lazy-load-module` | Style rules, not vulnerabilities. |
| `md5-used-as-password` (scrobbler) | Last.fm's protocol requires MD5. |
| `generic-api-key` (de.json) | German words ("Zugriff"), not keys. |
| `missing-user` (Dockerfile) | The entrypoint drops to the `node` user with `gosu`. |

For the HTML sinks, walk every `${…}` inside HTML-building template literals with an AST (espree is already in `node_modules`), treat `esc()`, `t()`, numbers, `artUrl()` and nested templates as safe, follow local variables to their assignments, and review what is left by tracing each value to its source. Also flag interpolations inside `on*=` handlers and single-quoted or unquoted attributes.
