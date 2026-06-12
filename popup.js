const SENT_URL = "https://www.linkedin.com/mynetwork/invitation-manager/sent/";
const CATCHUP_URL = "https://www.linkedin.com/mynetwork/catch-up/all/";

async function openUrl(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith(url)) {
    document.getElementById("status").textContent =
      "Already here — use the panel on the page.";
    return;
  }
  if (tab && tab.url && tab.url.includes("linkedin.com")) {
    await chrome.tabs.update(tab.id, { url });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

document.getElementById("go").addEventListener("click", () => openUrl(SENT_URL));
document.getElementById("goCatchup").addEventListener("click", () => openUrl(CATCHUP_URL));
