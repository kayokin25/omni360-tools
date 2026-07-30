/* ============================================================================
   Короткая история результатов в localStorage.

   Задача: после F5 результаты не теряются, но и складом это не становится.
   Поэтому три ограничителя сразу — по возрасту, по количеству и по объёму
   (localStorage на origin обычно ~5 МБ, и его делят все инструменты панели).
   ========================================================================== */
(function (root) {
'use strict';

const DEFAULTS = {
  maxItems: 20,
  maxDays: 7,
  maxBytes: 1500000   // ~1,5 МБ на одну историю
};

function create(key, options) {
  const opt = Object.assign({}, DEFAULTS, options || {});

  function readRaw() {
    try {
      const s = localStorage.getItem(key);
      if (!s) return [];
      const j = JSON.parse(s);
      return Array.isArray(j) ? j : [];
    } catch (e) { return []; }   // приватный режим или битые данные
  }

  function writeRaw(items) {
    try {
      localStorage.setItem(key, JSON.stringify(items));
      return true;
    } catch (e) {
      return false;   // квота или приватный режим
    }
  }

  /* Убирает просроченное и лишнее. Возвращает почищенный список. */
  function prune(items, nowMs) {
    const now = nowMs === undefined ? Date.now() : nowMs;
    const maxAge = opt.maxDays * 86400000;
    let out = items
      .filter(function (it) { return it && it.at && (now - it.at) < maxAge; })
      .sort(function (a, b) { return b.at - a.at; })
      .slice(0, opt.maxItems);

    // объём: пока не влезаем, выкидываем самое старое
    while (out.length > 1 && JSON.stringify(out).length > opt.maxBytes) out.pop();
    return out;
  }

  return {
    list: function () {
      const items = readRaw();
      const pruned = prune(items);
      if (pruned.length !== items.length) writeRaw(pruned);
      return pruned;
    },

    /* entry без id и at — проставим сами. Возвращает id или null. */
    add: function (entry) {
      const items = readRaw();
      const id = 'h' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const full = Object.assign({}, entry, { id: id, at: Date.now() });
      let next = prune([full].concat(items));

      // если запись одна и та огромная — сохранить не выйдет, честно скажем
      if (!writeRaw(next)) {
        while (next.length > 1) {
          next.pop();
          if (writeRaw(next)) return id;
        }
        return null;
      }
      return id;
    },

    get: function (id) {
      return this.list().find(function (it) { return it.id === id; }) || null;
    },

    remove: function (ids) {
      const kill = new Set([].concat(ids));
      const next = readRaw().filter(function (it) { return !kill.has(it.id); });
      writeRaw(prune(next));
    },

    clear: function () {
      try { localStorage.removeItem(key); } catch (e) { /* и не надо */ }
    },

    bytes: function () {
      try { return (localStorage.getItem(key) || '').length; } catch (e) { return 0; }
    },

    limits: opt
  };
}

/* «5 минут назад», «вчера» и т.п. */
function timeAgo(ms, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' ' + plural(m, 'минуту', 'минуты', 'минут') + ' назад';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' ' + plural(h, 'час', 'часа', 'часов') + ' назад';
  const d = Math.floor(h / 24);
  if (d === 1) return 'вчера';
  return d + ' ' + plural(d, 'день', 'дня', 'дней') + ' назад';
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

root.OmniHistory = { create: create, timeAgo: timeAgo, DEFAULTS: DEFAULTS };

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.OmniHistory;
