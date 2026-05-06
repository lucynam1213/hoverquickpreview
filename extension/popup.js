/**
 * popup.js — QuickStock Popup
 * Handles the enable/disable toggle and persists the setting via chrome.storage.
 */

const toggle = document.getElementById('toggle');

// Load saved setting when popup opens
chrome.storage.local.get('qs_enabled', (result) => {
  // Default to enabled (true) if never set
  toggle.checked = result.qs_enabled !== false;
});

// Save setting when user flips the toggle
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ qs_enabled: toggle.checked });
});
