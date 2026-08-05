// Web-only: on phones, note that there is a desktop app.
// The wording matters. It used to say the phone version does not really work,
// which was true then and is not now: dragging, the piano roll and the loops
// all work with a finger. So it points at the app as the better tool for a long
// session rather than as the only one that functions.
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
})();
