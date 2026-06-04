// Section highlight on scroll. ~30 lines.
(function () {
  var links = document.querySelectorAll('#topnav a[href^="#"]');
  var map = {};
  links.forEach(function (a) {
    var id = a.getAttribute('href').slice(1);
    var sec = document.getElementById(id);
    if (sec) map[id] = a;
  });

  var current = null;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        var id = e.target.id;
        if (current && current !== map[id]) current.classList.remove('active');
        if (map[id]) {
          map[id].classList.add('active');
          current = map[id];
        }
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });

  Object.keys(map).forEach(function (id) {
    io.observe(document.getElementById(id));
  });
})();
