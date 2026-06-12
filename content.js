/* LinkedIn Invitation Withdrawer — content script
 * Injects a side panel on the "Sent invitations" page.
 * Lets you scan pending invitations, pick which to withdraw, and process
 * them one-by-one with randomized, human-like timing so the activity does
 * not look like a burst of bot clicks.
 *
 * Nothing here talks to any server. Everything runs locally in your browser
 * against the page you are already logged into.
 */
(() => {
  "use strict";

  if (window.__liWithdrawLoaded) return;
  window.__liWithdrawLoaded = true;

  // ---- tunables (also editable from the panel) -------------------------
  const DEFAULTS = {
    minDelayMs: 4000, // min wait between two withdrawals
    maxDelayMs: 9000, // max wait between two withdrawals
    longRestEvery: 8, // after this many withdrawals, take a longer break
    longRestMinMs: 20000,
    longRestMaxMs: 45000,
    maxPerSession: 40, // hard cap to stay under the radar
  };

  let cfg = { ...DEFAULTS };
  let scanned = []; // [{ id, name, sentText, cardEl, btnEl, selected }]
  let running = false;
  let stopRequested = false;

  // ---- small helpers ---------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const jitter = (ms, pct = 0.25) =>
    Math.max(0, Math.round(ms * (1 + (Math.random() * 2 - 1) * pct)));

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Turn "Sent 3 weeks ago" / "Sent 2 months ago" / "Sent yesterday" into an
  // approximate age in days, so we can filter by how old an invitation is.
  function parseAgeDays(sentText) {
    const t = (sentText || "").toLowerCase();
    if (/yesterday/.test(t)) return 1;
    if (/just now|moment|second|minute|hour/.test(t)) return 0;
    const m = t.match(/(\d+)\s*(day|week|month|year)/);
    if (!m) return /(\btoday\b)/.test(t) ? 0 : null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = { day: 1, week: 7, month: 30, year: 365 }[unit] || 0;
    return n * mult;
  }

  // Find the inline "Withdraw" buttons. LinkedIn class names are hashed and
  // change often, so we key off the visible label / aria-label which is far
  // more stable than any CSS selector.
  function findWithdrawButtons() {
    const out = [];
    // The withdraw control is sometimes a <button>, sometimes an <a> (no
    // role="button"). Match on aria-label / visible text, not CSS classes.
    const candidates = document.querySelectorAll(
      "button, a[role='button'], a[aria-label], a[href]"
    );
    const seen = new Set();
    for (const b of candidates) {
      const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
      const text = norm(b.textContent || "").toLowerCase();
      const isWithdraw =
        /^withdraw invitation/.test(aria) ||
        aria === "withdraw" ||
        text === "withdraw";
      if (!isWithdraw) continue;
      if (b.closest("[role='dialog']")) continue; // skip confirm-dialog button
      if (seen.has(b)) continue;
      seen.add(b);
      out.push(b);
    }
    return out;
  }

  // Walk up from a withdraw button to the card container, then pull the
  // person's name and the "Sent ... ago" text out of it.
  function cardInfoFromButton(btn) {
    const card =
      btn.closest("[role='listitem']") ||
      btn.closest("li") ||
      btn.closest("[componentkey]") ||
      btn.parentElement;

    let name = "";
    // Most reliable: the withdraw aria-label is "Withdraw invitation sent to <name>"
    const al = norm(btn.getAttribute("aria-label"));
    const m = al.match(/sent to (.+)$/i);
    if (m) name = m[1].trim();

    // Fallback: the profile link's accessible name, then the name <p>.
    if (!name && card) {
      const link = card.querySelector("a[href*='/in/']");
      if (link) {
        const imgAlt = link.querySelector("img[alt]");
        if (imgAlt) {
          name = norm(imgAlt.getAttribute("alt"))
            .replace(/['’]s profile picture$/i, "")
            .replace(/,?\s*open to work.*$/i, "")
            .trim();
        }
        if (!name) name = norm(link.textContent);
      }
    }
    name = name || "(unknown)";

    let sentText = "";
    if (card) {
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = norm(n.nodeValue);
        if (/sent\b/i.test(t) && /(ago|on |week|day|month|year|hour|minute)/i.test(t)) {
          sentText = t;
          break;
        }
      }
    }
    sentText = sentText || "—";

    return { name, sentText, card, btn };
  }

  function scan() {
    const seen = new Set();
    const list = [];
    findWithdrawButtons().forEach((btn, i) => {
      const info = cardInfoFromButton(btn);
      const id = "inv_" + i + "_" + info.name.replace(/\W+/g, "").slice(0, 20);
      if (seen.has(btn)) return;
      seen.add(btn);
      list.push({
        id,
        name: info.name,
        sentText: info.sentText,
        ageDays: parseAgeDays(info.sentText),
        cardEl: info.card,
        btnEl: info.btn,
        selected: false,
      });
    });
    scanned = list;
    renderRows();
    setStatus(
      list.length
        ? `Found ${list.length} pending invitation(s) on this view.`
        : "No invitations found. Scroll/paginate the page, then Scan again."
    );
  }

  // ---- human-like clicking --------------------------------------------
  // Dispatch a realistic pointer/mouse sequence at a slightly randomized
  // point inside the element, after scrolling it into view.
  async function humanClick(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(rand(500, 1200));

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mousemove", base));
    await sleep(rand(60, 200));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    await sleep(rand(50, 160));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  }

  // After clicking the inline "Withdraw", a confirmation popup appears. It is
  // NOT a role="dialog" — it's identified by a Cancel + Withdraw button pair.
  // The confirm control is a <button> (the inline trigger was an <a>) carrying
  // aria-label="Withdraw invitation sent to <name>".
  function findConfirmButton(expectedName) {
    const buttons = Array.from(document.querySelectorAll("button"));
    let fallback = null;
    for (const b of buttons) {
      const txt = norm(b.textContent).toLowerCase();
      const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
      const looksWithdraw = txt === "withdraw" || /^withdraw invitation/.test(aria);
      if (!looksWithdraw) continue;

      // Confirm popup = a Withdraw button that sits next to a Cancel button.
      let p = b;
      let paired = false;
      for (let i = 0; i < 5 && p; i++) {
        p = p.parentElement;
        if (
          p &&
          Array.from(p.querySelectorAll("button")).some(
            (x) => norm(x.textContent).toLowerCase() === "cancel"
          )
        ) {
          paired = true;
          break;
        }
      }
      if (!paired) continue;

      // If we know who we're withdrawing, prefer the exact name match.
      if (expectedName && aria.includes(expectedName.toLowerCase())) return b;
      fallback = fallback || b;
    }
    return fallback;
  }

  async function confirmWithdraw(expectedName) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const btn = findConfirmButton(expectedName);
      if (btn) {
        await sleep(rand(400, 1100));
        await humanClick(btn);
        return true;
      }
      await sleep(250);
    }
    return false; // no popup appeared — nothing to confirm
  }

  async function process() {
    if (running) return;
    const targets = scanned.filter((s) => s.selected);
    if (!targets.length) {
      setStatus("Nothing selected. Tick some rows first.");
      return;
    }
    if (targets.length > cfg.maxPerSession) {
      setStatus(
        `Selected ${targets.length}, capped at ${cfg.maxPerSession} this session for safety. Processing first ${cfg.maxPerSession}.`
      );
    }

    running = true;
    stopRequested = false;
    setRunningUI(true);

    const queue = targets.slice(0, cfg.maxPerSession);
    let done = 0;

    for (let i = 0; i < queue.length; i++) {
      if (stopRequested) {
        setStatus(`Stopped. Withdrew ${done} of ${queue.length}.`);
        break;
      }
      const item = queue[i];
      markRow(item.id, "working");
      setStatus(`Withdrawing ${i + 1}/${queue.length}: ${item.name}…`);

      try {
        if (!document.body.contains(item.btnEl)) {
          markRow(item.id, "error");
          continue;
        }
        await humanClick(item.btnEl);
        await sleep(rand(700, 1600));
        await confirmWithdraw(item.name);
        await sleep(rand(800, 1800));
        markRow(item.id, "done");
        done++;
      } catch (e) {
        console.error("[LI Withdrawer]", e);
        markRow(item.id, "error");
      }

      // pause between actions (skip the wait after the last one)
      if (i < queue.length - 1 && !stopRequested) {
        let wait = rand(cfg.minDelayMs, cfg.maxDelayMs);
        if ((done > 0) && done % cfg.longRestEvery === 0) {
          wait = rand(cfg.longRestMinMs, cfg.longRestMaxMs);
          setStatus(`Taking a longer break (${Math.round(wait / 1000)}s) to look human…`);
        }
        await countdown(wait);
      }
    }

    running = false;
    setRunningUI(false);
    if (!stopRequested) setStatus(`Done. Withdrew ${done} invitation(s).`);
  }

  async function countdown(ms) {
    const statusEl = panel.querySelector("#liw-status");
    const end = Date.now() + ms;
    while (Date.now() < end && !stopRequested) {
      const left = Math.ceil((end - Date.now()) / 1000);
      if (statusEl && !/Withdrawing|break/.test(statusEl.textContent)) {
        statusEl.textContent = `Waiting ${left}s before next…`;
      } else if (statusEl) {
        // keep existing message but append countdown
      }
      await sleep(300);
    }
  }

  // ---- panel UI --------------------------------------------------------
  let panel;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "liw-panel";
    panel.innerHTML = `
      <div id="liw-header">
        <span id="liw-title">Invitation Withdrawer</span>
        <button id="liw-collapse" title="Collapse">–</button>
      </div>
      <div id="liw-body">
        <div id="liw-controls">
          <button id="liw-scan" class="liw-btn">Scan page</button>
          <button id="liw-process" class="liw-btn liw-primary">Process selected</button>
          <button id="liw-stop" class="liw-btn liw-danger" disabled>Stop</button>
        </div>
        <div id="liw-filters">
          <span class="liw-filter-label">Select older than:</span>
          <button class="liw-chip" data-days="7">1 week</button>
          <button class="liw-chip" data-days="14">2 weeks</button>
          <button class="liw-chip" data-days="21">3 weeks</button>
          <button class="liw-chip" data-days="30">1 month</button>
          <button class="liw-chip" data-days="60">2 months</button>
          <button class="liw-chip" data-days="90">3 months</button>
          <button class="liw-chip" data-days="150">5 months</button>
        </div>
        <div id="liw-select-row">
          <label><input type="checkbox" id="liw-all"> Select all</label>
          <span id="liw-count">0 selected</span>
        </div>
        <div id="liw-status">Click “Scan page” to load invitations.</div>
        <div id="liw-list"></div>
        <details id="liw-settings">
          <summary>Timing settings</summary>
          <label>Min delay (s) <input type="number" id="liw-min" value="${cfg.minDelayMs / 1000}" min="1" step="1"></label>
          <label>Max delay (s) <input type="number" id="liw-max" value="${cfg.maxDelayMs / 1000}" min="1" step="1"></label>
          <label>Long break every <input type="number" id="liw-every" value="${cfg.longRestEvery}" min="2" step="1"></label>
          <label>Max per session <input type="number" id="liw-cap" value="${cfg.maxPerSession}" min="1" step="1"></label>
        </details>
        <p id="liw-note">Tip: LinkedIn paginates this page. Scan, process, go to the next page, then Scan again.</p>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#liw-scan").addEventListener("click", scan);
    panel.querySelector("#liw-process").addEventListener("click", process);
    panel.querySelector("#liw-stop").addEventListener("click", () => {
      stopRequested = true;
      setStatus("Stopping after current item…");
    });
    panel.querySelector("#liw-all").addEventListener("change", (e) => {
      scanned.forEach((s) => (s.selected = e.target.checked));
      renderRows();
    });
    panel.querySelectorAll(".liw-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const threshold = parseInt(chip.dataset.days, 10); // days
        let n = 0;
        scanned.forEach((s) => {
          const old = s.ageDays != null && s.ageDays >= threshold;
          s.selected = old;
          if (old) n++;
        });
        renderRows();
        const all = panel.querySelector("#liw-all");
        if (all) all.checked = scanned.length > 0 && n === scanned.length;
        setStatus(`Selected ${n} invitation(s) ${chip.textContent} old or older.`);
      });
    });
    panel.querySelector("#liw-collapse").addEventListener("click", () => {
      panel.classList.toggle("liw-collapsed");
    });

    const bind = (id, key, mult = 1) =>
      panel.querySelector(id).addEventListener("change", (e) => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) cfg[key] = v * mult;
        saveCfg();
      });
    bind("#liw-min", "minDelayMs", 1000);
    bind("#liw-max", "maxDelayMs", 1000);
    bind("#liw-every", "longRestEvery", 1);
    bind("#liw-cap", "maxPerSession", 1);
  }

  function renderRows() {
    const listEl = panel.querySelector("#liw-list");
    listEl.innerHTML = "";
    scanned.forEach((s) => {
      const row = document.createElement("label");
      row.className = "liw-row";
      row.dataset.id = s.id;
      row.innerHTML = `
        <input type="checkbox" ${s.selected ? "checked" : ""}>
        <span class="liw-name"></span>
        <span class="liw-sent"></span>
        <span class="liw-state"></span>
      `;
      row.querySelector(".liw-name").textContent = s.name;
      row.querySelector(".liw-sent").textContent = s.sentText;
      row.querySelector("input").addEventListener("change", (e) => {
        s.selected = e.target.checked;
        updateCount();
      });
      // hover highlights the actual card on the page
      row.addEventListener("mouseenter", () => {
        if (s.cardEl) s.cardEl.style.outline = "2px solid #0a66c2";
      });
      row.addEventListener("mouseleave", () => {
        if (s.cardEl) s.cardEl.style.outline = "";
      });
      listEl.appendChild(row);
    });
    updateCount();
  }

  function updateCount() {
    const n = scanned.filter((s) => s.selected).length;
    panel.querySelector("#liw-count").textContent = `${n} selected`;
  }

  function markRow(id, state) {
    const row = panel.querySelector(`.liw-row[data-id="${id}"]`);
    if (!row) return;
    const el = row.querySelector(".liw-state");
    const map = { working: "⏳", done: "✓", error: "⚠" };
    el.textContent = map[state] || "";
    row.className = "liw-row liw-" + state;
  }

  function setStatus(msg) {
    const el = panel.querySelector("#liw-status");
    if (el) el.textContent = msg;
  }

  function setRunningUI(on) {
    panel.querySelector("#liw-process").disabled = on;
    panel.querySelector("#liw-scan").disabled = on;
    panel.querySelector("#liw-stop").disabled = !on;
  }

  // ---- config persistence ---------------------------------------------
  function saveCfg() {
    try {
      chrome.storage?.local.set({ liwCfg: cfg });
    } catch (_) {}
  }
  function loadCfg(cb) {
    try {
      chrome.storage?.local.get("liwCfg", (r) => {
        if (r && r.liwCfg) cfg = { ...DEFAULTS, ...r.liwCfg };
        cb();
      });
    } catch (_) {
      cb();
    }
  }

  // ---- boot ------------------------------------------------------------
  loadCfg(() => {
    buildPanel();
  });
})();
