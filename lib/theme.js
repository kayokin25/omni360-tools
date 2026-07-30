/* Тема инструмента.

   Инструмент открывается либо внутри панели (в iframe), либо отдельной
   страницей. Поэтому тему берём по порядку:
     1. #theme=... в адресе — так панель задаёт тему сразу, без мигания;
     2. сохранённая в localStorage — для отдельной страницы;
     3. системная настройка.

   Панель при переключении присылает postMessage — применяем на лету, чтобы
   открытый инструмент не перезагружался и не терял результаты. */
(function (root) {
'use strict';

const KEY = 'omni360.theme';

function fromHash() {
  const m = /(?:^|[#&])theme=(light|dark)\b/.exec(root.location.hash || '');
  return m ? m[1] : null;
}

function fromStorage() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch (e) { return null; }   // приватный режим
}

function fromSystem() {
  try {
    return root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light' : 'dark';
  } catch (e) { return 'dark'; }
}

/* current объявляем ДО apply(): apply() его присваивает, а обращение к let-
   переменной до инициализации — ReferenceError. Раньше здесь было
   `let current = apply(...)`, и скрипт падал сразу после setAttribute: тема
   применялась, но слушатель postMessage уже не регистрировался. */
let current = 'dark';

function apply(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  current = t;
  return t;
}

apply(fromHash() || fromStorage() || fromSystem());

/* Панель сообщает о переключении. Сообщения приходят от родительского
   документа панели; проверяем только форму — данных тут нет, лишь имя темы. */
root.addEventListener('message', function (e) {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.omniTheme !== 'light' && d.omniTheme !== 'dark') return;
  apply(d.omniTheme);
});

root.OmniTheme = {
  get: function () { return current; },
  apply: apply,
  /* Для отдельной страницы: запомнить выбор. Внутри панели выбор хранит панель. */
  save: function (theme) {
    const t = apply(theme);
    try { localStorage.setItem(KEY, t); } catch (e) { /* приватный режим */ }
    return t;
  },
  isEmbedded: function () {
    try { return root.parent !== root; } catch (e) { return true; }
  }
};

})(typeof globalThis !== 'undefined' ? globalThis : this);
