# THE V · Assistant & content analysis

A [Tampermonkey](https://www.tampermonkey.net/) userscript that connects the browser to an OpenAI-compatible LLM API (`/v1/chat/completions`).
A floating button opens a window with three tools: **Chat**, **Analyse** and **HTML**.

> Answers come from an LLM and can be wrong or inaccurate. Always check them before use.

## Installation

1. Install the [Tampermonkey extension](https://www.tampermonkey.net/) for your browser (Violentmonkey also works).
2. Add the script. Tampermonkey's guide: [How to install new scripts](https://www.tampermonkey.net/faq.php?q=Q102). In short: dashboard → **+** (new script) → paste the content of `assistant-llm.user.js` → save.
3. Replace the placeholders in the script header (see the [header reference](https://www.tampermonkey.net/documentation.php)):
   - `@connect`: the API host only (e.g. `my-server.example.com`). Without it, requests are blocked by the extension.
   - `@exclude`: remove it, or list the pages where the button must not appear.
4. Reload a page. A round **V** button appears.

## Global setup

1. Click the **V** button (or press `Alt+L`), then ⚙ **Settings**.
2. Fill in:
   - **API URL**: full URL, including `/v1`;
   - **Private key**;
   - **Model**: use the refresh button to list the models exposed by the server.
3. Click **Test connection**, then **Save**.
4. Go back to **Chat** and ask something.

With no URL or key configured, the script sends nothing and shows an error message.

## The three tools

**Chat**
- Streamed conversation. Tick "Include page content" so the model reads the current page.
- Quick actions: summarise the page, explain or translate the selection (`Alt+Shift+L` explains).
- Text attachments: 📎 button, `Ctrl+V` or drag and drop (txt, md, csv, json, code…). Images, PDFs and Office files are refused.
- Every message has a **Copy** button.

**Analyse** (large volumes)
- Source: whole page, selection or local files.
- Text is split into blocks, each block is summarised in parallel, then the notes are merged (map-reduce). No size limit on the source.
- Modes: structured summary, step-by-step guide, data extraction, risks and anomalies, free question.
- The result can be copied, downloaded, or sent back to Chat.

**HTML**
- Describe what you want (page, section, email, form) and the model writes the code.
- Preview / code tabs, adjustable preview width, copy button.
- The preview is sandboxed (iframe). Scripts only run there if "Allow scripts" is ticked.

## Export / import

- Conversation: `.json` (re-importable) or readable `.md`. Analysis and HTML: `.json`.
- Full backup in ⚙ Settings (conversation, analysis, HTML, settings).
- **The key and API URL are never exported or imported.**
- Imports are validated: a file from another source or a malformed one is rejected.
- Nothing is kept automatically between page reloads: export to keep your work.

## Useful settings

| Setting | Purpose |
|---|---|
| Block size | Size of one analysis block (characters). Lower it if the server returns a 400 error. |
| Parallelism | Simultaneous calls during analysis. Lower it if the server is overloaded. |
| Max attachments | Max size of files attached in Chat. |
| System prompt | Role and tone of the model, applied to Chat, Analyse and HTML. |

The window and button can be moved (drag the header or the button) and the window can be resized. Position and size are remembered; ⚙ lets you reset them.

## Troubleshooting

- **"Endpoint non configuré"**: API URL missing or incomplete in Settings.
- **Network error**: API unreachable (VPN, wrong host, model not loaded) or `@connect` not set correctly.
- **401**: invalid or expired key. **429**: quota reached.
- **400 / context limit**: too much text sent. Reduce attachments or use the Analyse tab.
- **Answer appears all at once**: some script managers don't expose the stream while receiving. Not blocking.

## Customising the script

- **Rename the tool**: `APP` block at the top of the file, plus `@name` in the header. Changing `@name` or `@namespace` makes Tampermonkey treat it as a new script, so saved settings start over.
- **Adapt to another use case**: `DEFAULTS.systemPrompt` (general tone), `MODES` (analysis instructions), `HTML_SYS` and `HTML_TYPES` (HTML generation).
- Search markers in the code: `plus tard` (to revisit), `sécu` (security points).

---

# Technical notes

## Architecture

Single file, no build step, no dependency. Main blocks, in file order:

| Block | Role |
|---|---|
| `APP` / `DEFAULTS` / `cfg` | Identity, default values, getters over `GM_getValue`. |
| LLM client | `request()` wraps `GM_xmlhttpRequest`. `chatStream()` parses SSE, with a JSON fallback. `chatOnce()` is non-streamed with one retry. |
| Extraction | Page text (`main`/`article`, noise removed), selection, local files via `FileReader`. |
| Analysis engine | `chunkText` (line-aware, CSV header repeated), `MODES`, parallel `pool`, hierarchical reduce, streamed final reduce. |
| UI | Shadow DOM (fab + panel), Pointer Events drag, position and size saved in GM storage. |
| Tabs | Chat, Analyse, HTML, Settings. |
| Export / import | JSON with an `app` marker and a `version`, strict validation on import. |

Calls go to `POST {baseUrl}/chat/completions` (streamed in Chat and for the final reduce) and `GET {baseUrl}/models`.

## Security model

What is in place:

- **Key handling**: stored in the script manager storage (`GM_setValue`), sent only as a `Bearer` header through `GM_xmlhttpRequest`. The settings field is `type="password"`. It is never written to exports and the script does not log it. It is loaded into that field when Settings opens (see the open shadow root point below).
- **No relative endpoint**: `request()` refuses any base URL that is not an absolute `http(s)://` URL. Otherwise the request would resolve against the visited page and the key would leave for that site.
- **Network scope**: `@connect` limits which hosts the manager lets the script call. It is the real barrier, so keep it to the API host only.
- **Model output is untrusted**: rendered with `textContent` only, never `innerHTML`. Only fenced code blocks get special treatment (copy and preview buttons).
- **HTML preview**: `<iframe sandbox="">` (no scripts, no forms, no same-origin). The "Allow scripts" box switches to `allow-scripts` only, never `allow-same-origin`, so the previewed code cannot reach the host page or the extension storage.
- **Imports**: size cap (20 MB), `app` and `version` checks, expected type per button, only `user` and `assistant` roles kept (a `system` message in a file is dropped), text length bounds, 500 messages max. Settings import is opt-in and never touches key or endpoint.
- **Single instance guard** against duplicate injection.

Known limits and risks to keep in mind:

- **Page content leaves the browser.** "Include page content" and Analyse send the page text to the configured API. Fine for an internal endpoint, a data-leak risk with an external one. The script does not detect personal or confidential data.
- **Prompt injection.** Page text and attached files go into the prompt. A hostile page can try to steer the answer. Impact is limited because the model has no tools and no action is executed, but a summary can be misleading. This is why the disclaimers stay visible.
- **Open shadow root.** The UI uses `mode: 'open'`, so JavaScript from the visited page can read `host.shadowRoot`, including the conversation and the key field while it holds a value. A malicious page could scrape it. Mitigation: `closed` mode (hides it from naive scripts, not from a determined one), plus `@exclude` on sensitive sites.
- **Runs everywhere.** `@match *://*/*` injects the script into every page. Restrict `@match`/`@exclude` to the sites you actually use.
- **Key at rest.** `GM_setValue` is not encrypted. Anyone with access to the browser profile or a script manager export can read it. Use a key with limited scope and quota, and rotate it.
- **Error bodies.** HTTP errors display up to 400 characters of the server response. Harmless in most cases, but it may echo internal details.
- **Transport.** Nothing enforces HTTPS. An `http://` URL is accepted.

## Known technical limits

- **80 s timeout on the whole request** (`timeout: 80000`), also applied to streaming. A long generation can be cut off. A per-chunk inactivity timeout would be more accurate.
- **No token counting.** Limits are in characters. The real context size depends on the model and is only discovered through a 400 error.
- **History**: the last 20 messages are re-sent each turn, attachments included, so context grows fast with large files.
- **`temperature` 0** is saved as 0.3 (`parseFloat(...) || default`).
- **No persistence** of conversations between reloads (export/import only).
- **Sites with a strict CSP** or heavy shadow DOM use can interfere with page text extraction.
- **No automated tests in the repo.** Behaviour was checked with a jsdom harness (GM stubs, simulated SSE, paste/drop events), not in real browsers.

## Possible improvements

Security:
- Optional key encryption with a passphrase asked once per session.
- `closed` shadow root, and an allowlist of sites where the button is shown (setting instead of `@match *`).
- Refuse or warn on non-HTTPS endpoints (except localhost).
- Pre-send filter: warn or redact emails, phone numbers, IBAN-like patterns and secrets before page content is sent.
- Confirmation step showing what will be sent (size, source) when "Include page content" is used on an unknown domain.
- Sanitise the error body shown to the user.

Features:
- Token estimation and a context gauge, with auto-detection of the model limit.
- Automatic history compaction (summary of old turns) and attachments sent once instead of every turn.
- Persistent conversations (IndexedDB) with a list, search and per-site history.
- Multiple profiles (endpoint, model, system prompt), switchable from the UI.
- Text extraction from PDF and DOCX in the browser; image input for vision models.
- Per-request retry with backoff on 429/5xx, and a stall timeout instead of a global one.
- Editable analysis modes and HTML templates from the UI.
- Export format migrations (`version` already present) with a compatibility test set.

Maintenance:
- Split into modules with a small bundler, keeping the single `.user.js` as output.
- Real browser test pass (Firefox and Chrome, Tampermonkey and Violentmonkey) and a CI job running the jsdom harness.
- English/French UI strings in one table.
