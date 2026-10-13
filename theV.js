// ==UserScript==
// @name         THE V · Assistant & analyse de contenu
// @namespace    baseurl à placer -------------------------------------
// @version      1.0.0
// @author       V
// @description  Interconnecte un LLM (API OpenAI-compatible) au navigateur : chat contextuel + analyse de gros volumes (pages, sélections, fichiers) par découpage et consolidation (map-reduce), avec restitution sous forme de guide.
// @match        *://*/*
// @exclude      tag d'exclusion ----------------------------------------
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      endpoint à placer -------------------------------------
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ═════════════════════════ Identité (renommer ici) ═════════════════════════ */

  const APP = {
    id: 'the-v-assistant',          // id technique (conteneur, exports)
    name: 'THE V',                  // titre de la fenêtre
    short: 'V',                     // iconne du bouton
  };

  // anti-doublon si 2 versions installées
  if (document.getElementById(APP.id + '-host')) return;

  /* ═════════════════════════ Configuration ═════════════════════════ refondre en fonction de l'endpoint model et contexte */

  const DEFAULTS = {
    baseUrl: '', // endpoint url -----------------------------------------
    model: '', // nom du model -----------------------------------------
    temperature: 0.3,
    maxContextChars: 60000,   // contexte de page pour le chat rapide
    chunkChars: 12000,        // taille d'un bloc pour l'analyse (3-4k tokens)
    concurrency: 2,           // appels LLM en parallèle pour analyse
    reduceMax: 80000,         // taille max des notes envoyées à la consolidation finale
    attachMaxChars: 10000000,   // taille max des pièces jointes d'un message de chat
    systemPrompt:
      "Tu es un assistant IA interne. Réponds en français, de façon claire, rigoureuse et concise. N'invente jamais d'information absente du contenu fourni. Par défaut propose une analyse courte et précise.",
  };

  /* Avertissement dans l'interface et ajouté aux exports */
  const DISCLAIMER_SHORT =
    "Avertissement : les réponses sont générées par un LLM. Il peut commettre des erreurs ou produire des informations inexactes. Vérifiez systématiquement les réponses avant de les utiliser.";
  const DISCLAIMER_RESULT =
    "Résultat généré par un LLM : il peut contenir des erreurs ou des inexactitudes. Il est nécessaire de le vérifier (en le comparant au contenu source) avant toute utilisation.";
  const DISCLAIMER_HTML =
    "Code généré par un LLM : il peut contenir des erreurs ou ne pas s'afficher comme prévu dans tous les environnements. Relisez-le et testez-le avant toute utilisation.";

  const num = (k, d) => { const v = Number(GM_getValue(k, d)); return v > 0 ? v : d; };
  const cfg = {
    get baseUrl() { return GM_getValue('baseUrl', DEFAULTS.baseUrl).replace(/\/+$/, ''); },
    get apiKey() { return GM_getValue('apiKey', ''); },
    get model() { return GM_getValue('model', DEFAULTS.model); },
    get temperature() { const v = Number(GM_getValue('temperature', DEFAULTS.temperature)); return isNaN(v) ? DEFAULTS.temperature : v; },
    get systemPrompt() { return GM_getValue('systemPrompt', DEFAULTS.systemPrompt); },
    get chunkChars() { return num('chunkChars', DEFAULTS.chunkChars); },
    get concurrency() { return num('concurrency', DEFAULTS.concurrency); },
    get reduceMax() { return num('reduceMax', DEFAULTS.reduceMax); },
    get attachMax() { return num('attachMax', DEFAULTS.attachMaxChars); },
  };

  /* ═════════════════════════ Client LLM ═════════════════════════ */

  const inflight = new Set();
  const abortAll = () => { inflight.forEach((h) => { try { h.abort(); } catch {} }); inflight.clear(); };

  /** Texte de réponse, tolérant : selon le gestionnaire de scripts, responseText peut être absent pendant le streaming. */
  const respText = (r) => (r && typeof r.responseText === 'string' ? r.responseText : (r && typeof r.response === 'string' ? r.response : ''));

  function request({ method, path, body, onProgress }) {
    return new Promise((resolve, reject) => {
      // sécu : sans URL absolue la clé part vers le site visité
      if (!/^https?:\/\/[^/]+/i.test(cfg.baseUrl)) return reject(new Error('Endpoint non configuré : renseignez une URL complète (https://…/v1) dans ⚙ Paramètres.'));
      if (!cfg.model && path !== '/models') return reject(new Error('Modèle non configuré : renseignez-le dans ⚙ Paramètres (ou utilisez « Tester la connexion » pour le lister).'));
      if (!cfg.apiKey) return reject(new Error('Clé privée absente..'));
      let handle;
      const done = () => inflight.delete(handle);
      handle = GM_xmlhttpRequest({
        method,
        url: cfg.baseUrl + path,
        headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 80000,
        onprogress: onProgress ? (r) => { const t = respText(r); if (t) onProgress(t); } : undefined,
        onload: (r) => {
          done();
          if (r.status >= 200 && r.status < 300) return resolve(respText(r));
          const hint = r.status === 401 ? ' (clé invalide ou expirée)' : r.status === 429 ? ' (quota atteint)' // modification dans l'onglet paramètre suivre la procédure de changement de clé dans l'inteface
            : r.status === 400 ? ' (requête refusée : bloc trop long pour le modèle ? réduisez la taille des blocs)' : ''; // modification coté Configuration à effectuer
          const body = respText(r);
          // plus tard : vérifier le texte exact des erreurs de contexte selon le serveur
          const overflow = /context|too long|maximum|max_tokens|token/i.test(body) && r.status === 400;
          reject(new Error(`HTTP ${r.status}${overflow ? ' (limite de contexte du modèle dépassée : réduisez les pièces jointes ou le contexte de page)' : hint}\n${body.slice(0, 400)}`));
        },
        onerror: () => { done(); reject(new Error('Erreur réseau : endpoint injoignable.')); }, // vérifier si vous passer par le bon points de connexion ou que le llm est bien charger et accessible
        ontimeout: () => { done(); reject(new Error('Délai dépassé.')); },
        onabort: () => { done(); reject(Object.assign(new Error('Arrêté'), { aborted: true })); },
      });
      inflight.add(handle);
    });
  }

  const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  /** Chat en streaming (SSE). onToken(delta) est appelé à chaque fragment. */
  async function chatStream(messages, onToken, temperature = cfg.temperature) {
    let seen = 0, buffer = '', emitted = false;
    const consume = (full) => {
      if (typeof full !== 'string') return;
      buffer += full.slice(seen);
      seen = full.length;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) { emitted = true; onToken(delta); }
        } catch { /* fragment incomplet */ }
      }
    };
    const full = await request({
      method: 'POST', path: '/chat/completions',
      body: { model: cfg.model, messages, temperature, stream: true },
      onProgress: consume,
    });
    consume(full + '\n');
    if (!emitted) {
      // Pas de flux SSE reçu : on passe par la réponse JSON classique (non streamée)
      try {
        const msg = JSON.parse(full).choices?.[0]?.message?.content;
        if (msg) onToken(stripThink(msg));
      } catch { /* réponse vide ou non JSON */ }
    }
  }

  /** Appel simple (sans streaming), avec un retry. Utilisé pour la map. */
  async function chatOnce(messages, temperature = 0.2) {
    for (let attempt = 0; ; attempt++) {
      try {
        const txt = await request({
          method: 'POST', path: '/chat/completions',
          body: { model: cfg.model, messages, temperature, stream: false },
        });
        return stripThink(JSON.parse(txt).choices?.[0]?.message?.content || '');
      } catch (e) {
        if (e.aborted || attempt >= 1) throw e;
      }
    }
  }

  async function listModels() {
    const txt = await request({ method: 'GET', path: '/models' });
    return (JSON.parse(txt).data || []).map((m) => m.id).sort();
  }

  /* ═════════════════════════ Extraction de contenu ═════════════════════════ */

  const getLiveSelection = () => (window.getSelection()?.toString() || '').trim();
  let lastSel = '';
  document.addEventListener('selectionchange', () => { const s = getLiveSelection(); if (s) lastSel = s; });

  function getPageText(limit = DEFAULTS.maxContextChars) {
    const rootEl = document.querySelector('main, article') || document.body;
    const clone = rootEl.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,nav,footer,iframe,svg,#' + APP.id + '-host').forEach((n) => n.remove());
    const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    return text.slice(0, limit);
  }

  const readFile = (f) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ name: f.name, text: String(r.result) });
    r.onerror = () => rej(new Error('Lecture impossible : ' + f.name));
    r.readAsText(f);
  });

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);
  const fmt = (n) => Number(n).toLocaleString('fr-FR');
  const str = (v, max = 5000000) => (typeof v === 'string' ? v.slice(0, max) : '');

  /** Sélecteur de fichiers ; résout avec [] si annulé. */
  function pickFiles({ accept = '', multiple = false } = {}) {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept; i.multiple = multiple;
      i.style.display = 'none';
      document.documentElement.appendChild(i);
      const finish = (files) => { i.remove(); resolve(files); };
      i.addEventListener('change', () => finish([...i.files]));
      i.addEventListener('cancel', () => finish([]));
      i.click();
    });
  }

  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|zip|7z|rar|gz|tar|png|jpe?g|gif|webp|bmp|ico|mp[34]|wav|avi|mov|exe|dll|bin)$/i;

  /** Lit un fichier texte. Refuse images et formats binaires avec un message clair. */
  async function readTextFile(file, maxBytes = MAX_FILE_BYTES) {
    if (file.size > maxBytes) throw new Error(`« ${file.name} » est trop volumineux (${(file.size / 1048576).toFixed(1)} Mo, maximum ${Math.round(maxBytes / 1048576)} Mo).`);
    if (/^image\//.test(file.type)) throw new Error(`« ${file.name} » : les images ne sont pas prises en charge (le modèle reçoit uniquement du texte).`);
    if (BINARY_EXT.test(file.name)) throw new Error(`« ${file.name} » : format non pris en charge. Convertissez-le en texte (txt, md, csv, json…).`);
    const { text } = await readFile(file);
    if (text.includes('\u0000')) throw new Error(`« ${file.name} » semble être un fichier binaire.`);
    return { name: file.name, text };
  }

  /* ═════════════════════════ Moteur d'analyse (map-reduce) ═════════════════════════ */

  /** Découpe un texte en blocs ≤ size caractères, en respectant les lignes. CSV/TSV : l'en-tête est répété à chaque bloc. */
  function chunkText(name, text, size) {
    let header = '';
    let body = text;
    if (/\.(csv|tsv)$/i.test(name)) {
      const i = text.indexOf('\n');
      if (i > 0) { header = text.slice(0, i); body = text.slice(i + 1); }
    }
    const room = Math.max(1000, size - header.length - 1);
    const chunks = [];
    let cur = '';
    const push = () => { if (cur.trim()) chunks.push(header ? header + '\n' + cur : cur); cur = ''; };
    for (let line of body.split('\n')) {
      while (line.length > room) { push(); cur = line.slice(0, room); push(); line = line.slice(room); }
      if (cur.length + line.length + 1 > room) push();
      cur += line + '\n';
    }
    push();
    return chunks;
  }

  function buildBlocks(sources) {
    const blocks = [];
    for (const s of sources) {
      const parts = chunkText(s.name, s.text, cfg.chunkChars);
      parts.forEach((t, i) => blocks.push({ label: `${s.name} — partie ${i + 1}/${parts.length}`, text: t }));
    }
    return blocks;
  }

  /** Modes d'analyse : consigne « map » (par bloc) et consigne « reduce » (consolidation). */
  const MODES = {
    synthese: {
      label: 'Synthèse structurée',
      map: () => "Résume fidèlement ce passage sous forme de points clés : faits, chiffres, décisions, conclusions. N'invente rien.",
      reduce: () => "Produis une synthèse structurée en Markdown : 1) Résumé exécutif (5 lignes max) 2) Points clés 3) Chiffres et dates importants 4) Points d'attention / zones d'incertitude.",
    },
    guide: {
      label: 'Guide pas-à-pas',
      map: () => "Extrais de ce passage les prérequis, procédures, étapes ordonnées, commandes/valeurs à utiliser, conseils et erreurs fréquentes. N'invente rien.",
      reduce: () => "Rédige un guide pas-à-pas en Markdown : titre, à qui il s'adresse, prérequis, étapes numérotées (avec sous-étapes si besoin), astuces, erreurs fréquentes et vérifications finales. Regroupe et ordonne logiquement.",
    },
    extraction: {
      label: 'Extraction de données (entités, chiffres, dates)',
      map: () => "Liste sous forme de puces tous les éléments factuels de ce passage : personnes, organisations, lieux, dates, montants, chiffres, identifiants, technologies. Rien d'inventé.",
      reduce: () => "Consolide et regroupe par catégorie. Utilise des tableaux Markdown quand c'est pertinent (ex. chiffres avec leur contexte et leur bloc source).",
    },
    risques: {
      label: 'Risques, anomalies & points de vigilance',
      map: () => "Repère dans ce passage les risques, incohérences, anomalies, erreurs, points bloquants ou ambigus. Cite l'extrait concerné. Si rien, réponds exactement RIEN.",
      reduce: () => "Classe les constats par gravité (critique / important / mineur), avec pour chacun : description, extrait ou bloc source, et action recommandée.",
    },
    question: {
      label: 'Question sur le contenu',
      map: (q) => `Question : « ${q} ». Extrais uniquement les éléments de ce passage utiles pour y répondre (avec chiffres et citations courtes). Si rien n'est pertinent, réponds exactement RIEN.`,
      reduce: (q) => `Réponds à la question « ${q} » à partir des extraits, de façon structurée. Cite les blocs sources entre crochets. Signale ce qui manque pour répondre complètement.`,
    },
  };

  let stopFlag = false;
  const ABORT = () => Object.assign(new Error('Arrêté'), { aborted: true });

  async function pool(items, worker, limit) {
    const res = new Array(items.length);
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length && !stopFlag) {
        const k = i++;
        try { res[k] = await worker(items[k], k); }
        catch (e) { stopFlag = true; abortAll(); throw e; }
      }
    });
    await Promise.all(runners);
    if (stopFlag) throw ABORT();
    return res;
  }

  const groupBy = (items, maxChars) => {
    const groups = []; let cur = []; let len = 0;
    for (const it of items) {
      if (cur.length && len + it.length > maxChars) { groups.push(cur); cur = []; len = 0; }
      cur.push(it); len += it.length;
    }
    if (cur.length) groups.push(cur);
    return groups;
  };

  /**
   * sources : [{name, text}]
   * onProgress(pct, message), onToken(delta) pour une restitution finale en streaming
   */
  async function analyse({ sources, modeKey, question, onProgress, onToken }) {
    stopFlag = false;
    const mode = MODES[modeKey];
    const sys = cfg.systemPrompt;
    const blocks = buildBlocks(sources);
    const n = blocks.length;
    if (!n) throw new Error('Aucun contenu à analyser.');

    // Cas simple : un seul bloc → restitution directe
    if (n === 1) {
      onProgress(50, 'Analyse directe (1 bloc)…');
      await chatStream([
        { role: 'system', content: `${sys}\n\n${mode.reduce(question)}` },
        { role: 'user', content: `Contenu à analyser :\n"""\n${blocks[0].text}\n"""` },
      ], onToken, 0.2);
      onProgress(100, 'Terminé.');
      return;
    }

    // 1) MAP : une note par bloc, en parallèle
    let done = 0;
    onProgress(0, `Analyse de ${n} blocs (${cfg.concurrency} en parallèle)…`);
    const notes = await pool(blocks, async (b, k) => {
      const note = await chatOnce([
        { role: 'system', content: `${sys}\n\n${mode.map(question)}` },
        { role: 'user', content: `[Bloc ${k + 1}/${n} · ${b.label}]\n"""\n${b.text}\n"""` },
      ]);
      done++;
      onProgress(Math.round((done / n) * 80), `Bloc ${done}/${n} analysé…`);
      return note;
    }, cfg.concurrency);

    let level = notes
      .map((t, k) => ({ t: t.trim(), k }))
      .filter((x) => x.t && !/^RIEN\.?$/i.test(x.t))
      .map((x) => `### Bloc ${x.k + 1} — ${blocks[x.k].label}\n${x.t}`);

    if (!level.length) { onToken('Aucun élément pertinent trouvé dans le contenu analysé.'); onProgress(100, 'Terminé.'); return; }

    // 2) REDUCE hiérarchique si les notes dépassent la fenêtre de consolidation
    let guard = 0;
    while (level.join('\n\n').length > cfg.reduceMax && guard++ < 4) {
      const groups = groupBy(level, cfg.reduceMax);
      if (groups.length >= level.length) break;
      onProgress(85, `Consolidation intermédiaire (${groups.length} groupes)…`);
      level = await pool(groups, (g) => chatOnce([
        { role: 'system', content: `${sys}\n\nConsolide ces notes partielles en une note unique. Conserve TOUS les faits, chiffres, dates et références de blocs ; supprime seulement la mise en forme.` }, // suprimer la mise en forme à repenser plus tard en fonction de la situation
        { role: 'user', content: g.join('\n\n') },
      ]), cfg.concurrency);
    }

    // 3) REDUCE final en streaming
    onProgress(92, 'Rédaction de la restitution finale…');
    await chatStream([
      { role: 'system', content: `${sys}\n\n${mode.reduce(question)}\nTu travailles à partir de notes extraites d'un document volumineux (${n} blocs).` },
      { role: 'user', content: level.join('\n\n').slice(0, Math.round(cfg.reduceMax * 1.5)) },
    ], onToken, 0.2);
    onProgress(100, 'Terminé.');
  }

  /* ═════════════════════════ Interface (Shadow DOM) ═════════════════════════ refonte par @Guumelia en cours de commande */

  const host = document.createElement('div');
  host.id = APP.id + '-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .fab { position: fixed; left: 0; top: 0; width: 48px; height: 48px; border-radius: 50%;
             background: #1f4fd8; color: #fff; border: 0; font-size: 22px; cursor: grab; z-index: 2147483646;
             box-shadow: 0 4px 14px rgba(0,0,0,.3); touch-action: none; user-select: none; }
      .fab.dragging { cursor: grabbing; }
      .panel { position: fixed; left: 0; top: 0; width: 440px; height: 620px;
               min-width: 320px; min-height: 380px; max-width: calc(100vw - 8px); max-height: calc(100vh - 8px);
               resize: both; background: #fff; color: #1b1f2a;
               border: 1px solid #d0d5dd; border-radius: 12px; display: none; flex-direction: column;
               z-index: 2147483647; box-shadow: 0 10px 40px rgba(0,0,0,.28); overflow: hidden; }
      .panel.open { display: flex; }
      header { display: flex; align-items: center; gap: 6px; padding: 10px 12px; background: #1f4fd8; color: #fff;
               cursor: move; touch-action: none; user-select: none; }
      header h1 { font-size: 14px; margin: 0; flex: 1; font-weight: 600; }
      header button { background: transparent; border: 0; color: #fff; font-size: 16px; cursor: pointer; padding: 2px 6px; }
      .tabs { display: flex; border-bottom: 1px solid #eaecf0; }
      .tabs button { flex: 1; padding: 8px; border: 0; background: #fff; cursor: pointer; font-size: 13px; color: #475467; border-bottom: 2px solid transparent; }
      .tabs button.on { color: #1f4fd8; border-bottom-color: #1f4fd8; font-weight: 600; }
      .disclaimer { padding: 6px 12px; font-size: 11px; line-height: 1.35; background: #fffaeb; color: #93370d; border-bottom: 1px solid #fedf89; }
      .form-body .disclaimer { border: 1px solid #fedf89; border-radius: 6px; padding: 6px 8px; }
      .view { display: none; flex: 1; flex-direction: column; min-height: 0; }
      .view.on { display: flex; }
      .quick { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eaecf0; flex-wrap: wrap; }
      .quick button { font-size: 12px; padding: 4px 8px; border: 1px solid #d0d5dd; background: #f9fafb; border-radius: 999px; cursor: pointer; }
      .quick button:hover { background: #eef2ff; }
      .msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
      .msg { padding: 8px 10px; border-radius: 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
      .msg.user { align-self: flex-end; background: #1f4fd8; color: #fff; max-width: 88%; }
      .msg.assistant { align-self: flex-start; background: #f2f4f7; max-width: 96%; }
      .msg.error { align-self: stretch; background: #fef3f2; color: #b42318; }
      .codeblock { margin: 6px 0; border-radius: 6px; overflow: hidden; background: #101828; white-space: normal; }
      .codebar { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 8px; background: #1d2939; color: #d0d5dd; font-size: 11px; }
      .codebar .acts { display: flex; gap: 4px; }
      .codebar button { font-size: 11px; padding: 2px 8px; border: 1px solid #475467; background: transparent; color: #f2f4f7; border-radius: 4px; cursor: pointer; }
      .codebar button:hover { background: #344054; }
      .codeblock pre { background: #101828; color: #f2f4f7; padding: 8px; overflow-x: auto; white-space: pre; margin: 0; }
      .msg code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
      .opts { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; color: #475467; border-top: 1px solid #eaecf0; }
      .opts label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
      .opts { flex-wrap: wrap; }
      .opts .io { margin-left: auto; display: flex; gap: 4px; }
      .opts .io button { font-size: 11px; padding: 2px 8px; border: 1px solid #d0d5dd; background: #f9fafb; border-radius: 999px; cursor: pointer; color: #475467; }
      .opts .io button:hover { background: #eef2ff; }
      form button.ghost { background: #f2f4f7; color: #1b1f2a; border: 1px solid #d0d5dd; padding: 0 10px; font-size: 16px; }
      .atts { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px 0; border-top: 1px solid #eaecf0; font-size: 12px; }
      .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 4px 2px 8px; background: #eef2ff; border: 1px solid #c7d7fe; border-radius: 999px; color: #1f2a5a; }
      .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
      .chip button { border: 0; background: transparent; cursor: pointer; color: #475467; font-size: 12px; padding: 0 4px; }
      .atts .warn { flex-basis: 100%; color: #b42318; background: #fef3f2; border: 1px solid #fecdca; border-radius: 6px; padding: 4px 8px; }
      .atts .warn button { margin-left: 6px; font-size: 11px; padding: 1px 8px; border: 1px solid #fda29b; background: #fff; border-radius: 999px; cursor: pointer; color: #b42318; }
      .view.drop { outline: 2px dashed #1f4fd8; outline-offset: -6px; background: #eef2ff; }
      .msg .mbody { white-space: pre-wrap; }
      .mtools { display: flex; justify-content: flex-end; margin-top: 4px; white-space: normal; }
      .mtools button { font-size: 11px; padding: 1px 8px; border: 1px solid rgba(0,0,0,.2); background: transparent; color: inherit; border-radius: 999px; cursor: pointer; opacity: .65; }
      .mtools button:hover { opacity: 1; }
      .msg.user .mtools button { border-color: rgba(255,255,255,.6); }
      form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #eaecf0; }
      textarea { flex: 1; resize: none; height: 44px; border: 1px solid #d0d5dd; border-radius: 8px; padding: 6px 8px; font-size: 13px; }
      form button { border: 0; background: #1f4fd8; color: #fff; border-radius: 8px; padding: 0 14px; cursor: pointer; font-size: 13px; }
      .stop { background: #b42318 !important; }
      .form-body { display: flex; flex-direction: column; gap: 8px; padding: 12px; overflow-y: auto; font-size: 12px; }
      .form-body label { display: flex; flex-direction: column; gap: 3px; color: #475467; }
      .form-body label.inline { flex-direction: row; align-items: center; gap: 6px; cursor: pointer; }
      .form-body input, .form-body select, .form-body textarea { height: auto; border: 1px solid #d0d5dd; border-radius: 6px; padding: 6px; font-size: 12px; color: #1b1f2a; }
      .form-body input[type=checkbox] { padding: 0; border: 0; }
      .form-body textarea { flex: none; }
      .row { display: flex; gap: 6px; flex-wrap: wrap; }
      .form-body button { padding: 6px 10px; border: 1px solid #d0d5dd; border-radius: 6px; background: #f9fafb; cursor: pointer; font-size: 12px; }
      .form-body button.primary { background: #1f4fd8; border-color: #1f4fd8; color: #fff; }
      .status { min-height: 16px; color: #475467; }
      .info { background: #f9fafb; border: 1px dashed #d0d5dd; border-radius: 6px; padding: 6px 8px; color: #475467; }
      .bar { height: 6px; background: #eaecf0; border-radius: 999px; overflow: hidden; }
      .bar > div { height: 100%; width: 0; background: #1f4fd8; transition: width .25s; }
      .subtabs { display: flex; gap: 4px; border-bottom: 1px solid #eaecf0; }
      .form-body .subtabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: #475467; }
      .form-body .subtabs button.on { color: #1f4fd8; border-bottom-color: #1f4fd8; font-weight: 600; }
      .pv-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
      .form-body .pv-tools label { flex-direction: row; align-items: center; gap: 4px; }
      .pv-wrap { border: 1px solid #d0d5dd; border-radius: 6px; background: #eaecf0; overflow: auto; height: 340px; }
      .pv-wrap iframe { display: block; height: 100%; border: 0; background: #fff; margin: 0 auto; }
      .codebox { border-radius: 6px; overflow: hidden; background: #101828; }
      .form-body textarea#h-src { display: block; width: 100%; height: 320px; border: 0; border-radius: 0; background: #101828; color: #f2f4f7;
                 font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.4; white-space: pre; overflow: auto; resize: vertical; }
      [hidden] { display: none !important; }
    </style>

    <button class="fab" title="${APP.name} (Alt+L) · glisser pour déplacer">${APP.short}</button>

    <div class="panel">
      <header title="Glisser pour déplacer la fenêtre">
        <h1>${APP.name}</h1>
        <button data-act="settings" title="Paramètres">⚙</button>
        <button data-act="clear" title="Nouvelle conversation">🗑</button>
        <button data-act="close" title="Fermer">✕</button>
      </header>
      <div class="tabs">
        <button data-tab="chat" class="on">Chat</button>
        <button data-tab="analyse">Analyse</button>
        <button data-tab="html">HTML</button>
      </div>
      <div class="disclaimer" id="disclaimer"></div>

      <!-- ───────── Chat ───────── -->
      <div class="view on" data-view="chat">
        <div class="quick">
          <button data-q="summarize">Résumer la page</button>
          <button data-q="explain">Expliquer la sélection</button>
          <button data-q="translate">Traduire la sélection</button>
        </div>
        <div class="msgs"></div>
        <div class="opts">
          <label><input type="checkbox" id="ctx" /> Inclure le contenu de la page</label>
          <span class="io">
            <button type="button" id="c-exp-json" title="Exporter la conversation (rechargeable avec Import)">Export .json</button>
            <button type="button" id="c-exp-md" title="Exporter la conversation en Markdown lisible">Export .md</button>
            <button type="button" id="c-imp" title="Importer une conversation exportée (.json)">Import</button>
          </span>
        </div>
        <div class="atts" id="atts" hidden></div>
        <form>
          <button type="button" id="c-attach" class="ghost" title="Joindre des fichiers texte (ou collez-les avec Ctrl+V, ou glissez-déposez-les dans la fenêtre)">📎</button>
          <textarea placeholder="Posez votre question… (Entrée pour envoyer)"></textarea>
          <button type="submit" id="c-send">Envoyer</button>
        </form>
      </div>

      <!-- ───────── Analyse ───────── -->
      <div class="view" data-view="analyse">
        <div class="form-body">
          <label>Source à analyser
            <select id="a-src">
              <option value="page">Page entière (sans limite de taille)</option>
              <option value="sel">Sélection en cours</option>
              <option value="files">Fichiers locaux…</option>
            </select>
          </label>
          <div class="row" id="a-filebox" hidden>
            <button id="a-pick" type="button">Choisir des fichiers</button>
            <span class="status" id="a-fnames"></span>
          </div>
          <input type="file" id="a-files" multiple hidden
                 accept=".txt,.md,.csv,.tsv,.json,.sdl,.log,.xml,.html,.htm,.yaml,.yml,.sql,.ini,.conf,.js,.py,.ts,.java,.sh" />
          <div class="info" id="a-info"></div>
          <label>Type d'analyse <select id="a-mode"></select></label>
          <label>Question / consignes supplémentaires
            <textarea id="a-q" rows="2" style="height:auto" placeholder="Obligatoire pour « Question sur le contenu »"></textarea>
          </label>
          <div class="row">
            <button id="a-run" class="primary" type="button">Lancer l'analyse</button>
            <button id="a-imp" type="button" title="Recharger une analyse exportée (.json) ou un texte (.md, .txt)">Importer une analyse</button>
          </div>
          <div class="bar"><div id="a-bar"></div></div>
          <div class="status" id="a-status"></div>
          <div class="msg assistant" id="a-out" hidden style="max-width:100%"></div>
          <div class="disclaimer" id="a-warn" hidden></div>
          <div class="row" id="a-actions" hidden>
            <button id="a-copy" type="button">Copier</button>
            <button id="a-dl" type="button">Télécharger .md</button>
            <button id="a-dl-json" type="button">Exporter .json</button>
            <button id="a-chat" type="button">Continuer dans le chat</button>
          </div>
        </div>
      </div>

      <!-- ───────── HTML ───────── -->
      <div class="view" data-view="html">
        <div class="form-body">
          <label>Type de contenu
            <select id="h-type">
              <option value="page">Page web complète</option>
              <option value="section">Section / composant</option>
              <option value="email">Email HTML (compatible clients mail)</option>
              <option value="form">Formulaire</option>
            </select>
          </label>
          <label>Consignes
            <textarea id="h-q" rows="3" style="height:auto" placeholder="Ex. : page de présentation d'un service, ton sobre, 3 sections, bouton « Nous contacter »"></textarea>
          </label>
          <label class="inline"><input type="checkbox" id="h-edit" /> Modifier le code actuel (au lieu de repartir de zéro)</label>
          <label class="inline"><input type="checkbox" id="h-sel" /> Utiliser la sélection de la page comme contenu de départ</label>
          <div class="row">
            <button id="h-run" class="primary" type="button">Générer</button>
            <button id="h-clear" type="button">Vider</button>
            <button id="h-imp" type="button" title="Charger un fichier .html ou un export .json">Importer</button>
          </div>
          <div class="status" id="h-status"></div>

          <div class="subtabs">
            <button data-sub="preview" class="on" type="button">Aperçu</button>
            <button data-sub="code" type="button">Code</button>
          </div>

          <div id="h-preview">
            <div class="pv-tools">
              <label>Largeur
                <select id="h-width">
                  <option value="100%">Pleine</option>
                  <option value="768px">Tablette (768)</option>
                  <option value="390px">Mobile (390)</option>
                </select>
              </label>
              <label class="inline"><input type="checkbox" id="h-js" /> Autoriser les scripts dans l'aperçu</label>
            </div>
            <div class="pv-wrap"><iframe id="h-frame" sandbox="" title="Aperçu HTML"></iframe></div>
          </div>

          <div id="h-code" hidden>
            <div class="codebox">
              <div class="codebar">
                <span>html</span>
                <div class="acts">
                  <button id="h-copy" type="button">Copier</button>
                  <button id="h-dl" type="button">Télécharger .html</button>
                  <button id="h-dl-json" type="button">Exporter .json</button>
                </div>
              </div>
              <textarea id="h-src" spellcheck="false" placeholder="Le code HTML apparaît ici (modifiable : l'aperçu se met à jour)."></textarea>
            </div>
          </div>
          <div class="disclaimer" id="h-warn"></div>
        </div>
      </div>

      <!-- ───────── Paramètres ───────── -->
      <div class="view" data-view="settings">
        <div class="form-body">
          <label>Endpoint (base_url) <input id="s-url" type="text" /></label>
          <label>Clé privée <input id="s-key" type="password" placeholder="sk-..." /></label>
          <label>Modèle
            <div class="row">
              <select id="s-model" style="flex:1"></select>
              <button id="s-refresh" type="button">Charger la liste</button>
            </div>
          </label>
          <label>Température <input id="s-temp" type="number" min="0" max="2" step="0.1" /></label>
          <label>Prompt système <textarea id="s-sys" rows="3" style="height:auto"></textarea></label>
          <div class="row">
            <label style="flex:1">Taille d'un bloc (car.) <input id="s-chunk" type="number" min="2000" step="1000" /></label>
            <label style="flex:1">Appels parallèles <input id="s-conc" type="number" min="1" max="8" /></label>
            <label style="flex:1">Max consolidation (car.) <input id="s-red" type="number" min="4000" step="1000" /></label>
            <label style="flex:1">Max pièces jointes (car.) <input id="s-att" type="number" min="5000" step="5000" /></label>
          </div>
          <div class="row">
            <button id="s-save" class="primary" type="button">Enregistrer</button>
            <button id="s-test" type="button">Tester la connexion</button>
            <button id="s-layout" type="button">Réinitialiser position et taille</button>
          </div>
          <div class="info"><b>Sauvegarde complète</b> : conversation, dernière analyse et code HTML. La clé privée et l'endpoint ne sont jamais exportés ni importés.</div>
          <label class="inline"><input type="checkbox" id="b-settings" /> À l'import, appliquer aussi les réglages du fichier (modèle, température, prompt système, tailles)</label>
          <div class="row">
            <button id="b-exp" type="button">Exporter tout (.json)</button>
            <button id="b-imp" type="button">Importer une sauvegarde</button>
          </div>
          <div class="status" id="s-status"></div>
        </div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const fab = $('.fab'), panel = $('.panel'), msgsEl = $('.msgs'), headerEl = $('header');
  const form = $('form'), input = $('form textarea'), sendBtn = $('#c-send'), ctxCheck = $('#ctx');

  // Textes d'avertissement (injectés via textContent)
  $('#disclaimer').textContent = DISCLAIMER_SHORT;
  $('#a-warn').textContent = DISCLAIMER_RESULT;
  $('#h-warn').textContent = DISCLAIMER_HTML;

  /* ═════════════ Position et taille (déplacement / redimensionnement) ═════════════ */

  const FAB_SIZE = 48, MARGIN = 4;
  const vw = () => document.documentElement.clientWidth;
  const vh = () => document.documentElement.clientHeight;
  const clampPos = (x, y, w, h) => ({
    x: Math.round(Math.min(Math.max(MARGIN, x), Math.max(MARGIN, vw() - w - MARGIN))),
    y: Math.round(Math.min(Math.max(MARGIN, y), Math.max(MARGIN, vh() - h - MARGIN))),
  });
  const setPos = (el, p) => { el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; };

  function placeFab() {
    const s = GM_getValue('fabPos', null);
    const x = s ? s.x : vw() - FAB_SIZE - 20;
    const y = s ? s.y : vh() - FAB_SIZE - 20;
    setPos(fab, clampPos(x, y, FAB_SIZE, FAB_SIZE));
  }

  function placePanel() {
    const s = GM_getValue('panelPos', null);
    const r = panel.getBoundingClientRect();
    let x, y;
    if (s) { x = s.x; y = s.y; }
    else {
      const f = fab.getBoundingClientRect();
      x = f.right - r.width;
      y = f.top - r.height - 10;
      if (y < MARGIN) y = f.bottom + 10;
    }
    setPos(panel, clampPos(x, y, r.width, r.height));
  }

  /** Rend un élément déplaçable via `handle`. Retourne { moved() } pour distinguer un glisser d'un clic. */
  function makeDraggable(handle, target, { ignore, onEnd } = {}) {
    let down = false, moving = false, sx = 0, sy = 0, ox = 0, oy = 0, wasMoved = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (ignore && e.target.closest(ignore)) return;
      down = true; moving = false; wasMoved = false;
      sx = e.clientX; sy = e.clientY;
      const r = target.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moving && Math.hypot(dx, dy) < 4) return;
      moving = true;
      const r = target.getBoundingClientRect();
      setPos(target, clampPos(ox + dx, oy + dy, r.width, r.height));
      target.classList.add('dragging');
    });
    const end = (e) => {
      if (!down) return;
      down = false;
      try { handle.releasePointerCapture(e.pointerId); } catch {}
      target.classList.remove('dragging');
      if (moving) { wasMoved = true; const r = target.getBoundingClientRect(); onEnd?.({ x: Math.round(r.left), y: Math.round(r.top) }); }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    return { moved: () => { const m = wasMoved; wasMoved = false; return m; } };
  }

  const fabDrag = makeDraggable(fab, fab, { onEnd: (p) => GM_setValue('fabPos', p) });
  makeDraggable(headerEl, panel, { ignore: 'button', onEnd: (p) => GM_setValue('panelPos', p) });

  // Taille mémorisée et suivi du redimensionnement (poignée en bas à droite par défaut)
  const savedSize = GM_getValue('panelSize', null);
  if (savedSize && savedSize.w > 0 && savedSize.h > 0) {
    panel.style.width = savedSize.w + 'px';
    panel.style.height = savedSize.h + 'px';
  }
  let sizeTimer;
  new ResizeObserver(() => {
    if (!panel.classList.contains('open')) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const r = panel.getBoundingClientRect();
      if (r.width > 0) GM_setValue('panelSize', { w: Math.round(r.width), h: Math.round(r.height) });
      setPos(panel, clampPos(r.left, r.top, r.width, r.height));
    }, 250);
  }).observe(panel);

  window.addEventListener('resize', () => {
    placeFab();
    if (panel.classList.contains('open')) {
      const r = panel.getBoundingClientRect();
      setPos(panel, clampPos(r.left, r.top, r.width, r.height));
    }
  });

  function resetLayout() {
    ['fabPos', 'panelPos', 'panelSize'].forEach((k) => GM_deleteValue(k));
    panel.style.width = ''; panel.style.height = '';
    placeFab();
    if (panel.classList.contains('open')) placePanel();
  }

  placeFab();

  /* ── navigation entre vues ── */
  let currentView = 'chat', previousView = 'chat';
  function showView(name) {
    if (name !== 'settings') previousView = name;
    currentView = name;
    root.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
    root.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'analyse') refreshInfo();
    if (name === 'settings') fillSettings();
  }
  root.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.tab)));

  /* ── rendu minimal : blocs ``` bloc de code avec bouton « Copier » (sans innerHTML) ── */
  function renderInto(el, text) {
    el.textContent = '';
    text.split(/```/).forEach((part, i) => {
      if (i % 2 === 1) {
        const m = part.match(/^([\w+-]*)\n/);
        const lang = m ? m[1].toLowerCase() : '';
        const codeText = (m ? part.slice(m[0].length) : part).replace(/\n$/, '');

        const wrap = document.createElement('div'); wrap.className = 'codeblock';
        const bar = document.createElement('div'); bar.className = 'codebar';
        const label = document.createElement('span'); label.textContent = lang || 'code';
        const acts = document.createElement('div'); acts.className = 'acts';

        if (lang === 'html' || lang === 'htm') {
          const pv = document.createElement('button'); pv.type = 'button'; pv.textContent = 'Aperçu';
          pv.onclick = () => loadHtml(codeText);
          acts.appendChild(pv);
        }
        const cp = document.createElement('button'); cp.type = 'button'; cp.textContent = 'Copier';
        cp.onclick = () => {
          GM_setClipboard(codeText, 'text');
          cp.textContent = 'Copié ✓';
          setTimeout(() => { cp.textContent = 'Copier'; }, 1500);
        };
        acts.appendChild(cp);

        bar.append(label, acts);
        const pre = document.createElement('pre'), code = document.createElement('code');
        code.textContent = codeText;
        pre.appendChild(code);
        wrap.append(bar, pre);
        el.appendChild(wrap);
      } else if (part) el.appendChild(document.createTextNode(part));
    });
  }

  /* ═════════════ Onglet Chat ═════════════ */
  // history : [{ role, content (envoyé au modèle), display (affiché / exporté), atts?, hidden? }]
  let history = [];
  let busy = false;

  /** Messages envoyés à l'API : uniquement role + content (jamais de champs supplémentaires). */
  const toApi = (h) => ({ role: h.role, content: h.content });

  function copyWithFeedback(btn, text) {
    const label = btn.textContent;
    GM_setClipboard(text, 'text');
    btn.textContent = 'Copié ✓';
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  const msgState = new WeakMap();   // élément message { body, raw }

  /** Remplace le contenu d'un message ; le texte brut complet est conservé pour le bouton « Copier ». */
  function setMsg(el, text) {
    const st = msgState.get(el);
    st.raw = text;
    renderInto(st.body, text);
  }

  function addMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    const body = document.createElement('div'); body.className = 'mbody';
    const tools = document.createElement('div'); tools.className = 'mtools';
    const cp = document.createElement('button'); cp.type = 'button'; cp.textContent = 'Copier';
    cp.title = 'Copier ce message en entier';
    cp.onclick = () => copyWithFeedback(cp, msgState.get(el).raw);
    tools.appendChild(cp);
    el.append(body, tools);
    msgState.set(el, { body, raw: '' });
    setMsg(el, text);
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return el;
  }

  function setBusy(v) {
    busy = v;
    sendBtn.textContent = v ? 'Stop' : 'Envoyer';
    sendBtn.classList.toggle('stop', v);
  }

  /* ── Pièces jointes du chat (📎, Ctrl+V, glisser-déposer) ── */
  const ATTACH_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.sdl,.jsonl,.log,.xml,.html,.htm,.css,.yaml,.yml,.toml,.sql,.ini,.conf,.cfg,.env,.js,.mjs,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.php,.rb,.sh,.ps1,.bat,.tex,.srt,.vtt,.eml,text/*'; // extention de fichier tolérer (flem de tout test)
  const attsEl = $('#atts');
  let pending = [];   // [{ name, text, chars }]
  const pendingChars = () => pending.reduce((a, p) => a + p.chars, 0);

  function renderAtts(extraWarn = '') {
    attsEl.textContent = '';
    pending.forEach((p, i) => {
      const chip = document.createElement('div'); chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = `📎 ${p.name} · ${fmt(p.chars)} car.`; label.title = p.name;
      const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '✕'; rm.title = 'Retirer';
      rm.onclick = () => { pending.splice(i, 1); renderAtts(); };
      chip.append(label, rm);
      attsEl.appendChild(chip);
    });
    const over = pendingChars() > cfg.attachMax;
    const msgs = [];
    if (over) msgs.push(`Pièces jointes trop volumineuses (${fmt(pendingChars())} car., maximum ${fmt(cfg.attachMax)}).`); // ne devrais jamais apparaitre en raison de la mise en place des chunks mais fck it
    if (extraWarn) msgs.push(extraWarn);
    if (msgs.length) {
      const w = document.createElement('div'); w.className = 'warn';
      w.appendChild(document.createTextNode(msgs.join(' ')));
      if (over) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Envoyer vers l’onglet Analyse';
        b.onclick = sendPendingToAnalyse;
        w.appendChild(b);
      }
      attsEl.appendChild(w);
    }
    attsEl.hidden = !pending.length && !msgs.length;
  }

  async function addAttachments(files) {
    const errors = [];
    for (const f of files) {
      try {
        const { name, text } = await readTextFile(f);
        if (!text.trim()) throw new Error(`« ${name} » est vide.`);
        pending.push({ name, text, chars: text.length });
      } catch (e) { errors.push(e.message); }
    }
    renderAtts(errors.join(' '));
  }

  /** Trop gros pour le chat : on transmet les fichiers à l'onglet Analyse (découpage + consolidation). */
  function sendPendingToAnalyse() {
    if (!pending.length) return;
    loadedFiles = pending.map((p) => ({ name: p.name, text: p.text }));
    aFnames.textContent = loadedFiles.map((f) => f.name).join(', ');
    aSrc.value = 'files';
    pending = []; renderAtts();
    showView('analyse');
  }

  $('#c-attach').onclick = async () => {
    const files = await pickFiles({ accept: ATTACH_ACCEPT, multiple: true });
    if (files.length) addAttachments(files);
  };

  // Ctrl+V : des fichiers collés deviennent des pièces jointes ; le texte collé garde son comportement normal pas d'ordre définit sur l'ordre d'arriver des infos pour le llm impacte possible sur la réponse plus tard
  input.addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    addAttachments(files);
  });

  async function ask(userText, { forceContext = null, extraContext = '', atts = [] } = {}) {
    if (busy) return;
    openPanel(); showView('chat');
    const useCtx = forceContext ?? ctxCheck.checked;
    let content = extraContext ? `${extraContext}\n\n---\n${userText}` : userText;
    if (atts.length) {
      const files = atts.map((a) => `Fichier joint « ${a.name} » (${fmt(a.chars)} caractères) :\n"""\n${a.text}\n"""`).join('\n\n');
      content = `${files}\n\n---\n${content}`;
    }
    if (useCtx) content = `Contexte — page « ${document.title} » (${location.href}) :\n"""\n${getPageText()}\n"""\n\n${content}`;

    const display = atts.length ? `${userText}\n${atts.map((a) => `📎 ${a.name} (${fmt(a.chars)} car.)`).join('\n')}` : userText;
    addMsg('user', display);
    history.push({ role: 'user', content, display, atts: atts.map(({ name, chars }) => ({ name, chars })) });
    const out = addMsg('assistant', '…');
    let acc = '';
    setBusy(true);
    try {
      await chatStream([{ role: 'system', content: cfg.systemPrompt }, ...history.slice(-20).map(toApi)], (tok) => {
        acc += tok; setMsg(out, acc); msgsEl.scrollTop = msgsEl.scrollHeight;
      });
      history.push({ role: 'assistant', content: acc, display: acc });
    } catch (e) {
      if (!e.aborted) { out.className = 'msg error'; setMsg(out, e.message); history.pop(); }
      else if (acc) history.push({ role: 'assistant', content: acc, display: acc });
      else { setMsg(out, '(Arrêté)'); history.pop(); }
    } finally { setBusy(false); }
  }

  function quick(kind) {
    const sel = getLiveSelection();
    if (kind === 'summarize') return ask('Résume cette page en points clés.', { forceContext: true });
    if (!sel) return addMsg('error', 'Sélectionnez d’abord du texte sur la page.'); // pas très fonctionel pour le moment à voir plus tard 
    if (kind === 'explain') return ask('Explique ce passage simplement.', { forceContext: false, extraContext: `Passage :\n"""\n${sel}\n"""` });
    if (kind === 'translate') return ask('Traduis ce texte en français (ou en anglais s’il est déjà en français).', { forceContext: false, extraContext: `Texte :\n"""\n${sel}\n"""` });
  }

  root.querySelectorAll('.quick [data-q]').forEach((b) => (b.onclick = () => quick(b.dataset.q)));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { abortAll(); return; }
    let txt = input.value.trim();
    if (!txt && !pending.length) return;
    if (pendingChars() > cfg.attachMax) { renderAtts(); return; }   // avertissement déjà affiché
    const atts = pending;
    if (!txt) txt = atts.length === 1 ? 'Résume le contenu du fichier joint.' : 'Résume le contenu des fichiers joints.';
    input.value = ''; pending = []; renderAtts();
    ask(txt, { atts });
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  /* ── Glisser-déposer de fichiers (Chat : pièces jointes ; Analyse : sources) ── */
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  [['chat', (files) => addAttachments(files)], ['analyse', (files) => loadAnalyseFiles(files)]].forEach(([name, onFiles]) => {
    const v = $(`[data-view="${name}"]`);
    v.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); v.classList.add('drop'); });
    v.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !v.contains(e.relatedTarget)) v.classList.remove('drop'); });
    v.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); v.classList.remove('drop');
      onFiles(Array.from(e.dataTransfer.files));
    });
  });
  // Un fichier lâché ailleurs dans la fenêtre ne doit pas être intégrer à la conv
  ['dragover', 'drop'].forEach((t) => panel.addEventListener(t, (e) => { if (hasFiles(e)) e.preventDefault(); }));

  /* ═════════════ Onglet Analyse ═════════════ */
  const aSrc = $('#a-src'), aMode = $('#a-mode'), aQ = $('#a-q'), aInfo = $('#a-info');
  const aRun = $('#a-run'), aBar = $('#a-bar'), aStatus = $('#a-status'), aOut = $('#a-out');
  const aActions = $('#a-actions'), aWarn = $('#a-warn'), aFiles = $('#a-files'), aFileBox = $('#a-filebox'), aFnames = $('#a-fnames');
  let loadedFiles = [];
  let analysing = false;
  let lastResult = '', lastSourceName = '', lastMode = 'synthese', lastQuestion = '';

  Object.entries(MODES).forEach(([k, m]) => {
    const o = document.createElement('option'); o.value = k; o.textContent = m.label; aMode.appendChild(o);
  });

  function currentSources() {
    if (aSrc.value === 'page') return [{ name: document.title || location.hostname, text: getPageText(Infinity) }];
    if (aSrc.value === 'sel') return lastSel ? [{ name: 'Sélection', text: lastSel }] : [];
    return loadedFiles;
  }

  function refreshInfo() {
    aFileBox.hidden = aSrc.value !== 'files';
    const src = currentSources();
    const chars = src.reduce((a, s) => a + s.text.length, 0);
    if (!chars) { aInfo.textContent = aSrc.value === 'sel' ? 'Aucune sélection : sélectionnez du texte sur la page.' : 'Aucun contenu chargé.'; return; }
    const blocks = src.reduce((a, s) => a + Math.max(1, Math.ceil(s.text.length / cfg.chunkChars)), 0);
    aInfo.textContent = `${src.length} source(s) · ${chars.toLocaleString('fr-FR')} caractères · ≈ ${blocks} bloc(s) · ≈ ${Math.round(chars / 3.5).toLocaleString('fr-FR')} tokens`;
  }

  aSrc.onchange = refreshInfo;
  $('#a-pick').onclick = () => aFiles.click();
  /** Charge les fichiers texte comme source d'analyse (sélecteur ou glisser-déposer). */
  async function loadAnalyseFiles(files) {
    if (!files.length) return;
    aSrc.value = 'files';
    try {
      loadedFiles = await Promise.all(files.map((f) => readTextFile(f, Infinity)));
      aFnames.textContent = loadedFiles.map((f) => f.name).join(', ');
    } catch (e) { aFnames.textContent = e.message; }
    refreshInfo();
  }
  aFiles.onchange = () => loadAnalyseFiles([...aFiles.files]);

  aRun.onclick = async () => {
    if (analysing) { stopFlag = true; abortAll(); return; }
    const sources = currentSources();
    const question = aQ.value.trim();
    if (!sources.length || !sources.some((s) => s.text.trim())) { aStatus.textContent = '✗ Aucun contenu à analyser.'; return; }
    if (aMode.value === 'question' && !question) { aStatus.textContent = '✗ Saisissez une question.'; return; }

    analysing = true;
    aRun.textContent = 'Arrêter'; aRun.classList.add('stop');
    aOut.hidden = false; aActions.hidden = true; aWarn.hidden = true; aOut.textContent = '';
    aBar.style.width = '0'; lastResult = ''; lastSourceName = sources.map((s) => s.name).join(', ');
    lastMode = aMode.value; lastQuestion = question;
    try {
      await analyse({
        sources, modeKey: aMode.value, question,
        onProgress: (pct, msg) => { aBar.style.width = pct + '%'; aStatus.textContent = msg; },
        onToken: (t) => { lastResult += t; renderInto(aOut, lastResult); },
      });
      aActions.hidden = false; aWarn.hidden = false;
    } catch (e) {
      aStatus.textContent = e.aborted ? 'Analyse arrêtée.' : '✗ ' + e.message;
      if (lastResult) { aActions.hidden = false; aWarn.hidden = false; }
    } finally {
      analysing = false;
      aRun.textContent = 'Lancer l\'analyse'; aRun.classList.remove('stop');
    }
  };

  $('#a-copy').onclick = () => { GM_setClipboard(lastResult, 'text'); aStatus.textContent = '✓ Copié dans le presse-papiers.'; };
  $('#a-dl').onclick = () => {
    downloadText(
      `analyse-${lastMode}-${stamp()}.md`,
      `# ${MODES[lastMode].label}\n\n> Source : ${lastSourceName}\n\n> ${DISCLAIMER_RESULT}\n\n${lastResult}\n`,
      'text/markdown'
    );
  };
  $('#a-chat').onclick = () => {
    history.push(
      { role: 'user', hidden: true, display: '', content: `Voici l'analyse (« ${MODES[lastMode].label} ») que tu as produite sur : ${lastSourceName}. Je vais te poser des questions dessus.` },
      { role: 'assistant', display: lastResult, content: lastResult },
    );
    addMsg('assistant', lastResult);
    showView('chat');
  };

  /* ═════════════ Onglet HTML (rédaction + aperçu + code) ═════════════ */
  const hType = $('#h-type'), hQ = $('#h-q'), hEdit = $('#h-edit'), hSel = $('#h-sel');
  const hRun = $('#h-run'), hStatus = $('#h-status'), hSrc = $('#h-src'), hFrame = $('#h-frame');
  const hWidth = $('#h-width'), hJs = $('#h-js'), hPreview = $('#h-preview'), hCode = $('#h-code');
  let htmlBusy = false;

  const FENCE = '`'.repeat(3);

  const HTML_SYS =
    "Tu es un développeur front-end expert. Tu réponds UNIQUEMENT avec le code HTML demandé, dans un seul bloc de code " + FENCE + "html, sans aucune explication avant ou après. " +
    "Le CSS est placé dans une balise <style>. N'utilise aucune ressource externe (CDN, polices ou images distantes): " + // ajoutable à la fin pour cas très spécifique "sauf demande explicite" 
    "pour les images, utilise des aplats de couleur, des emojis ou des SVG inline. Le texte visible est rédigé en français sauf demande contraire. " +
    "Le code doit être propre, indenté, sémantique et accessible (attributs alt, labels, contrastes).";
  const HTML_TYPES = {
    page: "Produis un document HTML5 complet (<!DOCTYPE html>, <html lang=\"fr\">, meta charset et viewport), responsive. JavaScript uniquement si nécessaire, dans une balise <script> inline.",
    section: "Produis une section ou un composant autonome, avec son CSS dans une balise <style> placée en tête, et des noms de classes préfixés pour éviter les collisions. Pas de JavaScript sauf nécessité.",
    email: "Produis un email HTML compatible avec les clients de messagerie (Outlook, Gmail) : mise en page en <table>, styles inline, largeur maximale 600px, pas de JavaScript, pas de flex ni de grid, images avec alt, width et height, et un texte de pré-en-tête masqué.",
    form: "Produis un formulaire HTML accessible : labels liés aux champs, regroupements <fieldset>/<legend>, validation native (required, type, pattern), messages clairs. Pas de JavaScript sauf nécessité.",
  };

  /** Extrait le code HTML d'une réponse (tolère le streaming : bloc non fermé, <think> en cours). */
  function extractHtml(text) {
    const t = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
    const m = t.match(/```[\w-]*\n([\s\S]*?)(?:```|$)/);
    if (m) return m[1].replace(/\s+$/, '');
    return t.trim();
  }

  let previewTimer;
  function updatePreview() {
    hFrame.setAttribute('sandbox', hJs.checked ? 'allow-scripts' : '');
    // Pas de srcdoc tant qu'il n'y a pas de code : aucun document chargé inutilement sur les pages visitées
    if (hSrc.value.trim()) hFrame.srcdoc = hSrc.value;
    else hFrame.removeAttribute('srcdoc');
  }
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 300); }

  function showSub(name) {
    root.querySelectorAll('.subtabs button').forEach((b) => b.classList.toggle('on', b.dataset.sub === name));
    hPreview.hidden = name !== 'preview';
    hCode.hidden = name !== 'code';
  }
  root.querySelectorAll('.subtabs button').forEach((b) => (b.onclick = () => showSub(b.dataset.sub)));

  /** Charge du code dans l'onglet HTML (bouton « Aperçu » des blocs de code du chat). */
  function loadHtml(code) {
    hSrc.value = code;
    openPanel(); showView('html'); showSub('preview');
    hStatus.textContent = 'Code chargé depuis la conversation.';
    updatePreview();
  }

  hSrc.addEventListener('input', schedulePreview);
  hJs.onchange = updatePreview;
  hWidth.onchange = () => { hFrame.style.width = hWidth.value; };
  hFrame.style.width = '100%';

  $('#h-copy').onclick = () => {
    GM_setClipboard(hSrc.value, 'text');
    hStatus.textContent = '✓ Code copié dans le presse-papiers.';
  };
  $('#h-dl').onclick = () => downloadText(`page-${new Date().toISOString().slice(0, 10)}.html`, hSrc.value, 'text/html');
  $('#h-clear').onclick = () => { hSrc.value = ''; hStatus.textContent = ''; updatePreview(); };

  async function runHtml() {
    if (htmlBusy) { abortAll(); return; }
    const q = hQ.value.trim();
    const sel = hSel.checked ? lastSel : '';
    const current = hSrc.value.trim();
    const editing = hEdit.checked && !!current;
    if (!q && !sel) { hStatus.textContent = '✗ Décrivez ce que vous voulez générer.'; return; }
    if (hSel.checked && !sel) { hStatus.textContent = '✗ Aucune sélection sur la page.'; return; }

    let user = '';
    if (sel) user += `Contenu de départ (à intégrer) :\n"""\n${sel}\n"""\n\n`;
    if (editing) user += `Code HTML actuel :\n${FENCE}html\n${current}\n${FENCE}\n\nModifie ce code selon la consigne et renvoie le document complet mis à jour.\n\n`;
    user += `Consigne : ${q || 'Mets en forme ce contenu.'}`;

    htmlBusy = true;
    hRun.textContent = 'Arrêter'; hRun.classList.add('stop');
    hStatus.textContent = 'Génération en cours…';
    showSub('preview');
    let acc = '';
    try {
      await chatStream([
        { role: 'system', content: `${cfg.systemPrompt}\n\n${HTML_SYS}\n${HTML_TYPES[hType.value]}` },
        { role: 'user', content: user },
      ], (tok) => { acc += tok; hSrc.value = extractHtml(acc); schedulePreview(); }, 0.2);
      hSrc.value = extractHtml(acc);
      updatePreview();
      hStatus.textContent = 'Terminé. Vérifiez le code avant de l\'utiliser (onglet Code pour copier).';
    } catch (e) {
      hStatus.textContent = e.aborted ? 'Génération arrêtée.' : '✗ ' + e.message;
      if (acc) { hSrc.value = extractHtml(acc); updatePreview(); }
    } finally {
      htmlBusy = false;
      hRun.textContent = 'Générer'; hRun.classList.remove('stop');
    }
  }
  hRun.onclick = runHtml;

  /* ═════════════ Paramètres ═════════════ danger zone risque de casse (chiant à débug reste simpliste) */
  const sUrl = $('#s-url'), sKey = $('#s-key'), sModel = $('#s-model'), sTemp = $('#s-temp'), sSys = $('#s-sys'),
        sChunk = $('#s-chunk'), sConc = $('#s-conc'), sRed = $('#s-red'), sAtt = $('#s-att'), sStatus = $('#s-status');

  function setModelOptions(list, selected) {
    sModel.innerHTML = '';
    (list.includes(selected) ? list : [selected, ...list]).forEach((m) => {
      const o = document.createElement('option'); o.value = o.textContent = m; o.selected = m === selected; sModel.appendChild(o);
    });
  }

  function fillSettings() {
    sUrl.value = cfg.baseUrl; sKey.value = cfg.apiKey; sTemp.value = cfg.temperature; sSys.value = cfg.systemPrompt;
    sChunk.value = cfg.chunkChars; sConc.value = cfg.concurrency; sRed.value = cfg.reduceMax; sAtt.value = cfg.attachMax;
    setModelOptions(GM_getValue('modelList', [cfg.model]), cfg.model);
  }

  function saveSettings() {
    GM_setValue('baseUrl', sUrl.value.trim() || DEFAULTS.baseUrl);
    GM_setValue('apiKey', sKey.value.trim());
    GM_setValue('model', sModel.value || DEFAULTS.model);
    GM_setValue('temperature', parseFloat(sTemp.value) || DEFAULTS.temperature);
    GM_setValue('systemPrompt', sSys.value.trim() || DEFAULTS.systemPrompt);
    GM_setValue('chunkChars', parseInt(sChunk.value, 10) || DEFAULTS.chunkChars);
    GM_setValue('concurrency', Math.min(8, parseInt(sConc.value, 10) || DEFAULTS.concurrency));
    GM_setValue('reduceMax', parseInt(sRed.value, 10) || DEFAULTS.reduceMax);
    GM_setValue('attachMax', parseInt(sAtt.value, 10) || DEFAULTS.attachMaxChars);
    sStatus.textContent = 'Paramètres enregistrés.';
  }

  $('#s-save').onclick = saveSettings;
  $('#s-layout').onclick = () => { resetLayout(); sStatus.textContent = 'Position et taille réinitialisées.'; };
  $('#s-refresh').onclick = async () => {
    saveSettings(); sStatus.textContent = 'Chargement des modèles…';
    try {
      const list = await listModels();
      GM_setValue('modelList', list); setModelOptions(list, cfg.model);
      sStatus.textContent = `${list.length} modèle(s) disponible(s).`;
    } catch (e) { sStatus.textContent = '✗ ' + e.message; }
  };
  $('#s-test').onclick = async () => {
    saveSettings(); sStatus.textContent = 'Test en cours…';
    let acc = '';
    try {
      await chatStream([{ role: 'user', content: 'Bonjour' }], (t) => (acc += t));
      sStatus.textContent = 'Connexion OK — réponse : ' + acc.slice(0, 80);
    } catch (e) { sStatus.textContent = '✗ ' + e.message; }
  };

  /* ═════════════ Export / import ═════════════ */
  const FORMAT_ID = APP.id;
  const FORMAT_VERSION = 1;
  const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

  function exportJson(type, data, baseName) {
    const payload = { app: FORMAT_ID, version: FORMAT_VERSION, type, exportedAt: new Date().toISOString(), ...data };
    downloadText(`${baseName}-${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  /** Vérifie qu'un objet JSON est bien un export de cet assistant du bon type. */
  function validateExport(obj, allowedTypes) {
    if (!obj || typeof obj !== 'object' || obj.app !== FORMAT_ID) throw new Error("Ce fichier n'a pas été exporté par (" + APP.name + ").");
    if (typeof obj.version !== 'number' || obj.version > FORMAT_VERSION) throw new Error("Version d'export non prise en charge (mettez le script à jour)."); // à voir plus tard pour le versionning exacte principe de non régression à appliquer
    if (!allowedTypes.includes(obj.type)) throw new Error(`Ce fichier contient « ${obj.type} », or ce bouton attend : ${allowedTypes.join(' ou ')}.`);
    return obj;
  }

  async function readExport(file, allowedTypes) {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Fichier trop volumineux (maximum 20 Mo).');
    const { text } = await readFile(file);
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error('Fichier JSON invalide.'); }
    return validateExport(obj, allowedTypes);
  }

  const dateLabel = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('fr-FR'); };

  /** Nettoie une liste de messages importée : rôles user / assistant uniquement, textes bornés. */
  function cleanMessages(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const m of arr.slice(0, 500)) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const content = str(m.content);
      if (!content) continue;
      const atts = Array.isArray(m.atts) ? m.atts.slice(0, 50).map((a) => ({ name: str(a && a.name, 200), chars: Number(a && a.chars) || 0 })) : [];
      out.push({ role: m.role, content, display: m.hidden ? '' : (str(m.display) || content), atts, hidden: !!m.hidden });
    }
    return out;
  }

  /* ── Conversation ── */
  const chatPayload = () => ({
    title: document.title || location.hostname,
    model: cfg.model,
    messages: history.map((h) => ({ role: h.role, content: h.content, display: h.display, atts: h.atts || [], hidden: !!h.hidden })),
  });

  function chatToMarkdown(msgs, meta) {
    const out = [
      `# Conversation — ${meta.title}`, '',
      `> Exportée le ${new Date().toLocaleString('fr-FR')} · modèle : ${meta.model}`, '',
      `> ${DISCLAIMER_SHORT}`, '',
    ];
    msgs.filter((m) => !m.hidden).forEach((m) => out.push(m.role === 'user' ? '## Vous' : '## Assistant', '', m.display || m.content, ''));
    return out.join('\n');
  }

  function restoreChat(messages) { // sécu d'import 
    if (busy) throw new Error("Une réponse est en cours : attendez la fin ou arrêtez-la avant d'importer.");
    history = messages;
    msgsEl.textContent = '';
    history.filter((h) => !h.hidden).forEach((h) => addMsg(h.role, h.display));
  }

  $('#c-exp-json').onclick = () => { // getsion export 
    if (!history.length) return void addMsg('error', 'Rien à exporter : la conversation est vide.');
    exportJson('chat', chatPayload(), 'conversation');
  };
  $('#c-exp-md').onclick = () => {
    if (!history.length) return void addMsg('error', 'Rien à exporter : la conversation est vide.');
    downloadText(`conversation-${stamp()}.md`, chatToMarkdown(history, { title: document.title || location.hostname, model: cfg.model }), 'text/markdown');
  };
  $('#c-imp').onclick = async () => {
    const [file] = await pickFiles({ accept: '.json,application/json' });
    if (!file) return;
    try {
      const obj = await readExport(file, ['chat', 'workspace']);
      const msgs = cleanMessages(obj.type === 'chat' ? obj.messages : (obj.chat && obj.chat.messages));
      if (!msgs.length) throw new Error('Aucune conversation dans ce fichier.');
      if (history.length && !confirm('Remplacer la conversation en cours par celle du fichier ?')) return;
      restoreChat(msgs);
      showView('chat');
    } catch (e) { addMsg('error', 'Import impossible : ' + e.message); }
  };

  /* ── Analyse ── */
  const analysisPayload = () => ({ mode: lastMode, modeLabel: MODES[lastMode].label, question: lastQuestion, source: lastSourceName, result: lastResult });
  const analysisFrom = (a) => ((a && str(a.result)) ? { mode: a.mode, question: str(a.question, 5000), source: str(a.source, 500), result: str(a.result) } : null);

  function showAnalysis({ mode, question, source, result }, note) {
    if (analysing) throw new Error("Une analyse est en cours : arrêtez-la avant d'importer.");
    lastMode = MODES[mode] ? mode : 'synthese';
    lastQuestion = question || '';
    lastSourceName = source || '';
    lastResult = result;
    aMode.value = lastMode; aQ.value = lastQuestion;
    aOut.hidden = false; renderInto(aOut, lastResult);
    aActions.hidden = false; aWarn.hidden = false;
    aBar.style.width = '100%';
    aStatus.textContent = note;
  }

  $('#a-dl-json').onclick = () => {
    if (!lastResult) { aStatus.textContent = '✗ Aucune analyse à exporter.'; return; }
    exportJson('analysis', analysisPayload(), 'analyse');
  };
  $('#a-imp').onclick = async () => {
    if (analysing) { aStatus.textContent = "✗ Une analyse est en cours : arrêtez-la avant d'importer."; return; }
    const [file] = await pickFiles({ accept: '.json,.md,.txt,application/json,text/*' });
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        const obj = await readExport(file, ['analysis', 'workspace']);
        const a = analysisFrom(obj.type === 'analysis' ? obj : obj.analysis);
        if (!a) throw new Error('Aucune analyse dans ce fichier.');
        const d = dateLabel(obj.exportedAt);
        showAnalysis(a, `Analyse importée${d ? ' (exportée le ' + d + ')' : ''}.`);
      } else {
        const { text } = await readTextFile(file);
        if (!text.trim()) throw new Error('Fichier vide.');
        showAnalysis({ mode: aMode.value, question: '', source: file.name, result: text }, `Texte importé : ${file.name}.`);
      }
    } catch (e) { aStatus.textContent = '✗ Import impossible : ' + e.message; }
  };

  /* ── HTML ── */
  const htmlPayload = () => ({ htmlType: hType.value, instructions: hQ.value.trim(), code: hSrc.value });
  function applyHtml(h) {
    if (htmlBusy) throw new Error('Une génération HTML est en cours : arrêtez-la avant d’importer.');
    if (HTML_TYPES[h.htmlType]) hType.value = h.htmlType;
    hQ.value = str(h.instructions, 5000);
    hSrc.value = str(h.code);
    showSub('preview');
    updatePreview();
  }

  $('#h-dl-json').onclick = () => {
    if (!hSrc.value.trim()) { hStatus.textContent = '✗ Aucun code à exporter.'; return; }
    exportJson('html', htmlPayload(), 'html');
  };
  $('#h-imp').onclick = async () => {
    const [file] = await pickFiles({ accept: '.html,.htm,.json,.txt,text/html,application/json' });
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        const obj = await readExport(file, ['html', 'workspace']);
        const h = obj.type === 'html' ? obj : obj.html;
        if (!h || !str(h.code)) throw new Error('Aucun code HTML dans ce fichier.');
        applyHtml(h);
        hStatus.textContent = 'Code HTML importé.';
      } else {
        const { text } = await readTextFile(file);
        if (!text.trim()) throw new Error('Fichier vide.');
        applyHtml({ htmlType: hType.value, instructions: hQ.value, code: text });
        hStatus.textContent = `Fichier importé : ${file.name}.`;
      }
    } catch (e) { hStatus.textContent = '✗ Import impossible : ' + e.message; }
  };

  /* ── Sauvegarde complète ── */
  const settingsPayload = () => ({
    model: cfg.model, temperature: cfg.temperature, systemPrompt: cfg.systemPrompt,
    chunkChars: cfg.chunkChars, concurrency: cfg.concurrency, reduceMax: cfg.reduceMax, attachMax: cfg.attachMax,
  });

  /** Applique des réglages importés après validation. Ne touche jamais à la clé ni à l'endpoint. Retourne le nombre de réglages appliqués. */
  function applySettings(st) {
    if (!st || typeof st !== 'object') return 0;
    let n = 0;
    const set = (k, v) => { GM_setValue(k, v); n++; };
    if (typeof st.model === 'string' && st.model.trim()) set('model', st.model.trim().slice(0, 200));
    const t = Number(st.temperature);
    if (st.temperature !== null && st.temperature !== '' && isFinite(t) && t >= 0 && t <= 2) set('temperature', t);
    if (typeof st.systemPrompt === 'string' && st.systemPrompt.trim()) set('systemPrompt', st.systemPrompt.trim().slice(0, 5000));
    [['chunkChars', 2000, 200000], ['concurrency', 1, 8], ['reduceMax', 4000, 400000], ['attachMax', 5000, 1000000]].forEach(([k, min, max]) => {
      const x = parseInt(st[k], 10);
      if (isFinite(x) && x >= min && x <= max) set(k, x);
    });
    return n;
  }

  $('#b-exp').onclick = () => {
    exportJson('workspace', {
      chat: history.length ? chatPayload() : null,
      analysis: lastResult ? analysisPayload() : null,
      html: hSrc.value.trim() ? htmlPayload() : null,
      settings: settingsPayload(),
    }, APP.id + '-sauvegarde');
    sStatus.textContent = 'Sauvegarde exportée (sans clé privée ni endpoint).'; // évite les confilts et risques de sécu en cas de changement d'endpoint ou de model ou de clé api
  };
  $('#b-imp').onclick = async () => {
    const [file] = await pickFiles({ accept: '.json,application/json' });
    if (!file) return;
    try {
      const obj = await readExport(file, ['workspace']);
      const done = [];
      const msgs = cleanMessages(obj.chat && obj.chat.messages);
      if (msgs.length && (!history.length || confirm('Remplacer la conversation en cours par celle de la sauvegarde ?'))) {
        restoreChat(msgs); done.push(`conversation (${msgs.length} messages)`);
      }
      const a = analysisFrom(obj.analysis);
      if (a) { showAnalysis(a, 'Analyse importée depuis la sauvegarde.'); done.push('analyse'); }
      if (obj.html && str(obj.html.code)) { applyHtml(obj.html); done.push('code HTML'); }
      if ($('#b-settings').checked && applySettings(obj.settings)) { fillSettings(); done.push('réglages'); }
      sStatus.textContent = done.length ? 'Importé : ' + done.join(', ') + '.' : 'Rien à importer dans ce fichier.';
    } catch (e) { sStatus.textContent = '✗ Import impossible : ' + e.message; }
  };

  /* ═════════════ Global ═════════════ */
  function setOpen(v) {
    const was = panel.classList.contains('open');
    panel.classList.toggle('open', v);
    if (v && !was) {
      placePanel();
      if (currentView === 'chat') input.focus();
    }
  }
  function openPanel() { setOpen(true); }
  function togglePanel() { setOpen(!panel.classList.contains('open')); }

  fab.onclick = () => {
    if (fabDrag.moved()) return; // un glisser ne doit pas ouvrir/fermer la fenêtre
    togglePanel();
  };
  root.querySelectorAll('header [data-act]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'close') setOpen(false);
      if (a === 'clear') { history = []; msgsEl.innerHTML = ''; }
      if (a === 'settings') showView(currentView === 'settings' ? previousView : 'settings');
    };
  });

  // racourcis customs : Alt+L : ouvrir/fermer · Alt+Shift+L : expliquer la sélection
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyL') {
      e.preventDefault();
      if (e.shiftKey && getLiveSelection()) quick('explain'); else togglePanel();
    }
  });

  GM_registerMenuCommand('Ouvrir / fermer l’assistant', togglePanel);
  GM_registerMenuCommand('Analyser cette page', () => { openPanel(); aSrc.value = 'page'; showView('analyse'); });
  GM_registerMenuCommand('Rédiger du HTML', () => { openPanel(); showView('html'); });
  GM_registerMenuCommand('Paramètres (endpoint, clé, modèle)', () => { openPanel(); showView('settings'); });
  GM_registerMenuCommand('Réinitialiser position et taille', resetLayout);

  if (!cfg.apiKey) addMsg('assistant', "Bienvenue ! Ouvrez ⚙ pour coller votre clé privée, puis testez la connexion.");
})();
