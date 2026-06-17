/* LinkedIn Connections Exporter & Remover — content script
 * Injects a panel on the Connections page. Click Start and it auto-scrolls the
 * whole list (which is virtualized — rows are recycled as you scroll), harvesting
 * each connection's name, headline, profile link, profile image URL, and
 * "Connected on" date into a de-duplicated set. Export to CSV/Excel.
 *
 * It can also REMOVE selected connections: tick rows, click "Remove selected",
 * and it removes them one-by-one with human-like timing (open the ⋯ menu →
 * Remove connection → confirm), with a per-session cap and a name-match safety
 * check so it can never remove the wrong person. Removal is permanent — the
 * export half stays read-only; only the remove action writes.
 */
(() => {
  "use strict";

  if (window.__liConnExportLoaded) return;
  window.__liConnExportLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const collected = new Map(); // key: profile URL -> row object
  const selected = new Set(); // profile URLs ticked for removal
  let running = false;
  let stopRequested = false;

  const REMOVE_CAP = 40; // max removals per session

  // ---- generic helpers -------------------------------------------------
  // querySelectorAll that pierces open shadow roots (popovers/dialogs may live
  // outside the main tree).
  function deepQueryAll(selector) {
    const out = [];
    const walk = (root) => {
      try {
        root.querySelectorAll(selector).forEach((n) => out.push(n));
      } catch (_) {}
      try {
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      } catch (_) {}
    };
    walk(document);
    return out;
  }

  // Realistic pointer/mouse click at a randomized point inside the element.
  async function humanClick(el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(rand(400, 1000));
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

  async function waitForEl(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      let el = null;
      try {
        el = fn();
      } catch (_) {}
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  function profileLinkOf(row) {
    const a = row.querySelector("a[href*='/in/']");
    return a ? a.href.split("?")[0] : "";
  }

  function nameFromRow(row) {
    const img = row.querySelector("img[alt]");
    const svg = row.querySelector("svg[aria-label]");
    return norm(
      (img && img.getAttribute("alt")) || (svg && svg.getAttribute("aria-label")) || ""
    )
      .replace(/['’]s profile picture.*$/i, "")
      .trim();
  }

  // "June 12, 2026" -> { ts, year } for sorting / year-filtering.
  function parseConnected(connectedOn) {
    if (!connectedOn) return { ts: 0, year: "" };
    const ts = Date.parse(connectedOn) || 0;
    const ym = connectedOn.match(/\b(\d{4})\b/);
    return { ts, year: ym ? ym[1] : "" };
  }

  // ---- scraping --------------------------------------------------------

  // Each connection row is an "auto-component-…" container that holds a /in/
  // profile link and a "Connected on …" line.
  function findRows() {
    const rows = new Set();
    document.querySelectorAll("a[href*='/in/']").forEach((a) => {
      const row = a.closest("[componentkey^='auto-component-']");
      if (row && /connected on/i.test(row.textContent)) rows.add(row);
    });
    return [...rows];
  }

  function extractRow(row) {
    const profileA = row.querySelector("a[href*='/in/']");
    const profileLink = profileA ? profileA.href.split("?")[0] : "";
    if (!profileLink) return null;

    // The name link holds the name <p> then the headline <p>; the avatar link
    // holds only the figure. Pick the link that actually contains text.
    const img = row.querySelector("img[alt]");
    const svg = row.querySelector("svg[aria-label]");
    let name = norm(
      (img && img.getAttribute("alt")) || (svg && svg.getAttribute("aria-label")) || ""
    )
      .replace(/['’]s profile picture.*$/i, "")
      .trim();

    const nameLink = [...row.querySelectorAll("a[href*='/in/']")].find((a) =>
      a.querySelector("p")
    );
    const namePs = nameLink ? [...nameLink.querySelectorAll("p")] : [];
    if (!name && namePs[0]) name = norm(namePs[0].textContent);

    // headline = the 2nd <p> in the name link (1st is the name). Fall back to a
    // single <p> only if it isn't the name.
    let headline = "";
    if (namePs.length >= 2) headline = norm(namePs[1].textContent);
    else if (namePs.length === 1 && norm(namePs[0].textContent) !== name)
      headline = norm(namePs[0].textContent);

    // "Connected on …" is a row-level <p> outside the name link.
    let connectedOn = "";
    row.querySelectorAll("p").forEach((p) => {
      const t = norm(p.textContent);
      if (/^connected on/i.test(t)) connectedOn = t.replace(/^connected on\s*/i, "");
    });

    const imageUrl = img ? img.src : "";

    // profile URN from the Message compose link (stable unique id)
    let urn = "";
    const msg = row.querySelector("a[href*='profileUrn=']");
    if (msg) {
      try {
        urn = new URL(msg.href, location.origin).searchParams.get("profileUrn") || "";
      } catch (_) {}
    }

    const { ts: connectedTs, year: connectedYear } = parseConnected(connectedOn);
    return { name, headline, connectedOn, connectedTs, connectedYear, profileLink, imageUrl, urn };
  }

  function harvest() {
    let added = 0;
    findRows().forEach((row) => {
      const data = extractRow(row);
      if (data && !collected.has(data.profileLink)) {
        collected.set(data.profileLink, data);
        added++;
      } else if (data) {
        // fill in fields that may have been blank earlier
        const prev = collected.get(data.profileLink);
        if (!prev.headline && data.headline) prev.headline = data.headline;
        if (!prev.imageUrl && data.imageUrl) prev.imageUrl = data.imageUrl;
        if (!prev.connectedOn && data.connectedOn) {
          prev.connectedOn = data.connectedOn;
          prev.connectedTs = data.connectedTs;
          prev.connectedYear = data.connectedYear;
        }
      }
    });
    return added;
  }

  // ---- scrolling -------------------------------------------------------
  // The list scrolls inside an inner SDUI container, and which element actually
  // owns the scroll varies. So gather every plausible scroller and drive them
  // all — whichever really scrolls will move.
  function getScrollers() {
    const out = [];
    const add = (el) => {
      if (el && !out.includes(el)) out.push(el);
    };
    add(document.querySelector("#workspace"));
    add(document.querySelector("[data-sdui-screen]"));
    const lazy = document.querySelector(
      "[data-component-type='LazyColumn'], [data-testid='lazy-column']"
    );
    if (lazy) {
      let el = lazy;
      while (el && el !== document.documentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") add(el);
        el = el.parentElement;
      }
    }
    add(document.scrollingElement);
    add(document.documentElement);
    add(document.body);
    return out.filter(Boolean);
  }

  function scrollStep() {
    const amount = Math.round(window.innerHeight * (0.6 + Math.random() * 0.3));
    let moved = false;
    getScrollers().forEach((sc) => {
      const before = sc.scrollTop;
      sc.scrollTop = before + amount;
      if (sc.scrollTop !== before) moved = true;
    });
    window.scrollBy(0, amount);
    // Fallback / reinforcement: bring the last rendered row into view, which
    // forces the virtualized list to render the next batch.
    const rows = findRows();
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      try {
        lastRow.scrollIntoView({ block: "end" });
      } catch (_) {}
    }
    return moved;
  }

  function scrollToBottom() {
    getScrollers().forEach((sc) => {
      try {
        sc.scrollTop = sc.scrollHeight;
      } catch (_) {}
    });
    window.scrollTo(0, document.body.scrollHeight);
    const rows = findRows();
    if (rows.length) {
      try {
        rows[rows.length - 1].scrollIntoView({ block: "end" });
      } catch (_) {}
    }
  }

  function totalFromHeader() {
    const p = [...document.querySelectorAll("p")].find((el) =>
      /[\d,]+\s+connections?/i.test(el.textContent)
    );
    if (!p) return null;
    const m = p.textContent.match(/([\d,]+)\s+connections?/i);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  }

  // ---- the auto-scroll run --------------------------------------------
  async function run() {
    if (running) return;
    running = true;
    stopRequested = false;
    setRunningUI(true);

    const total = totalFromHeader();
    let stable = 0;
    let last = -1;

    harvest();
    setStatus(`Scrolling… captured ${collected.size}${total ? " / " + total : ""}`);

    while (!stopRequested) {
      // human-like scroll: most of a viewport, with jitter
      scrollStep();
      await sleep(rand(650, 1400));
      harvest();
      renderList();
      setStatus(`Scrolling… captured ${collected.size}${total ? " / " + total : ""}`);

      if (total && collected.size >= total) break; // got them all

      if (collected.size === last) {
        stable++;
        // nudge all the way to the bottom to force the next lazy batch
        scrollToBottom();
        await sleep(rand(900, 1800));
        harvest();
        if (collected.size === last && stable >= 5) break; // truly at the end
        // occasional longer rest so it doesn't look like a tight loop
        if (stable % 3 === 0) {
          setStatus(`Pausing briefly… captured ${collected.size}`);
          await sleep(rand(3000, 6000));
        }
      } else {
        stable = 0;
      }
      last = collected.size;
    }

    running = false;
    setRunningUI(false);
    renderList();
    setStatus(
      stopRequested
        ? `Stopped. Captured ${collected.size}. Save as CSV or Excel.`
        : `Done. Captured ${collected.size}. Save as CSV or Excel.`
    );
  }

  // ---- CSV export ------------------------------------------------------
  function csvCell(v) {
    const s = (v == null ? "" : String(v)).replace(/"/g, '""');
    return `"${s}"`;
  }

  function downloadCsv() {
    const rows = viewRows();
    if (!rows.length) {
      setStatus("Nothing to export — capture some connections first.");
      return;
    }
    const header = ["Name", "Headline", "Connected On", "Profile URL", "Image URL", "Profile URN"];
    const lines = [header.map(csvCell).join(",")];
    rows.forEach((r) => {
      lines.push(
        [r.name, r.headline, r.connectedOn, r.profileLink, r.imageUrl, r.urn]
          .map(csvCell)
          .join(",")
      );
    });
    triggerDownload(
      new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }),
      `linkedin-connections-${rows.length}.csv`
    );
    setStatus(`Downloaded CSV (${rows.length} connections).`);
  }

  // Excel (.xls) via an HTML table — Excel opens this natively as a spreadsheet.
  function downloadXls() {
    const data = viewRows();
    if (!data.length) {
      setStatus("Nothing to export — capture some connections first.");
      return;
    }
    const esc = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const headers = ["Name", "Headline", "Connected On", "Profile URL", "Image URL", "Profile URN"];
    let rows = "<tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr>";
    data.forEach((r) => {
      rows +=
        "<tr>" +
        [r.name, r.headline, r.connectedOn, r.profileLink, r.imageUrl, r.urn]
          .map((c) => `<td>${esc(c)}</td>`)
          .join("") +
        "</tr>";
    });
    const doc =
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" ` +
      `xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head>` +
      `<body><table border="1">${rows}</table></body></html>`;
    triggerDownload(
      new Blob([doc], { type: "application/vnd.ms-excel" }),
      `linkedin-connections-${data.length}.xls`
    );
    setStatus(`Downloaded Excel (${data.length} connections).`);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- remove connections (human-paced, permanent) ---------------------
  function scrollToTop() {
    getScrollers().forEach((sc) => {
      try {
        sc.scrollTop = 0;
      } catch (_) {}
    });
    window.scrollTo(0, 0);
  }

  // Remove ONE connection from its live row: ⋯ menu → "Remove connection" →
  // confirm dialog. A name-match check guards against removing the wrong person.
  async function removeOne(row, name) {
    const moreBtn = row.querySelector("button[aria-label*='More actions']");
    if (!moreBtn) throw new Error("no ⋯ menu button");
    await humanClick(moreBtn);

    // popover menu item "Remove connection"
    const item = await waitForEl(
      () =>
        deepQueryAll("[role='menuitem']").find((el) =>
          norm(el.textContent).toLowerCase().includes("remove connection")
        ),
      4000
    );
    if (!item) throw new Error("'Remove connection' menu item not found");
    await sleep(rand(300, 800));
    await humanClick(item);

    // confirmation dialog
    const dialog = await waitForEl(
      () => deepQueryAll("[data-testid='dialog-content'], [role='dialog']")[0],
      5000
    );
    if (!dialog) throw new Error("confirm dialog not found");

    // SAFETY: the dialog says "remove <FirstName> as a connection?" — verify it.
    const firstName = norm(name).split(/\s+/)[0].toLowerCase();
    const dialogText = norm(dialog.textContent).toLowerCase();
    const confirmBtn = [...dialog.querySelectorAll("button")].find(
      (b) => norm(b.textContent).toLowerCase() === "remove connection"
    );
    const cancelBtn = [...dialog.querySelectorAll("button")].find(
      (b) => norm(b.textContent).toLowerCase() === "cancel"
    );
    if (firstName && dialogText && !dialogText.includes(firstName)) {
      if (cancelBtn) cancelBtn.click();
      throw new Error("dialog name mismatch — skipped for safety");
    }
    if (!confirmBtn) throw new Error("confirm button not found");
    await sleep(rand(400, 1000));
    await humanClick(confirmBtn);
    await sleep(rand(800, 1600));
  }

  async function removeSelected() {
    if (running) return;
    const targets = new Set([...selected]);
    if (!targets.size) {
      setStatus("Tick some connections to remove first.");
      return;
    }
    const proceed = window.confirm(
      `Remove ${targets.size} connection(s)?\n\n` +
        `This permanently removes them from your network and CANNOT be undone.` +
        (targets.size > REMOVE_CAP
          ? `\n\nOnly the first ${REMOVE_CAP} will be processed this session.`
          : "")
    );
    if (!proceed) return;

    running = true;
    stopRequested = false;
    setRunningUI(true);

    let removed = 0;
    scrollToTop();
    await sleep(rand(800, 1500));

    let stale = 0;
    let lastBottom = "";
    const plan = Math.min(targets.size, REMOVE_CAP);

    while (targets.size && removed < REMOVE_CAP && !stopRequested) {
      const rows = findRows();
      let acted = false;
      for (const row of rows) {
        const link = profileLinkOf(row);
        if (!targets.has(link)) continue;
        const name = nameFromRow(row) || "this connection";
        setStatus(`Removing ${removed + 1}/${plan}: ${name}…`);
        setRowStatus(link, "working");
        try {
          row.scrollIntoView({ block: "center" });
          await sleep(rand(500, 1100));
          await removeOne(row, name);
          removed++;
          selected.delete(link);
          collected.delete(link);
          setRowStatus(link, "removed");
        } catch (e) {
          console.warn("[LI Remove]", name, e);
          setRowStatus(link, "error", e && e.message);
        }
        targets.delete(link); // done either way — never loop on one person
        acted = true;
        // human pause between removals, with an occasional longer rest
        if (targets.size && removed < REMOVE_CAP) {
          let wait = rand(4000, 9000);
          if (removed > 0 && removed % 6 === 0) {
            wait = rand(20000, 40000);
            setStatus(`Longer break to stay human… (${Math.round(wait / 1000)}s)`);
          }
          await sleep(wait);
        }
        break; // DOM changed — re-query from the top of the loop
      }
      if (acted) {
        stale = 0;
        continue;
      }
      // none of the visible rows are targets → scroll to surface more
      scrollStep();
      await sleep(rand(700, 1400));
      const cur = findRows();
      const bottom = cur.length ? profileLinkOf(cur[cur.length - 1]) : "";
      if (bottom === lastBottom) {
        if (++stale >= 5) break; // reached the end
      } else {
        stale = 0;
      }
      lastBottom = bottom;
    }

    running = false;
    setRunningUI(false);
    renderList();
    const leftover = targets.size;
    setStatus(
      `${stopRequested ? "Stopped" : "Done"}. Removed ${removed}.` +
        (leftover
          ? ` ${leftover} not reached${removed >= REMOVE_CAP ? ` (session cap ${REMOVE_CAP})` : ""}.`
          : "")
    );
  }

  function setRowStatus(link, state, msg) {
    if (!panel) return;
    const row = panel.querySelector(`.lc-row[data-link="${link}"]`);
    if (!row) return;
    row.classList.remove("lc-working", "lc-removed", "lc-error");
    row.classList.add("lc-" + state);
    const s = row.querySelector(".lc-rstatus");
    if (s)
      s.textContent =
        { working: "⏳", removed: "✓ removed", error: "⚠ " + (msg || "failed") }[state] || "";
  }

  // ---- panel UI --------------------------------------------------------
  let panel;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "liw-panel";
    panel.innerHTML = `
      <div id="liw-header">
        <span id="liw-title">Connections Exporter &amp; Remover</span>
        <button id="liw-collapse" title="Collapse">–</button>
      </div>
      <div id="liw-body">
        <div id="liw-controls">
          <button id="lc-start" class="liw-btn liw-primary">Start</button>
          <button id="lc-stop" class="liw-btn liw-danger" disabled>Stop</button>
        </div>
        <div id="liw-controls">
          <button id="lc-csv" class="liw-btn">Save as CSV</button>
          <button id="lc-xls" class="liw-btn">Save as Excel</button>
        </div>
        <div id="liw-controls">
          <button id="lc-remove" class="liw-btn liw-danger">Remove selected</button>
        </div>
        <div id="liw-status">Click “Start” to auto-scroll and capture your connections.</div>
        <div id="lc-filters">
          <input id="lc-search" type="text" placeholder="Search name or headline…">
          <div class="lc-filterrow">
            <select id="lc-year"><option value="">All years</option></select>
            <select id="lc-sort">
              <option value="date-desc">Newest first</option>
              <option value="date-asc">Oldest first</option>
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
            </select>
          </div>
        </div>
        <div id="lc-countbar">
          <span id="lc-count">0 captured</span>
          <label class="lc-selall"><input type="checkbox" id="lc-selall"> shown</label>
          <span id="lc-selcount">0 selected</span>
        </div>
        <div id="lc-list"></div>
        <p id="liw-note">
          Captures name, headline, profile link, image URL and "Connected on"
          date → <b>Save as CSV/Excel</b>. To <b>remove</b> connections, tick
          them and click <b>Remove selected</b> — it's paced like a human and
          capped at ${REMOVE_CAP}/session. <b>Removal is permanent.</b> Keep this
          tab focused while it runs.
        </p>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#lc-start").addEventListener("click", run);
    panel.querySelector("#lc-stop").addEventListener("click", () => {
      stopRequested = true;
      setStatus("Stopping…");
    });
    panel.querySelector("#lc-csv").addEventListener("click", downloadCsv);
    panel.querySelector("#lc-xls").addEventListener("click", downloadXls);
    panel.querySelector("#lc-remove").addEventListener("click", removeSelected);
    panel.querySelector("#lc-search").addEventListener("input", renderList);
    panel.querySelector("#lc-year").addEventListener("change", renderList);
    panel.querySelector("#lc-sort").addEventListener("change", renderList);
    panel.querySelector("#lc-selall").addEventListener("change", (e) => {
      const listEl = panel.querySelector("#lc-list");
      listEl.querySelectorAll(".lc-row").forEach((el) => {
        const link = el.dataset.link;
        const cb = el.querySelector(".lc-check");
        if (e.target.checked) {
          selected.add(link);
          cb.checked = true;
        } else {
          selected.delete(link);
          cb.checked = false;
        }
      });
      updateSelCount();
    });
    panel.querySelector("#liw-collapse").addEventListener("click", () =>
      panel.classList.toggle("liw-collapsed")
    );
  }

  // Render the captured list inside the panel. Capped for performance on large
  // networks — every row is still in the CSV/Excel export.
  const DISPLAY_CAP = 1000;

  function comparator(mode) {
    switch (mode) {
      case "date-asc":
        return (a, b) => (a.connectedTs || 0) - (b.connectedTs || 0);
      case "name-asc":
        return (a, b) => (a.name || "").localeCompare(b.name || "");
      case "name-desc":
        return (a, b) => (b.name || "").localeCompare(a.name || "");
      case "date-desc":
      default:
        return (a, b) => (b.connectedTs || 0) - (a.connectedTs || 0);
    }
  }

  // The current filtered + sorted view of captured connections (no display cap).
  // Used by both the in-panel list and the CSV/Excel export — so you export
  // exactly what the filters/sort/search show.
  function viewRows() {
    let rows = [...collected.values()];
    if (!panel) return rows;
    const filterText = norm(panel.querySelector("#lc-search")?.value || "").toLowerCase();
    const filterYear = panel.querySelector("#lc-year")?.value || "";
    const sortMode = panel.querySelector("#lc-sort")?.value || "date-desc";
    if (filterText)
      rows = rows.filter((r) =>
        ((r.name || "") + " " + (r.headline || "")).toLowerCase().includes(filterText)
      );
    if (filterYear) rows = rows.filter((r) => r.connectedYear === filterYear);
    rows.sort(comparator(sortMode));
    return rows;
  }

  // Rebuild the year dropdown from captured data, preserving the current pick.
  function refreshYearOptions() {
    const sel = panel && panel.querySelector("#lc-year");
    if (!sel) return;
    const cur = sel.value;
    const years = [...new Set([...collected.values()].map((r) => r.connectedYear).filter(Boolean))].sort(
      (a, b) => b.localeCompare(a)
    );
    sel.innerHTML =
      `<option value="">All years</option>` +
      years.map((y) => `<option value="${y}">${y}</option>`).join("");
    sel.value = years.includes(cur) ? cur : "";
  }

  function renderList() {
    const listEl = panel && panel.querySelector("#lc-list");
    if (!listEl) return;

    refreshYearOptions();
    const rows = viewRows();
    const filteredTotal = rows.length;
    const shown = rows.slice(0, DISPLAY_CAP);

    listEl.innerHTML = shown
      .map(
        () =>
          `<div class="lc-row"><input type="checkbox" class="lc-check">` +
          `<div class="lc-rowmain"><a class="lc-name" target="_blank" rel="noopener"></a>` +
          `<span class="lc-head"></span><span class="lc-date"></span>` +
          `<span class="lc-rstatus"></span></div></div>`
      )
      .join("");

    const rowEls = listEl.querySelectorAll(".lc-row");
    shown.forEach((r, i) => {
      const el = rowEls[i];
      el.dataset.link = r.profileLink;
      const nameA = el.querySelector(".lc-name");
      nameA.textContent = r.name || "(no name)";
      if (r.profileLink) nameA.setAttribute("href", r.profileLink);
      el.querySelector(".lc-head").textContent = r.headline || "";
      el.querySelector(".lc-date").textContent = r.connectedOn || "";
      const cb = el.querySelector(".lc-check");
      cb.checked = selected.has(r.profileLink);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(r.profileLink);
        else selected.delete(r.profileLink);
        updateSelCount();
      });
    });

    const countEl = panel.querySelector("#lc-count");
    if (countEl) {
      const filtering = filteredTotal !== collected.size;
      countEl.textContent =
        `${collected.size} captured` +
        (filtering ? ` · ${filteredTotal} shown` : "") +
        (filteredTotal > DISPLAY_CAP ? ` (first ${DISPLAY_CAP})` : "");
    }
    updateSelCount();
  }

  function updateSelCount() {
    const el = panel && panel.querySelector("#lc-selcount");
    if (el) el.textContent = `${selected.size} selected`;
  }

  function setStatus(msg) {
    const el = panel && panel.querySelector("#liw-status");
    if (el) el.textContent = msg;
  }

  function setRunningUI(on) {
    panel.querySelector("#lc-start").disabled = on;
    panel.querySelector("#lc-stop").disabled = !on;
    const rm = panel.querySelector("#lc-remove");
    if (rm) rm.disabled = on;
  }

  buildPanel();
})();
