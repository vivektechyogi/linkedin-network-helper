/* LinkedIn Catch-up Messenger — content script
 * Injects a side panel on the "Catch up" page. Scans the cards (work
 * anniversaries, new jobs, birthdays, …), lets you pick who to message, and
 * sends a per-event-type template (with an optional appended note) to each,
 * one at a time, with randomized human-like timing.
 *
 * Runs entirely locally in your browser. Nothing leaves the page.
 *
 * NOTE: the message-composer selectors are isolated in clearly marked helpers
 * near the bottom — these are the parts most likely to need tuning if
 * LinkedIn changes its markup.
 */
(() => {
  "use strict";

  if (window.__liCatchupLoaded) return;
  window.__liCatchupLoaded = true;

  const DEFAULTS = {
    minDelayMs: 8000,
    maxDelayMs: 16000,
    longRestEvery: 6,
    longRestMinMs: 30000,
    longRestMaxMs: 70000,
    maxPerSession: 25,
  };

  // Per-event message templates. {name} is replaced with the person's first name.
  const TEMPLATE_DEFAULTS = {
    newJob: "Congrats on the new role, {name}! Wishing you a great start. 🎉",
    anniversary: "Happy work anniversary, {name}! Hope it's been a rewarding journey. 🙌",
    birthday: "Happy birthday, {name}! Hope you have a wonderful day. 🎂",
    default: "Congrats, {name}! 🎉",
  };

  let cfg = { ...DEFAULTS };
  let templates = { ...TEMPLATE_DEFAULTS };
  let appendText = "";
  let useSuggested = false; // if true: keep LinkedIn's pre-filled text, only append
  let sendSecond = false; // if true: send appendText as a separate 2nd message

  let scanned = []; // [{ id, name, firstName, eventText, type, cardEl, btnEl, selected }]
  let running = false;
  let stopRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const firstNameOf = (name) => norm(name).split(/\s+/)[0] || name;

  // ---- event classification -------------------------------------------
  function classify(text) {
    const t = (text || "").toLowerCase();
    if (/birthday/.test(t)) return "birthday";
    if (/completed \d+ years?|anniversar|\byears?\b.*\b(at|with)\b|work anniversary|been at/.test(t))
      return "anniversary";
    if (/new (job|role|position)|started|joined|promot|now (a|an|the)/.test(t))
      return "newJob";
    return "default";
  }

  const TYPE_LABEL = {
    newJob: "New job",
    anniversary: "Anniversary",
    birthday: "Birthday",
    default: "Other",
  };

  // ===== SELECTORS (most likely to need tuning) ========================

  // Catch-up action. Historically an <a> linking to /messaging/compose with the
  // suggested message in the URL body param. On the newer SDUI catch-up page it
  // is instead a <button> that opens the composer on click. Both carry an
  // aria-label of the form "Message <name>: <suggested body>".
  function findCardButtons() {
    const out = [];
    const seen = new Set();
    const consider = (el) => {
      if (!el || seen.has(el)) return;
      const aria = norm(el.getAttribute("aria-label"));
      if (!/^message\s+/i.test(aria)) return;
      if (el.closest("[role='dialog']")) return;
      // Old layout: a compose anchor. New layout: a button whose label carries
      // the suggested text after a colon ("Message Name: Happy birthday!").
      const isComposeLink =
        el.tagName === "A" &&
        /\/messaging\/compose/.test(el.getAttribute("href") || "");
      const looksLikeCard = /^message\s+.+:/i.test(aria);
      if (!isComposeLink && !looksLikeCard) return;
      seen.add(el);
      out.push(el);
    };
    document
      .querySelectorAll("a[href*='/messaging/compose'][aria-label]")
      .forEach(consider);
    document.querySelectorAll("button[aria-label]").forEach(consider);
    return out;
  }

  // True when the action is the old compose anchor we can pre-fill via its URL.
  function isComposeLink(el) {
    return (
      el &&
      el.tagName === "A" &&
      /\/messaging\/compose/.test(el.getAttribute("href") || "")
    );
  }

  // Pull name, LinkedIn's suggested message, and the event description out of a
  // card. Name + suggested come from the compose link; event text from the card.
  function cardInfoFromButton(btn) {
    const card =
      btn.closest("[role='listitem']") ||
      btn.closest("[componentkey]") ||
      btn.parentElement;

    // aria-label = "Message Viranch Gupta: Happy belated birthday!"
    const aria = norm(btn.getAttribute("aria-label"));
    let name = "";
    let suggested = "";
    const m = aria.match(/^message\s+(.+?):\s*(.*)$/i);
    if (m) {
      name = m[1].trim();
      suggested = m[2].trim();
    }
    // canonical body from the URL (handles odd punctuation better than aria)
    if (isComposeLink(btn)) {
      try {
        const url = new URL(btn.href, location.origin);
        const b = url.searchParams.get("body");
        if (b) suggested = b;
      } catch (_) {}
    } else if (!suggested) {
      // New layout: the suggested text lives in a span inside the button.
      const inner = norm(btn.textContent);
      if (inner) suggested = inner;
    }

    if (!name && card) {
      const link = card.querySelector("a[href*='/in/']");
      const img = link && link.querySelector("img[alt]");
      if (img)
        name = norm(img.getAttribute("alt"))
          .replace(/['’]s profile picture$/i, "")
          .trim();
    }
    name = name || "(unknown)";

    // event description: the card paragraph that isn't the name or the suggestion
    let eventText = "";
    if (card) {
      let best = "";
      card.querySelectorAll("p").forEach((p) => {
        const t = norm(p.textContent);
        if (
          t &&
          t !== name &&
          t !== suggested &&
          !/^message/i.test(t) &&
          !/\b(reaction|comment)s?\b/i.test(t) &&
          t.length > best.length &&
          t.length < 200
        )
          best = t;
      });
      eventText = best;
    }

    return { name, suggested, eventText: eventText || "—", card, btn };
  }

  // querySelectorAll that pierces open shadow roots (the messaging overlay on
  // the SDUI catch-up page is rendered inside a shadow root).
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

  // Collect every editable-ish element across the document AND open shadow roots.
  function collectEditables() {
    return deepQueryAll("[contenteditable], [role='textbox'], textarea");
  }

  function clsOf(el) {
    return (el.className && el.className.toString && el.className.toString()) || "";
  }

  const isFieldEditor = (el) =>
    !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");

  // Read the live text from any editor type. A <textarea>/<input> keeps its
  // current text in .value (its .textContent is only the original default), so
  // never trust textContent for those.
  function editorValue(el) {
    if (!el) return "";
    return isFieldEditor(el) ? el.value || "" : el.textContent || "";
  }

  // Set a textarea/input value the React/SDUI-friendly way: go through the
  // native value setter so the framework's input listener actually fires.
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // The SDUI "Send message" modal, if one is open. Scoped to the message modal
  // specifically (a dialog carrying a Message screen or containing an editor)
  // so we never act on an unrelated dialog on the page.
  function messageDialog() {
    const byScreen = document.querySelector("[data-sdui-screen*='Message']");
    if (byScreen) return byScreen.closest("[role='dialog']") || byScreen;
    return (
      deepQueryAll("[role='dialog'], [data-testid='dialog-content']").find(
        (d) =>
          d.querySelector &&
          d.querySelector("textarea, [contenteditable], [role='textbox']")
      ) || null
    );
  }

  // The enclosing composer chrome (messaging overlay form, or the SDUI "Send
  // message" modal). When this is torn out of the DOM, the message has gone.
  function composerContainerOf(editor) {
    if (!editor) return null;
    return (
      (editor.closest &&
        editor.closest(
          "form.msg-form, [class*='msg-overlay'], [data-testid='dialog-content'], [role='dialog'], [data-sdui-screen*='Message']"
        )) ||
      editor.parentElement ||
      null
    );
  }

  // The messaging overlay's editable box. Score candidates so we pick the real
  // message editor even as LinkedIn varies its markup.
  function findComposerEditor() {
    const cands = collectEditables().filter((el) => {
      if (el.tagName === "TEXTAREA") return true;
      const ce = el.getAttribute("contenteditable");
      if (ce === "false") return false;
      return ce !== null || el.getAttribute("role") === "textbox";
    });
    const score = (el) => {
      let s = 0;
      if (/msg-form__contenteditable/.test(clsOf(el))) s += 100;
      try {
        if (el.closest && el.closest(".msg-form, [class*='msg-overlay'], [class*='msg-'], form"))
          s += 20;
      } catch (_) {}
      const aria = el.getAttribute("aria-label") || "";
      if (/message/i.test(aria)) s += 10;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) s += 5;
      return s;
    };
    cands.sort((a, b) => score(b) - score(a));
    return cands.length && score(cands[0]) > 0 ? cands[0] : cands[0] || null;
  }

  // Dump what's on the page so we can see why the editor wasn't found.
  function logEditorDiagnostics() {
    const all = collectEditables();
    console.log("[LI Catchup] editable candidates:", all.length);
    all.forEach((el, i) =>
      console.log(
        `  #${i}`,
        el.tagName,
        "| class=", clsOf(el).slice(0, 60),
        "| ce=", el.getAttribute("contenteditable"),
        "| role=", el.getAttribute("role"),
        "| aria=", el.getAttribute("aria-label")
      )
    );
    console.log(
      "[LI Catchup] .msg-form present:",
      !!document.querySelector(".msg-form, [class*='msg-overlay']")
    );
  }

  // Build an Enter KeyboardEvent that actually reports keyCode/which === 13.
  // The KeyboardEvent constructor ignores keyCode/which in its init dict, so we
  // force them on with defineProperty — LinkedIn's editor checks keyCode.
  function makeEnter(type) {
    const e = new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    });
    Object.defineProperty(e, "keyCode", { get: () => 13 });
    Object.defineProperty(e, "which", { get: () => 13 });
    Object.defineProperty(e, "charCode", { get: () => (type === "keypress" ? 13 : 0) });
    return e;
  }

  function pressEnter(el) {
    el.focus();
    // Put a real caret at the end of the contenteditable — LinkedIn's send
    // handler reads the current selection/range, and a focused box with no
    // selection can make it treat the box as empty and ignore Enter.
    try {
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    } catch (_) {}
    // Dispatch on the editor AND its delegated-listener ancestors (the message
    // form / overlay). LinkedIn attaches the keydown handler higher up in some
    // layouts, so firing only on the editor misses it.
    const targets = [
      el,
      el.parentElement,
      el.closest && el.closest("form.msg-form, form"),
      el.closest && el.closest("[class*='msg-overlay']"),
      document,
    ].filter((t, i, a) => t && a.indexOf(t) === i);
    for (const t of targets) {
      t.dispatchEvent(makeEnter("keydown"));
      t.dispatchEvent(makeEnter("keypress"));
      t.dispatchEvent(makeEnter("keyup"));
    }
  }

  // Confirm a send. Two valid signals, depending on the UI flow:
  //  - the composer we typed into was removed from the DOM (the SDUI "Send
  //    message" modal closes itself on send), or
  //  - a FRESH editor (the old node detaches on re-render) is now empty (the
  //    messaging overlay stays open with an emptied box).
  // A stale reference lies, so always re-query.
  function confirmedSent(container, sentText) {
    if (container && !document.contains(container)) return true;
    const ed = findComposerEditor();
    if (!ed) return true; // editor gone entirely → message left / box closed
    if (norm(editorValue(ed)).length === 0) return true; // box cleared → sent
    // The overlay can keep a stale draft visible briefly; treat the message as
    // sent if our exact text now appears as a delivered bubble in the thread.
    if (sentText) return sentBubblePresent(container, sentText);
    return false;
  }

  // Look for our just-sent text rendered as a message bubble (NOT inside the
  // editor) within the open conversation — a positive "it left the box" signal
  // that works even when the editor doesn't clear instantly.
  function sentBubblePresent(container, sentText) {
    const want = norm(sentText);
    if (!want) return false;
    const scope =
      (container && document.contains(container) && container) ||
      messageDialog() ||
      deepQueryAll("[class*='msg-overlay']")[0] ||
      document;
    const editor = findComposerEditor();
    const bubbles = (scope.querySelectorAll
      ? [...scope.querySelectorAll("p, span, div")]
      : []
    ).filter((el) => {
      if (editor && (el === editor || el.contains(editor) || editor.contains(el))) return false;
      if (el.isContentEditable) return false;
      return norm(el.textContent) === want;
    });
    return bubbles.length > 0;
  }

  // Try several ways to actually submit, confirming after each. Returns true
  // only when the editor is confirmed empty (message left the box).
  async function sendMessage(editor, sentText) {
    const container = composerContainerOf(editor);
    // What we expect to see leave the box (for positive confirmation).
    const want = norm(sentText || editorValue(editor));
    const isCE = !isFieldEditor(editor); // contenteditable overlay vs SDUI textarea
    const trace = [];
    const T = (...a) => {
      trace.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    const finish = (ok, why) => {
      T((ok ? "✓ SENT via " : "✗ FAILED at ") + why);
      try {
        console.log("[LI Catchup] sendMessage trace:\n  " + trace.join("\n  "));
      } catch (_) {}
      return ok;
    };
    T(
      "start type=", isCE ? "contenteditable" : "textarea",
      "want=", want.slice(0, 40),
      "editorInDom=", document.contains(editor)
    );

    // 1) An explicit Send button/control, if this state has one. Cover plain
    //    <button>s, role="button" divs, and icon buttons labelled via aria —
    //    the SDUI "Send message" modal uses one of these. Prefer a control
    //    inside the composer/dialog, and an exact "send" over a "send …" match.
    const scope = container && document.contains(container) ? container : document;
    const isSendLabel = (s) => s === "send" || /^send( message)?$/.test(s);
    const findSend = (root) => {
      const cands = deepQueryAll("button, [role='button'], a[role='button']").filter(
        (b) =>
          (root === document || (root.contains && root.contains(b))) &&
          !b.disabled &&
          b.getAttribute("aria-disabled") !== "true"
      );
      const score = (b) => {
        const t = norm(b.textContent).toLowerCase();
        const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
        if (t === "send" || aria === "send") return 2;
        if (isSendLabel(t) || isSendLabel(aria)) return 1;
        return 0;
      };
      return cands
        .map((b) => [b, score(b)])
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([b]) => b)[0];
    };
    // The SDUI "Send message" modal's button carries a stable componentkey and
    // is briefly DISABLED right after we fill the text (until the framework
    // processes the input event) — so poll for an ENABLED Send control.
    // The SDUI referralSendButton in any state (enabled or not) — so we can
    // re-nudge its input when it's stuck disabled, and click it as a last resort.
    const referralBtn = () =>
      deepQueryAll("[componentkey^='referralSendButton']").find((b) => b.tagName === "BUTTON");
    const isEnabled = (b) => b && !b.disabled && b.getAttribute("aria-disabled") !== "true";
    const directSend = () => {
      const b = referralBtn();
      return isEnabled(b) ? b : null;
    };
    const haveContainer = !!(container && document.contains(container));
    let sendBtn = null;
    // "trusted" = an unambiguous, in-composer Send control. Clicking one of
    // these IS the send, even if the UI doesn't clear/close fast enough for us
    // to verify. A document-wide fallback match is not trusted (still verified).
    let trusted = false;
    let nudged = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const direct = directSend(); // SDUI referralSendButton — unambiguous
      if (direct) {
        sendBtn = direct;
        trusted = true;
        break;
      }
      const scoped = haveContainer ? findSend(container) : null; // Send inside composer
      if (scoped) {
        sendBtn = scoped;
        trusted = true;
        break;
      }
      const any = findSend(document); // last resort — verify before trusting
      if (any) {
        sendBtn = any;
        trusted = false;
        break;
      }
      // A Send button exists but is stuck disabled (framework didn't register
      // our text) — re-fire the input so it validates and enables. Try once.
      if (!nudged && referralBtn() && want) {
        nudged = true;
        const ed = findComposerEditor() || editor;
        if (ed && isFieldEditor(ed)) {
          ed.focus();
          if (ed._valueTracker) ed._valueTracker.setValue("");
          ed.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: want, bubbles: true }));
          ed.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      await sleep(250);
    }
    T("step1 sendBtn=", !!sendBtn, "trusted=", trusted);
    if (sendBtn) {
      await humanClick(sendBtn);
      try {
        sendBtn.click(); // native click as a reliable fallback for the handler
      } catch (_) {}
      await sleep(rand(900, 1500));
      if (confirmedSent(container, want)) return finish(true, "step1 button + confirm");
      await sleep(rand(800, 1400)); // network/close can lag
      if (confirmedSent(container, want)) return finish(true, "step1 button + confirm(2)");
      // Clicked an enabled Send control inside the composer → trust it as sent.
      if (trusted) return finish(true, "step1 trusted button click");
    }

    // 2) Submit the message form directly. This is the mechanism that works for
    //    the "Press Enter to Send" overlay: LinkedIn's msg-form has its own
    //    submit handler that sends the message and prevents the default page
    //    navigation, so requestSubmit() (no submitter) reliably fires it — even
    //    though the compose form has no visible Send button. Confirm after.
    const form =
      (editor.closest && editor.closest("form.msg-form, form")) ||
      document.querySelector("form.msg-form, form.msg-form--thread-footer-feature");
    const formSubmitBtn = form && form.querySelector("button[type='submit']");
    T("step2 form=", !!form, "submitBtn=", !!formSubmitBtn);
    if (form) {
      try {
        if (form.requestSubmit) form.requestSubmit(formSubmitBtn || undefined);
        else if (formSubmitBtn) formSubmitBtn.click();
        // No native form.submit() fallback — that bypasses LinkedIn's handler
        // and would reload the page, losing the message.
      } catch (_) {
        try { form.requestSubmit && form.requestSubmit(); } catch (__) {}
      }
      await sleep(rand(800, 1200));
      if (confirmedSent(container, want)) return finish(true, "step2 form submit");
      await sleep(rand(700, 1100));
      if (confirmedSent(container, want)) return finish(true, "step2 form submit(2)");
    }

    // 3) Enter key on the (freshly found) editor, retried. For the messaging
    //    overlay (contenteditable) Enter IS the send action (the footer literally
    //    reads "Press Enter to Send" with no Send button). (No-op for a plain
    //    SDUI textarea where Enter inserts a newline — handled by the button
    //    path above.)
    for (let attempt = 0; attempt < 5; attempt++) {
      const ed = findComposerEditor() || editor;
      // Blur the recipient typeahead so Enter targets the message box, not the
      // recipient search (this is a "New message" compose overlay).
      try {
        const search = (container || document).querySelector(
          ".msg-connections-typeahead__search-field"
        );
        if (search && document.activeElement === search) search.blur();
      } catch (_) {}
      pressEnter(ed);
      await sleep(rand(700, 1100));
      if (confirmedSent(container, want)) return finish(true, "step3 Enter#" + attempt);
      if (sentBubblePresent(container, want)) return finish(true, "step3 Enter bubble#" + attempt);
    }
    T("step3 Enter exhausted; editorText=", norm(editorValue(findComposerEditor() || editor)).slice(0, 40));

    // 3b) Last resort for the compose overlay: open the send-options menu and
    //     click an explicit Send item if LinkedIn offers one there.
    if (!formSubmitBtn) {
      const sent = await sendViaOptionsMenu(container, want, T);
      if (sent) return finish(true, "step3b options-menu Send button");
    }

    // 4) Last resort: the SDUI Send button is present but never enabled — click
    //    it anyway (its handler often still fires) and verify by thread bubble.
    const stuck = referralBtn();
    T("step4 stuckReferralBtn=", !!stuck);
    if (stuck) {
      try { stuck.click(); } catch (_) {}
      await humanClick(stuck);
      await sleep(rand(900, 1400));
      if (confirmedSent(container, want)) return finish(true, "step4 stuck button");
    }

    // Still here → couldn't submit. Dump the candidate buttons so we can see
    // what the Send control actually looks like.
    try {
      const root = container && document.contains(container) ? container : messageDialog() || document;
      const edNow = findComposerEditor();
      console.log(
        "[LI Catchup] send failed.",
        "editorText=", edNow ? norm(editorValue(edNow)).slice(0, 60) : "(no editor)",
        "| form=", !!form,
        "| container in DOM=", !!(container && document.contains(container))
      );
      const btns = deepQueryAll("button, [role='button']").filter(
        (b) => root === document || (root.contains && root.contains(b))
      );
      console.log("[LI Catchup] send failed — buttons in composer/dialog:", btns.length);
      btns.forEach((b, i) =>
        console.log(
          `  #${i}`,
          b.tagName,
          "| text=", norm(b.textContent).slice(0, 30),
          "| aria=", b.getAttribute("aria-label"),
          "| disabled=", b.disabled || b.getAttribute("aria-disabled")
        )
      );
    } catch (_) {}
    return finish(false, "all methods exhausted");
  }

  // Compose-overlay last resort: the footer has a "send options" toggle but no
  // Send button (it's in "Press Enter to Send" mode). Open that menu and turn
  // OFF enter-to-send, which makes LinkedIn render a real Send button we can
  // click — far more reliable than a synthetic Enter. Then click it.
  async function sendViaOptionsMenu(container, want, T) {
    const log = T || (() => {});
    const scope = container && document.contains(container) ? container : document;
    const toggle = deepQueryAll("button").find((b) => {
      if (scope.contains && !scope.contains(b)) return false;
      const cls = clsOf(b);
      const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
      return /msg-form__send-toggle/.test(cls) || /send option/.test(aria);
    });
    log("optionsMenu toggleFound=", !!toggle);
    if (!toggle) return false;
    try {
      toggle.click();
    } catch (_) {}
    await sleep(rand(400, 700));
    // The menu offers a "Press enter to send" toggle — turn it off so the Send
    // button appears. Match a menuitem/checkbox/button mentioning enter-to-send.
    const optItems = deepQueryAll(
      "[role='menuitem'], [role='menuitemcheckbox'], [role='option'], button, label"
    ).filter((el) => /enter to send/i.test(norm(el.textContent)));
    log("optionsMenu enterToSendItems=", optItems.length);
    for (const it of optItems) {
      try {
        const ck = it.querySelector && it.querySelector("input[type='checkbox']");
        (ck || it).click();
      } catch (_) {}
      await sleep(rand(300, 600));
    }
    // A Send button should now be in the footer — find and click it.
    for (let i = 0; i < 6; i++) {
      const sendBtn = deepQueryAll("button, [role='button']").find((b) => {
        if (scope.contains && !scope.contains(b)) return false;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const t = norm(b.textContent).toLowerCase();
        const aria = norm(b.getAttribute("aria-label") || "").toLowerCase();
        return t === "send" || aria === "send" || /^send( message)?$/.test(t);
      });
      if (sendBtn) {
        await humanClick(sendBtn);
        try { sendBtn.click(); } catch (_) {}
        await sleep(rand(800, 1300));
        if (confirmedSent(container, want)) return true;
        await sleep(rand(700, 1100));
        if (confirmedSent(container, want)) return true;
        return true; // an explicit in-composer Send click is trusted
      }
      await sleep(350);
    }
    return false;
  }

  // Close EVERY open message overlay so each send starts from a clean slate.
  // Polls/retries until no editor remains, so a stale conversation can never be
  // reused for the next person.
  async function closeAllComposers() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const closers = deepQueryAll("button").filter((c) => {
        const label = norm(c.getAttribute("aria-label") || c.textContent || "").toLowerCase();
        if (/^close your (draft )?conversation/.test(label)) return true;
        if (/^close conversation/.test(label)) return true;
        // a dismiss/close control on the SDUI "Send message" modal
        if (/^(close|dismiss|cancel)\b/.test(label) && c.closest("[role='dialog'], [data-testid='dialog-content']"))
          return true;
        // close-small icon inside a messaging-overlay header control
        const hasCloseIcon =
          c.querySelector &&
          c.querySelector("[data-test-icon='close-small'], use[href='#close-small']");
        const cls = clsOf(c);
        return !!hasCloseIcon && /msg-overlay|conversation-bubble/.test(cls);
      });
      const dialog = messageDialog();
      if (!closers.length && !dialog && !findComposerEditor()) return true;
      closers.forEach((c) => {
        try {
          c.click();
        } catch (_) {}
      });
      // The SDUI modal also closes on Escape — use it as a fallback when no
      // explicit close button was matched.
      if (!closers.length && dialog) {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
        );
      }
      await sleep(450);
      if (!findComposerEditor() && !messageDialog()) return true;
    }
    return !findComposerEditor() && !messageDialog();
  }

  // Read who the currently-open composer is addressed to, so we never send to
  // the wrong person if an old overlay is still around.
  function getComposerRecipient() {
    // Scope the search to the OPEN composer only. Searching the whole page can
    // pick up unrelated pills/titles elsewhere — e.g. an ad's
    // "Why am I seeing this ad?" pill — and falsely flag a wrong recipient.
    const editor = findComposerEditor();
    const scope =
      (editor && composerContainerOf(editor)) ||
      messageDialog() ||
      deepQueryAll("[class*='msg-overlay']")[0] ||
      null;
    if (!scope) return "";
    const q = (sel) => {
      try {
        return scope.querySelector(sel);
      } catch (_) {
        return null;
      }
    };

    const pill = q("[class*='added-recipients'] .artdeco-pill__text") || q(".artdeco-pill__text");
    if (pill) return norm(pill.textContent);
    const card =
      q(".msg-s-profile-card .artdeco-entity-lockup__title") ||
      q(".artdeco-entity-lockup__title");
    if (card) return norm(card.textContent);
    const title = q(".msg-overlay-bubble-header__title");
    if (title) {
      const t = norm(title.textContent);
      if (t && !/new message/i.test(t)) return t;
    }
    // SDUI "Send message" modal: the recipient name is the first paragraph in
    // the dialog body (the event description follows in a second paragraph).
    const p = q("p");
    if (p) {
      const t = norm(p.textContent);
      if (t && !/^send message$/i.test(t) && !/^write a message/i.test(t)) return t;
    }
    return "";
  }

  // ===== end selectors =================================================

  function scan() {
    const list = [];
    findCardButtons().forEach((btn, i) => {
      const info = cardInfoFromButton(btn);
      const type = classify(info.eventText + " " + norm(btn.getAttribute("aria-label")));
      list.push({
        id: "cu_" + i + "_" + info.name.replace(/\W+/g, "").slice(0, 16),
        name: info.name,
        firstName: firstNameOf(info.name),
        eventText: info.eventText,
        suggested: info.suggested,
        type,
        cardEl: info.card,
        btnEl: info.btn,
        selected: false,
      });
    });
    scanned = list;
    renderRows();
    setStatus(
      list.length
        ? `Found ${list.length} catch-up card(s). Pick who to message.`
        : "No catch-up cards found. Scroll the page, then Scan again."
    );
  }

  // The congratulations message only (no appended note).
  function congratsMessage(item) {
    if (useSuggested) return item.suggested;
    const tpl = templates[item.type] || templates.default;
    return tpl.replace(/\{name\}/g, item.firstName);
  }

  // ---- human-like interaction -----------------------------------------
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

  // Type text into a contenteditable, char-by-char-ish, so it registers with
  // LinkedIn's editor and looks like real typing.
  async function typeInto(editor, text, { append }) {
    editor.focus();
    await sleep(rand(200, 500));
    if (!append) {
      // clear existing pre-filled text
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } else {
      // move caret to end
      const sel = window.getSelection();
      sel.selectAllChildren(editor);
      sel.collapseToEnd();
      // separate appended note from existing text
      insertChunk(editor, "\n\n");
    }
    // type in small chunks with jitter
    const chunks = text.match(/.{1,3}/gs) || [text];
    for (const ch of chunks) {
      if (stopRequested) break;
      insertChunk(editor, ch);
      await sleep(rand(25, 90));
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function insertChunk(editor, str) {
    const ok = document.execCommand("insertText", false, str);
    if (!ok) {
      // fallback for editors that block execCommand
      editor.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "insertText", data: str, bubbles: true, cancelable: true })
      );
      editor.textContent += str;
      editor.dispatchEvent(
        new InputEvent("input", { inputType: "insertText", data: str, bubbles: true })
      );
    }
  }

  // Replace the editor's entire content with `text`. Used to force our intended
  // message in when LinkedIn's URL pre-fill ignores our appended/custom text.
  async function setEditorText(editor, text) {
    editor.focus();
    await sleep(rand(150, 350));

    // <textarea>/<input> (the SDUI "Send message" modal): drive the native
    // value setter so React/SDUI sees the change and enables its Send button.
    // The framework only re-validates (and enables Send) when it detects a real
    // value change — so force its internal value tracker to a stale value first,
    // then fire input, and bracket it with key events that mimic real typing.
    if (isFieldEditor(editor)) {
      const fireInput = (data) =>
        editor.dispatchEvent(
          new InputEvent("input", { inputType: "insertText", data, bubbles: true })
        );
      setNativeValue(editor, "");
      if (editor._valueTracker) editor._valueTracker.setValue(" ");
      fireInput("");
      editor.dispatchEvent(makeEnter("keydown")); // some validators key off keyup/down
      setNativeValue(editor, text);
      // Force the tracker to a value different from `text` so React registers a diff.
      if (editor._valueTracker) editor._valueTracker.setValue("");
      fireInput(text.slice(-1) || text);
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
      await sleep(rand(150, 300));
      // Nudge again if the value somehow didn't stick (rare SDUI re-render race).
      if (norm(editor.value) !== norm(text)) {
        setNativeValue(editor, text);
        if (editor._valueTracker) editor._valueTracker.setValue("");
        fireInput(text);
      }
      await sleep(rand(100, 200));
      return;
    }

    // contenteditable (messaging overlay): select all, then overwrite.
    document.execCommand("selectAll", false, null);
    await sleep(40);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      // fallback: clear then type in chunks
      document.execCommand("delete", false, null);
      await typeInto(editor, text, { append: false });
    }
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(rand(100, 250));
  }

  // The first message to send. The note is folded in here only when NOT sending
  // it as a separate second message.
  function finalMessage(item) {
    const base = congratsMessage(item);
    const extra = norm(appendText);
    if (sendSecond) return base; // note goes out separately afterwards
    return extra ? `${base}\n\n${extra}` : base;
  }

  // Returns { ok: true } or { ok: false, msg: "<reason>" }.
  async function sendOne(item) {
    if (!document.body.contains(item.btnEl))
      return { ok: false, msg: "Card no longer on page — re-scan." };

    const msg = finalMessage(item);

    // Start clean: close any overlay left open from a previous person.
    await closeAllComposers();
    await sleep(rand(300, 700));

    // Pre-fill our message by rewriting the compose URL's body param, so the
    // overlay opens already containing our text (no fragile typing needed).
    // Only possible on the old compose-anchor layout; the new button opens an
    // empty (or LinkedIn-suggested) composer that we fill in ourselves below.
    const prefill = isComposeLink(item.btnEl);
    if (prefill) {
      try {
        const url = new URL(item.btnEl.href, location.origin);
        url.searchParams.set("body", msg);
        item.btnEl.setAttribute("href", url.toString());
      } catch (_) {}
    }

    await humanClick(item.btnEl);

    // Wait for the composer editor to appear. With URL pre-fill we also wait for
    // the text to land (LinkedIn populates the body asynchronously); without it
    // we proceed as soon as the editor exists and type the message in ourselves.
    let editor = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      editor = findComposerEditor();
      if (editor && (!prefill || norm(editorValue(editor)).length > 0)) break;
      await sleep(300);
    }
    if (!editor) {
      logEditorDiagnostics();
      return {
        ok: false,
        msg: "Couldn't locate the message box. A diagnostic was printed to the console (F12) — paste it back.",
      };
    }

    // SAFETY: make sure the open box is addressed to the right person before
    // sending — guards against an old overlay still being on screen.
    const recipient = getComposerRecipient();
    if (
      recipient &&
      !recipient.toLowerCase().includes(item.firstName.toLowerCase())
    ) {
      await closeAllComposers();
      return {
        ok: false,
        msg: `Open box was addressed to "${recipient}", not ${item.name}. Skipped to avoid wrong send.`,
      };
    }

    // Ensure the editor actually contains our intended message. LinkedIn's URL
    // pre-fill often ignores our appended/custom text, so if what's in the box
    // doesn't match, overwrite it directly.
    if (norm(editorValue(editor)) !== norm(msg)) {
      await setEditorText(editor, msg);
      await sleep(rand(400, 900));
    }
    if (norm(editorValue(editor)).length === 0)
      return { ok: false, msg: "Message box opened but stayed empty after typing." };

    const sent = await sendMessage(editor, msg);
    await sleep(rand(800, 1500));
    if (!sent) {
      await closeAllComposers();
      return {
        ok: false,
        msg: "Box opened & text filled, but it didn't send (LinkedIn blocked the submit).",
      };
    }

    // Optional follow-up: send the note as a separate second message in the now
    // open conversation (recipient is already correct).
    const note = norm(appendText);
    if (sendSecond && note) {
      await sleep(rand(1500, 3000)); // human pause between two messages
      let ed2 = null;
      const dl = Date.now() + 8000;
      while (Date.now() < dl) {
        ed2 = findComposerEditor();
        if (ed2 && norm(editorValue(ed2)).length === 0) break;
        await sleep(300);
      }
      if (ed2) {
        await setEditorText(ed2, note);
        await sleep(rand(500, 1100));
        const sent2 = await sendMessage(ed2, note);
        await sleep(rand(700, 1300));
        if (!sent2) {
          await closeAllComposers();
          return { ok: false, msg: "1st message sent, but the 2nd (your note) didn't send." };
        }
      } else {
        await closeAllComposers();
        return { ok: false, msg: "1st message sent, but the follow-up box never reopened." };
      }
    }

    await closeAllComposers();
    await sleep(rand(500, 1100));
    return { ok: true };
  }

  async function process() {
    if (running) return;
    const targets = scanned.filter((s) => s.selected);
    if (!targets.length) {
      setStatus("Nothing selected. Tick some rows first.");
      return;
    }
    running = true;
    stopRequested = false;
    setRunningUI(true);

    const queue = targets.slice(0, cfg.maxPerSession);
    if (targets.length > cfg.maxPerSession)
      setStatus(`Capped at ${cfg.maxPerSession} this session. Processing first ${cfg.maxPerSession}.`);

    let done = 0;
    for (let i = 0; i < queue.length; i++) {
      if (stopRequested) {
        setStatus(`Stopped. Sent ${done} of ${queue.length}.`);
        break;
      }
      const item = queue[i];
      markRow(item.id, "working");
      setStatus(`Messaging ${i + 1}/${queue.length}: ${item.name}…`);
      try {
        const res = await sendOne(item);
        if (res.ok) {
          markRow(item.id, "done");
          done++;
        } else {
          markRow(item.id, "error", res.msg);
          console.warn("[LI Catchup]", item.name, res.msg);
        }
      } catch (e) {
        console.error("[LI Catchup]", e);
        markRow(item.id, "error", e && e.message ? e.message : String(e));
      }

      if (i < queue.length - 1 && !stopRequested) {
        let wait = rand(cfg.minDelayMs, cfg.maxDelayMs);
        if (done > 0 && done % cfg.longRestEvery === 0) {
          wait = rand(cfg.longRestMinMs, cfg.longRestMaxMs);
          setStatus(`Taking a longer break (${Math.round(wait / 1000)}s)…`);
        }
        await sleep(wait);
      }
    }

    running = false;
    setRunningUI(false);
    if (!stopRequested) setStatus(`Done. Sent ${done} message(s).`);
  }

  // ---- panel UI --------------------------------------------------------
  let panel;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "liw-panel";
    panel.innerHTML = `
      <div id="liw-header">
        <span id="liw-title">Catch-up Messenger</span>
        <button id="liw-collapse" title="Collapse">–</button>
      </div>
      <div id="liw-body">
        <div id="liw-controls">
          <button id="liw-scan" class="liw-btn">Scan page</button>
          <button id="liw-process" class="liw-btn liw-primary">Send to selected</button>
          <button id="liw-stop" class="liw-btn liw-danger" disabled>Stop</button>
        </div>
        <div id="liw-select-row">
          <label><input type="checkbox" id="liw-all"> Select all</label>
          <span id="liw-count">0 selected</span>
        </div>
        <div id="liw-status">Click “Scan page” to load catch-up cards.</div>
        <div id="liw-list"></div>

        <details id="liw-templates" open>
          <summary>Message templates</summary>
          <label class="liw-tpl">New job
            <textarea id="liw-tpl-newJob" rows="2"></textarea></label>
          <label class="liw-tpl">Work anniversary
            <textarea id="liw-tpl-anniversary" rows="2"></textarea></label>
          <label class="liw-tpl">Birthday
            <textarea id="liw-tpl-birthday" rows="2"></textarea></label>
          <label class="liw-tpl">Other / default
            <textarea id="liw-tpl-default" rows="2"></textarea></label>
          <p class="liw-hint">Use <code>{name}</code> for the person's first name.</p>
          <label class="liw-tpl">Your note / pitch (optional)
            <textarea id="liw-append" rows="3" placeholder="e.g. P.S. I build custom trading tools…"></textarea></label>
          <label class="liw-check"><input type="checkbox" id="liw-second">
            Send my note as a separate 2nd message (instead of appending)</label>
          <label class="liw-check"><input type="checkbox" id="liw-suggested">
            Keep LinkedIn's suggested text instead of my templates</label>
        </details>

        <details id="liw-settings">
          <summary>Timing settings</summary>
          <label>Min delay (s) <input type="number" id="liw-min" min="3" step="1"></label>
          <label>Max delay (s) <input type="number" id="liw-max" min="3" step="1"></label>
          <label>Long break every <input type="number" id="liw-every" min="2" step="1"></label>
          <label>Max per session <input type="number" id="liw-cap" min="1" step="1"></label>
        </details>
        <p id="liw-note">Messaging is slower-paced than withdrawing on purpose. Keep batches small.</p>
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
    panel.querySelector("#liw-collapse").addEventListener("click", () =>
      panel.classList.toggle("liw-collapsed")
    );

    // template fields
    const tplBind = (key) => {
      const el = panel.querySelector("#liw-tpl-" + key);
      el.value = templates[key];
      el.addEventListener("input", () => {
        templates[key] = el.value;
        save();
      });
    };
    ["newJob", "anniversary", "birthday", "default"].forEach(tplBind);

    const appendEl = panel.querySelector("#liw-append");
    appendEl.value = appendText;
    appendEl.addEventListener("input", () => {
      appendText = appendEl.value;
      save();
    });

    const secondEl = panel.querySelector("#liw-second");
    secondEl.checked = sendSecond;
    secondEl.addEventListener("change", () => {
      sendSecond = secondEl.checked;
      save();
    });

    const sugEl = panel.querySelector("#liw-suggested");
    sugEl.checked = useSuggested;
    sugEl.addEventListener("change", () => {
      useSuggested = sugEl.checked;
      save();
    });

    // timing fields
    const numBind = (id, key, mult = 1) => {
      const el = panel.querySelector(id);
      el.value = cfg[key] / mult;
      el.addEventListener("change", () => {
        const v = parseFloat(el.value);
        if (!isNaN(v)) cfg[key] = v * mult;
        save();
      });
    };
    numBind("#liw-min", "minDelayMs", 1000);
    numBind("#liw-max", "maxDelayMs", 1000);
    numBind("#liw-every", "longRestEvery", 1);
    numBind("#liw-cap", "maxPerSession", 1);
  }

  function renderRows() {
    const listEl = panel.querySelector("#liw-list");
    listEl.innerHTML = "";
    scanned.forEach((s) => {
      const row = document.createElement("label");
      row.className = "liw-row liw-row-cu";
      row.dataset.id = s.id;
      row.innerHTML = `
        <input type="checkbox" ${s.selected ? "checked" : ""}>
        <span class="liw-name"></span>
        <span class="liw-type"></span>
        <span class="liw-state"></span>
        <span class="liw-event"></span>
        <span class="liw-msg"></span>
      `;
      row.querySelector(".liw-name").textContent = s.name;
      row.querySelector(".liw-type").textContent = TYPE_LABEL[s.type];
      row.querySelector(".liw-type").classList.add("liw-type-" + s.type);
      row.querySelector(".liw-event").textContent = s.eventText;
      row.querySelector("input").addEventListener("change", (e) => {
        s.selected = e.target.checked;
        updateCount();
      });
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

  function markRow(id, state, message) {
    const row = panel.querySelector(`.liw-row[data-id="${id}"]`);
    if (!row) return;
    row.querySelector(".liw-state").textContent =
      { working: "⏳", done: "✓", error: "⚠" }[state] || "";
    const msgEl = row.querySelector(".liw-msg");
    if (msgEl) msgEl.textContent = message || "";
    row.className = "liw-row liw-row-cu liw-" + state;
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

  // ---- persistence -----------------------------------------------------
  function save() {
    try {
      chrome.storage?.local.set({
        cuCfg: cfg,
        cuTemplates: templates,
        cuAppend: appendText,
        cuSuggested: useSuggested,
        cuSecond: sendSecond,
      });
    } catch (_) {}
  }
  function load(cb) {
    try {
      chrome.storage?.local.get(
        ["cuCfg", "cuTemplates", "cuAppend", "cuSuggested", "cuSecond"],
        (r) => {
          if (r.cuCfg) cfg = { ...DEFAULTS, ...r.cuCfg };
          if (r.cuTemplates) templates = { ...TEMPLATE_DEFAULTS, ...r.cuTemplates };
          if (typeof r.cuAppend === "string") appendText = r.cuAppend;
          if (typeof r.cuSuggested === "boolean") useSuggested = r.cuSuggested;
          if (typeof r.cuSecond === "boolean") sendSecond = r.cuSecond;
          cb();
        }
      );
    } catch (_) {
      cb();
    }
  }

  load(() => buildPanel());
})();
