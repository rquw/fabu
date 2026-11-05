(function () {
  if (window.electronAPI) return;                 // desktop app: do nothing

  var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var narrow = window.matchMedia && matchMedia('(max-width: 760px)').matches;
  if (!narrow && !coarse) { desktopNudge(); return; }

  try { if (localStorage.getItem('fabu_webnudge') === 'off') return; } catch (e) {}

  function build() {
    if (document.getElementById('webNudge')) return;
    var bar = document.createElement('div');
    bar.id = 'webNudge';
    bar.innerHTML =
      '<span class="wn-txt">This works on your phone. For a long session, there is a free app for computers.</span>' +
      '<a class="wn-get" href="https://rquw.github.io/fabu/" target="_blank" rel="noopener">the app</a>' +
      '<button class="wn-x" type="button" aria-label="dismiss">&times;</button>';
    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('in'); });
    bar.querySelector('.wn-x').onclick = function () {
      bar.classList.remove('in');
      try { localStorage.setItem('fabu_webnudge', 'off'); } catch (e) {}
      setTimeout(function () { if (bar.parentNode) bar.remove(); }, 260);
    };
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);

  // Desktop browsers: every so often, suggest the app. "Not now" waits a few days.
  function desktopNudge() {
    var KEY = 'fabu_appnudge_next';
    var FIRST_AFTER = 4 * 60e3;          // let people play for a bit first
    var SNOOZE = 3 * 24 * 3600e3;
    var t = function (k, fb) { return typeof tr === 'function' ? tr(k, fb) : fb; };
    function due() {
      try { return Date.now() >= parseInt(localStorage.getItem(KEY) || '0', 10); } catch (e) { return true; }
    }
    function snooze(ms) { try { localStorage.setItem(KEY, String(Date.now() + ms)); } catch (e) {} }
    function show() {
      if (!due() || document.getElementById('appNudge')) return;
      if (document.querySelector('.modal-back')) { setTimeout(show, 30e3); return; }   // don't pile onto a dialog
      var card = document.createElement('div');
      card.id = 'appNudge';
      card.innerHTML =
        '<div class="an-title"></div><div class="an-body"></div>' +
        '<div class="an-btns"><button class="fbtn an-later" type="button"></button>' +
        '<a class="fbtn accent an-get" href="https://rquw.github.io/fabu/" target="_blank" rel="noopener"></a></div>';
      card.querySelector('.an-title').textContent = t('wn_desktop_title', 'fabu runs better as an app');
      card.querySelector('.an-body').textContent = t('wn_desktop_body', 'The download is free and gives you lower latency, saving to real files, and automatic updates.');
      card.querySelector('.an-later').textContent = t('wn_later', 'Not now');
      card.querySelector('.an-get').textContent = t('wn_get', 'Download');
      document.body.appendChild(card);
      requestAnimationFrame(function () { card.classList.add('in'); });
      var close = function (ms) {
        snooze(ms);
        card.classList.remove('in');
        setTimeout(function () { if (card.parentNode) card.remove(); }, 260);
      };
      card.querySelector('.an-later').onclick = function () { close(SNOOZE); };
      card.querySelector('.an-get').onclick = function () { close(SNOOZE * 3); };
    }
    try { if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, String(Date.now() + FIRST_AFTER)); } catch (e) {}
    setInterval(show, 60e3);
    setTimeout(show, 15e3);
  }
})();
