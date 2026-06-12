/* LinkedIn Connections Exporter — content script
 * Injects a panel on the Connections page. Click Start and it auto-scrolls the
 * whole list (which is virtualized — rows are recycled as you scroll), harvesting
 * each connection's name, headline, profile link, profile image URL, and
 * "Connected on" date into a de-duplicated set. Export to CSV when done.
 *
 * Read-only: it never clicks message/connect/withdraw. It only scrolls and
 * reads the page you're already on. Nothing leaves your browser except the CSV
 * you download yourself.
 */
(() => {
  "use strict";

  if (window.__liConnExportLoaded) return;
  window.__liConnExportLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const collected = new Map(); // key: profile URL -> row object
  let running = false;
  let stopRequested = false;

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

    // name from the avatar's alt / aria-label, falling back to the name <p>
    const img = row.querySelector("img[alt]");
    const svg = row.querySelector("svg[aria-label]");
    let name = norm(
      (img && img.getAttribute("alt")) || (svg && svg.getAttribute("aria-label")) || ""
    )
      .replace(/['’]s profile picture.*$/i, "")
      .trim();
    if (!name) {
      const nameP = row.querySelector("a[href*='/in/'] p");
      if (nameP) name = norm(nameP.textContent);
    }

    // headline = a <p><span> that isn't the name or the "Connected on" line
    let headline = "";
    let connectedOn = "";
    row.querySelectorAll("p").forEach((p) => {
      const t = norm(p.textContent);
      if (!t) return;
      if (/^connected on/i.test(t)) {
        connectedOn = t.replace(/^connected on\s*/i, "");
      } else if (p.querySelector("span") && t !== name && !headline) {
        headline = t;
      }
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

    return { name, headline, connectedOn, profileLink, imageUrl, urn };
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
        if (!prev.connectedOn && data.connectedOn) prev.connectedOn = data.connectedOn;
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
    if (!collected.size) {
      setStatus("Nothing captured yet — click Start first.");
      return;
    }
    const header = ["Name", "Headline", "Connected On", "Profile URL", "Image URL", "Profile URN"];
    const lines = [header.map(csvCell).join(",")];
    collected.forEach((r) => {
      lines.push(
        [r.name, r.headline, r.connectedOn, r.profileLink, r.imageUrl, r.urn]
          .map(csvCell)
          .join(",")
      );
    });
    triggerDownload(
      new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }),
      `linkedin-connections-${collected.size}.csv`
    );
    setStatus(`Downloaded CSV (${collected.size} connections).`);
  }

  // Excel (.xls) via an HTML table — Excel opens this natively as a spreadsheet.
  function downloadXls() {
    if (!collected.size) {
      setStatus("Nothing captured yet — click Start first.");
      return;
    }
    const esc = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const headers = ["Name", "Headline", "Connected On", "Profile URL", "Image URL", "Profile URN"];
    let rows = "<tr>" + headers.map((h) => `<th>${h}</th>`).join("") + "</tr>";
    collected.forEach((r) => {
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
      `linkedin-connections-${collected.size}.xls`
    );
    setStatus(`Downloaded Excel (${collected.size} connections).`);
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

  // ---- panel UI --------------------------------------------------------
  let panel;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "liw-panel";
    panel.innerHTML = `
      <div id="liw-header">
        <span id="liw-title">Connections Exporter</span>
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
        <div id="liw-status">Click “Start” to auto-scroll and capture your connections.</div>
        <div id="lc-countbar"><span id="lc-count">0 captured</span></div>
        <div id="lc-list"></div>
        <p id="liw-note">
          Captures name, headline, profile link, profile image URL, and the
          "Connected on" date. Read-only — it only scrolls and reads. For large
          networks this takes a while; you can <b>Stop</b> and save at any time.
          Keep this tab focused while it runs.
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
    panel.querySelector("#liw-collapse").addEventListener("click", () =>
      panel.classList.toggle("liw-collapsed")
    );
  }

  // Render the captured list inside the panel. Capped for performance on large
  // networks — every row is still in the CSV/Excel export.
  const DISPLAY_CAP = 1000;
  function renderList() {
    const listEl = panel && panel.querySelector("#lc-list");
    if (!listEl) return;
    const rows = [...collected.values()];
    const shown = rows.slice(0, DISPLAY_CAP);

    listEl.innerHTML = shown
      .map(
        () =>
          `<div class="lc-row"><a class="lc-name" target="_blank" rel="noopener"></a>` +
          `<span class="lc-head"></span><span class="lc-date"></span></div>`
      )
      .join("");

    const rowEls = listEl.querySelectorAll(".lc-row");
    shown.forEach((r, i) => {
      const el = rowEls[i];
      const nameA = el.querySelector(".lc-name");
      nameA.textContent = r.name || "(no name)";
      if (r.profileLink) nameA.setAttribute("href", r.profileLink);
      el.querySelector(".lc-head").textContent = r.headline || "";
      el.querySelector(".lc-date").textContent = r.connectedOn || "";
    });

    const more = rows.length - shown.length;
    const countEl = panel.querySelector("#lc-count");
    if (countEl)
      countEl.textContent =
        `${rows.length} captured` + (more > 0 ? ` (showing first ${DISPLAY_CAP})` : "");
  }

  function setStatus(msg) {
    const el = panel && panel.querySelector("#liw-status");
    if (el) el.textContent = msg;
  }

  function setRunningUI(on) {
    panel.querySelector("#lc-start").disabled = on;
    panel.querySelector("#lc-stop").disabled = !on;
  }

  buildPanel();
})();
