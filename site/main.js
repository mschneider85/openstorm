// Release details, the navigation shadow and sections fading in while scrolling.
document.documentElement.classList.add('js');

const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of document.querySelectorAll('.section h2, .flow, .feature, .shot, .need, .step, .program, .faq, .closing')) {
    el.classList.add('reveal');
    observer.observe(el);
  }
}

// Date and size of the current image, from the GitHub release.
fetch('https://api.github.com/repos/mschneider85/openstorm/releases/tags/pi-image')
  .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
  .then((release) => {
    const asset = release.assets.find((a) => a.name === 'openstorm-pi.img.xz');
    if (!asset) return;
    const date = new Date(asset.updated_at).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
    const size = Math.round(asset.size / 1e6);
    const info = document.getElementById('release');
    info.firstChild.textContent = `Stand ${date} · ${size} MB · `;
  })
  .catch(() => {
    // The static text stays.
  });

// The page used to be the app itself; its service worker would keep showing the old app.
navigator.serviceWorker?.getRegistrations().then((registrations) => {
  for (const registration of registrations) {
    if (new URL(registration.scope).pathname === new URL('.', location.href).pathname) registration.unregister();
  }
});
