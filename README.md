# LinkedIn Network Helper

A Manifest V3 Chrome extension with two tools that automate tedious LinkedIn
network chores **with human-like timing**, so the activity doesn't look like an
automated burst:

1. **Invitation Withdrawer** — bulk-withdraw pending invitations you've sent.
2. **Catch-up Messenger** — send congrats messages (new job / work anniversary /
   birthday) to people on your Catch-up page, with per-event templates.

Everything runs locally in your own browser, on pages you're already logged
into. Nothing is sent to any external server.

> ⚠️ **Use responsibly.** Automating writes on LinkedIn (withdrawing,
> messaging) can get accounts rate-limited or restricted. Keep batches small,
> keep the delays long, and stop if LinkedIn shows any warning. Human-like
> timing reduces risk but cannot guarantee you won't be flagged.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension. Click it to jump to either tool's page.

---

## Tool 1 — Invitation Withdrawer

Page: `https://www.linkedin.com/mynetwork/invitation-manager/sent/`

1. Click **Scan page** — lists each pending invitation with **name** and
   **"Sent … ago"**.
2. Use the **age filter chips** (1 week … 5 months) to select everything older
   than a threshold, or tick rows manually / **Select all**.
3. Click **Process selected**. Each is withdrawn one at a time:
   scrolls into view → realistic pointer click → confirms the popup →
   randomized 4–9s wait, with a longer break every 8.

LinkedIn paginates this page, so the flow is: Scan → Process → next page →
Scan again.

## Tool 2 — Catch-up Messenger

Page: `https://www.linkedin.com/mynetwork/catch-up/all/`

1. Click **Scan page** — lists each card with **name**, an **event-type tag**
   (New job / Anniversary / Birthday / Other) and the event text.
2. Edit the **per-event templates** (use `{name}` for the first name), and
   optionally add a **note / pitch**.
   - **Append** it to the message, or tick **"Send my note as a separate 2nd
     message"** to send it as a follow-up.
   - Tick **"Keep LinkedIn's suggested text"** to use LinkedIn's wording instead
     of your templates.
3. Select people and click **Send to selected**. For each: opens the composer
   (pre-filled via the compose URL), corrects the text in the editor, sends,
   then closes the overlay before moving on. Slower-paced (8–16s) than
   withdrawing on purpose.

### Notes on how it works
- The catch-up composer is rendered inside a **shadow root**, so the extension
  uses a shadow-DOM-piercing query (`deepQueryAll`) to find the editor, send,
  close button, and recipient.
- Sending uses `form.requestSubmit()` (the overlay is "Press Enter to Send" and
  has no Send button in draft state), with a synthetic-Enter fallback.
- A **recipient check** verifies the open box is addressed to the right person
  before sending — it will skip rather than message the wrong person.

---

## Files

- `manifest.json` — MV3 manifest; content scripts scoped to the two pages
- `content.js` — Invitation Withdrawer panel + logic
- `catchup.js` — Catch-up Messenger panel + logic
- `panel.css` — shared panel styling
- `popup.html` / `popup.js` — toolbar popup that opens either page

## If a "Scan" finds nothing

LinkedIn changes its HTML often. The scanners key off stable signals (the
"Withdraw" label / aria-label, the `/messaging/compose` links) rather than
hashed CSS classes — but if LinkedIn renames those, update the relevant
`find*` function in `content.js` / `catchup.js`.
