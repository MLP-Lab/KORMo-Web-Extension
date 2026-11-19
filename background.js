/**
 * background.js — MV3 service worker. Deliberately almost empty.
 *
 * WHY SO SMALL: an MV3 service worker is evicted by Chrome after ~30s of
 * inactivity. A multi-step agent run (screenshot -> model -> click -> repeat)
 * easily spans minutes, so the run loop CANNOT live here or it would be killed
 * mid-run. The loop lives in sidepanel.js, which is a real document that stays
 * alive for as long as the panel is open. This worker only does one thing:
 * make the toolbar button open the side panel.
 */

// setPanelBehavior tells Chrome "clicking the action icon opens the side panel".
// It must be (re)registered on install AND on every worker start-up, because a
// restarted worker is a fresh JS context.
function registerPanelBehavior() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[gui-agent] setPanelBehavior failed:', err));
}

chrome.runtime.onInstalled.addListener(registerPanelBehavior);
registerPanelBehavior();
