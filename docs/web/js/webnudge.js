// Web-only: on phones, gently note that fabu is really a desktop app.
// Never runs in the packaged desktop app (electronAPI is present there).
(function () {
  if (window.electronAPI) return;                 // desktop app: do nothing

  var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var narrow = window.matchMedia && matchMedia('(max-width: 760px)').matches;
  if (!narrow && !coarse) return;                 // desktop browser: leave it alone

  try { if (localStorage.getItem('fabu_webnudge') === 'off') return; } catch (e) {}

  function build() {
    if (document.getElementById('webNudge')) return;
    var bar = document.createElement('div');
    bar.id = 'webNudge';
    bar.innerHTML =
      '<span class="wn-txt">You are using fabu in the browser. It works best as a free app on a computer.</span>' +
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
})();
