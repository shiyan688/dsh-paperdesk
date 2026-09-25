[English](./README.en.md) · 中文

# dsh-paperdesk

> A **paper workbench** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
> arXiv search → local library (metadata / PDF / full text) → three-layer reading notes.
> Host half and browser half live in one package, with **no build step** — the files in `lib/` are the files that run.

---

## What it is for

Reading papers is three jobs, not one: **collect** it, **read** it, **remember** it.
Most tools stop after the first. dsh-paperdesk connects all three, and makes the third one structural:

| Layer | Question it answers | Why it is its own layer |
| --- | --- | --- |
| **L1 Overview** | What does this paper claim? One-sentence contribution. | Filters out what is not worth reading further. |
| **L2 Understanding** | Why should I believe it? Method, key design, which table carries the claim. | Separates "read the abstract" from "understood the work". |
| **L3 Critique** | Do the assumptions hold? What is suspicious? What can I reuse? | **Most papers that were "read" but not absorbed are missing exactly this layer.** |

The GUI and the model tools read and write the same library, so you can click, or just say *"deep-read 1706.03762"*.

---

## Install

```sh
dsh plugin --profile web add dsh-paperdesk
```

Restart the profile (`dsh web`) afterwards; a **📚 论文** entry appears at the sidebar foot.

### ⚠️ One check you must not skip (otherwise the plugin silently does not load)

`dsh plugin add` installs the package and then **reconciles** `dsh.profile.bundles` against the
installed state: a dependency joins the layer stack only if it resolves *and* its `package.json`
declares `dsh.bundle.patch`. When that fails, the package lands as a **plain dependency**: no error, no load, nothing
visible in the UI.

> Observed: this failure happened on a **freshly initialized** profile (package written to
> `dependencies`, `dsh.profile.bundles` unchanged), while the very same `file:` install reconciled
> correctly on a profile already in use. So it is not specific to `file:` specs, but the
> "new profile + first install" combination is worth a second look.

So verify once:

```sh
node node_modules/dsh-paperdesk/scripts/check-dsh-compat.mjs --profile web
```

It reports both "dependency registered" and "present in `dsh.profile.bundles`". If it says the
package is missing from the bundle list, append the name to the array in
`$DSH_HOME/profiles/web/package.json`:

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-paperdesk"] } }
```

Then restart the profile. The startup log should contain:

```
[paperdesk] 0.1.0 ready · library <root> · extractor <extractor> · 7 tools · api mounted
```

After that, the authoritative health check is `GET http://127.0.0.1:<port>/paperdesk/api/health`
(with the browser's token).

The package ships its own `cordis.patch.yml`, which is applied as a patch layer when the bundle is registered:

```yaml
- insert:
    - id: dsh-paperdesk
      name: 'dsh-paperdesk'
      config:
        root: ''          # library root; empty = <dsh process cwd>/.dsh-paperdesk
        pdfCommand: ''    # custom PDF extractor CLI (pdftotext compatible); empty = auto-detect
        pythonCommand: '' # custom python interpreter; empty = auto-detect python/python3/py
```

Remove it with `dsh plugin --profile web remove dsh-paperdesk`.

---

## Use it

**GUI** — three tabs: library (filter by status / title / author / tag, edit the three note layers on the right),
arXiv search (natural language or `ti:"world model" AND cat:cs.LG`), and PDF import (scan a directory or paste a path).

**Model tools** — seven of them, backed by the same library:

`paper_search` · `paper_add` · `paper_list` · `paper_read` · `paper_note` · `paper_pdf` · `paper_import`

---

## Where data lives

```
<root>/
  state/index.json       metadata + status + tags + note text (single source of truth)
  pdf/<id>.pdf           downloaded or imported PDFs
  text/<id>.txt          extracted full text
  notes/<id>.md          human-readable three-layer notes (diffable, git-friendly)
  .tools/extract_pdf.py  generated python extractor script (safe to delete)
```

For arXiv papers `<id>` is the version-less identifier (`1706.03762`), so collecting v7 and later updating to v8
does not create two records. All stored paths are relative, so `<root>` can be moved or copied.

---

## Requirements

- **Node ≥ 20** (uses global `fetch`).
- **Zero runtime third-party dependencies.** The only external import is `@deepseek-ai/schemastery`, a host-provided peer used to declare the row config schema.
- **Full-text extraction needs one external tool**, auto-detected in this order:
  1. `pdfCommand` from config (any pdftotext-compatible CLI)
  2. `python` / `python3` / `py` with **PyMuPDF** or **pypdf**
  3. `pdftotext` on `PATH` (poppler or MiKTeX)

  Without any of them everything still works except *extract full text*, and `/paperdesk/api/health` says why.

---

## Compatibility

Three rules, detailed in **[COMPATIBILITY.md](./COMPATIBILITY.md)**:

1. **Soft version gate** — the declared range only produces a warning; it never blocks startup.
2. **Capability probing first** — every required service is `typeof`-checked; whatever is missing degrades, and the result is reported at `/paperdesk/api/health`.
3. **Stick to the stable surface** — `ctx.tools.register`, `ctx.webServer.register`, `ctx.get`. No dynamic-plugin-only `harness.*`, no internal `@deepseek-ai/dsh-*` symbols.

`peerDependencies` use `*` on purpose: the coupling point is a **service contract**, not a version number,
and a pinned range would only produce false alarms on combinations that work.

---

## Security

- The browser half talks to the host only through `/paperdesk/api/*`, which verifies **every** request comes from
  loopback (`127.0.0.1` / `::1` / IPv4-mapped). Binding to loopback is not enough: any page in the browser can send requests to localhost.
- Import reads an **absolute path you explicitly provide** — that is the feature, not a hole. Relative paths are
  rejected because their meaning depends on the host process cwd.
- Every subprocess uses `spawn(command, args)`, never a shell — paths with spaces, CJK characters or quotes cannot become command injection.
- Downloaded PDFs are checked for the `%PDF-` magic number and size-capped, so an HTML error page is never stored as an unopenable "paper".

---

## Development

```sh
npm test          # node --test test/   (no test framework dependency)
npm run compat    # verify this machine's DSH satisfies every service/interface the plugin uses
```

Architecture — please keep the boundaries:

```
lib/index.js        wiring: resolve services → build service → register tools + routes
lib/core/service.js business logic: no DSH dependency, injectable side effects, directly unit-testable
lib/core/*.js       pure logic: text / store / arxiv / notes / pdf / config / compat / api / tools
lib/client.js       browser half: self-registers with __ModuleLoader__, inline styles, talks only to the loopback API
```

`test/static-guard.test.mjs` enforces the invariants (core must not import `@deepseek-ai/`, host must not touch browser
globals, `files` must cover runtime files, patch config keys must exist in the schema, version strings must agree).
Update `CHANGELOG.md` for behaviour changes and `COMPATIBILITY.md` for compatibility-surface changes.

---

## Known limitations

- The panel is an **overlay**, not the centre panel — deliberately, to use the slot pair (`sidebar.footer.action` +
  `shell.overlay`) that community plugins have already proven across versions.
- **"Open containing folder" only makes sense when host and browser share a machine.**
- **No deduplication**: an arXiv preprint and its conference version are two records; tags are your tool.
- **Extraction quality depends on the PDF** — two-column layouts, scans and formula-dense pages produce noise.

---

## License

[MIT](./LICENSE). Issues and PRs welcome — when reporting a bug, please include the output of `/paperdesk/api/health`.
