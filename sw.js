// ═══════════════════════════════════════════════════════════════════
//  HabitSolo Service Worker  —  Background Alarm Engine  v2.0
//  Handles alarms even when the app tab is closed / phone is locked
// ═══════════════════════════════════════════════════════════════════

const SW_VERSION = 'habitsolo-sw-v2';
const ALARM_STORE_KEY = 'habitsolo_alarms';

// ── INSTALL & ACTIVATE ────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

// ── ALARM STORAGE (IndexedDB-lite via SW cache storage) ───────────
// We use a simple in-memory map + periodic check approach.
// Alarms are persisted in a special cache entry so they survive SW restarts.

let scheduledAlarms = []; // [{label, time, fireAt}]

async function loadAlarms() {
  try {
    const cache = await caches.open(SW_VERSION);
    const res = await cache.match('/sw-alarm-data');
    if (res) {
      const data = await res.json();
      scheduledAlarms = data || [];
    }
  } catch (_) { scheduledAlarms = []; }
}

async function saveAlarms() {
  try {
    const cache = await caches.open(SW_VERSION);
    await cache.put('/sw-alarm-data', new Response(JSON.stringify(scheduledAlarms), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch (_) {}
}

// ── RECEIVE MESSAGES FROM THE APP ────────────────────────────────
self.addEventListener('message', async e => {
  await loadAlarms();

  if (e.data?.type === 'SCHEDULE_ALARM') {
    const { label, time, fireAt } = e.data;

    // Remove duplicate alarms for same label+time
    scheduledAlarms = scheduledAlarms.filter(a => !(a.label === label && a.time === time));
    scheduledAlarms.push({ label, time, fireAt });
    await saveAlarms();

    console.log(`[SW] Alarm scheduled: "${label}" at ${time} (fireAt: ${new Date(fireAt).toLocaleTimeString()})`);

    // Immediately register a sync tag so the browser keeps us alive
    if (self.registration.sync) {
      try { await self.registration.sync.register('alarm-check'); } catch (_) {}
    }
  }

  if (e.data?.type === 'CANCEL_ALARM') {
    const { label, time } = e.data;
    scheduledAlarms = scheduledAlarms.filter(a => !(a.label === label && a.time === time));
    await saveAlarms();
  }

  if (e.data?.type === 'PING') {
    // App is open — check alarms immediately
    await checkAndFireAlarms();
  }
});

// ── BACKGROUND SYNC (fires when browser decides to wake the SW) ──
self.addEventListener('sync', async e => {
  if (e.tag === 'alarm-check') {
    e.waitUntil(checkAndFireAlarms());
  }
});

// ── PUSH NOTIFICATION (optional: for server-triggered alarms) ────
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || '⚡ HabitSolo', {
      body: data.body || 'Time for your task!',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'habitsolo-push',
      requireInteraction: true,
      actions: [
        { action: 'open', title: '✅ Open App' },
        { action: 'dismiss', title: '✕ Dismiss' }
      ]
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // If app is open, focus it and trigger alarm overlay
      for (const client of clients) {
        if (client.url.includes('habbit-tracking') || client.url.includes('localhost')) {
          client.focus();
          client.postMessage({ type: 'ALARM_FIRE', label: e.notification.body, time: '' });
          return;
        }
      }
      // Otherwise open the app
      return self.clients.openWindow('https://habbit-tracking-7d28b.web.app/');
    })
  );
});

// ── CORE: CHECK & FIRE DUE ALARMS ────────────────────────────────
async function checkAndFireAlarms() {
  await loadAlarms();
  const now = Date.now();
  const toFire = [];
  const remaining = [];

  for (const alarm of scheduledAlarms) {
    if (now >= alarm.fireAt) {
      toFire.push(alarm);
    } else {
      remaining.push(alarm);
    }
  }

  if (toFire.length === 0) return;

  // Update stored alarms (remove fired ones)
  scheduledAlarms = remaining;
  await saveAlarms();

  // Fire all due alarms
  for (const alarm of toFire) {
    await fireAlarm(alarm);
  }
}

async function fireAlarm(alarm) {
  const label = alarm.label || 'Your task';
  const time = alarm.time || '';

  // 1. Show persistent notification (works on locked screen)
  await self.registration.showNotification('⏰ HabitSolo Alarm', {
    body: `🔔 ${label}`,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [300, 100, 300, 100, 300, 100, 300],
    tag: `alarm-${alarm.fireAt}`,
    requireInteraction: true,  // stays until user dismisses
    silent: false,
    actions: [
      { action: 'dismiss', title: '✅ Done for now' },
      { action: 'open', title: '🚀 Open App' }
    ],
    data: { label, time }
  });

  // 2. If app is open, also trigger the in-app alarm overlay
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'ALARM_FIRE', label, time });
  }
}

// ── PERIODIC SELF-WAKE (re-register sync every minute while alive) ─
// This creates a "heartbeat" so the SW doesn't go to sleep
setInterval(async () => {
  await checkAndFireAlarms();
  if (scheduledAlarms.length > 0 && self.registration.sync) {
    try { await self.registration.sync.register('alarm-check'); } catch (_) {}
  }
}, 30000); // check every 30 seconds while SW is alive
