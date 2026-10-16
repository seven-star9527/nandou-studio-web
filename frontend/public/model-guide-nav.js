(() => {
  'use strict';
  const headings = [...document.querySelectorAll('main h1[id], main h2[id]')];
  if (headings.length < 2) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 1101px)');
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
  const shortLabels = ['创作概览', '模型比较', '电商选型', '规格与参考图', '出图流程', '公开评分'];
  const nav = document.createElement('nav');
  nav.className = 'chapter-map'; nav.setAttribute('aria-label', '章节导航');
  const shade = document.createElement('div'); shade.className = 'chapter-shade'; shade.setAttribute('aria-hidden', 'true'); nav.append(shade);
  const summary = document.createElement('span'); summary.className = 'chapter-map-summary'; summary.textContent = 'ON THIS PAGE'; summary.setAttribute('aria-hidden', 'true'); nav.append(summary);
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = '650 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  const sections = headings.map((heading, index) => {
    const label = shortLabels[index] ?? heading.textContent.trim().slice(0, 8);
    const link = document.createElement('a'); link.href = '#' + encodeURIComponent(heading.id); link.className = 'chapter-link'; link.setAttribute('aria-label', '跳转至 ' + heading.textContent.trim()); link.title = heading.textContent.trim();
    const characters = [...label];
    const letters = characters.map(char => { const span = document.createElement('span'); span.className = 'chapter-letter'; span.textContent = char; span.setAttribute('aria-hidden', 'true'); link.append(span); return span; });
    const advances = characters.map(char => measure.measureText(char).width);
    const before = advances.map((_, i) => advances.slice(0, i).reduce((sum, n) => sum + n, 0));
    const total = advances.reduce((sum, n) => sum + n, 0);
    const hit = document.createElement('span'); hit.className = 'chapter-hit'; hit.setAttribute('aria-hidden', 'true'); link.append(hit); nav.append(link);
    link.addEventListener('click', event => { event.preventDefault(); jump(heading); });
    return { heading, link, letters, advances, before, total, hit, anchor: 0, short: label };
  });
  document.body.append(nav);
  const mobile = document.createElement('nav'); mobile.className = 'chapter-mobile'; mobile.setAttribute('aria-label', '章节选择');
  const mobileLabel = document.createElement('span'); mobileLabel.className = 'chapter-mobile-label'; mobileLabel.textContent = 'CHAPTER'; mobileLabel.setAttribute('aria-hidden', 'true');
  const select = document.createElement('select'); select.setAttribute('aria-label', '跳转章节');
  sections.forEach(({ heading }, i) => { const option = document.createElement('option'); option.value = String(i); option.textContent = heading.textContent.trim(); select.append(option); });
  select.addEventListener('change', () => jump(sections[Number(select.value)].heading));
  const mobilePercent = document.createElement('span'); mobilePercent.className = 'chapter-percent-label';
  const mobileBar = document.createElement('div'); mobileBar.className = 'chapter-mobile-progress'; mobileBar.setAttribute('aria-hidden', 'true');
  mobile.append(mobileLabel, select, mobilePercent, mobileBar);
  document.querySelector('.topbar').after(mobile);
  const ruler = document.createElement('div'); ruler.className = 'chapter-ruler'; ruler.role = 'scrollbar'; ruler.tabIndex = 0;
  ruler.setAttribute('aria-label', '文档阅读进度'); ruler.setAttribute('aria-orientation', 'vertical'); ruler.setAttribute('aria-valuemin', '0'); ruler.setAttribute('aria-valuemax', '100'); ruler.setAttribute('aria-controls', 'guide-content');
  document.querySelector('main').id ||= 'guide-content';
  const ticks = Array.from({ length: 101 }, (_, pct) => {
    const tick = document.createElement('div'); tick.className = 'chapter-tick' + (pct % 5 === 0 ? ' major' : ''); tick.setAttribute('aria-hidden', 'true');
    const line = document.createElement('span'); line.className = 'chapter-tick-line'; tick.append(line);
    if (pct % 5 === 0) { const label = document.createElement('span'); label.className = 'chapter-tick-label'; label.textContent = String(pct); tick.append(label); }
    ruler.append(tick); return { tick, line, pct };
  });
  const indicator = document.createElement('div'); indicator.className = 'chapter-progress'; indicator.setAttribute('aria-hidden', 'true');
  const percent = document.createElement('span'); percent.className = 'chapter-percent';
  const digits = Array.from({ length: 3 }, () => { const outer = document.createElement('span'); outer.className = 'chapter-digit'; const track = document.createElement('span'); track.className = 'chapter-digit-track'; for (let n = 0; n <= 9; n++) { const digit = document.createElement('span'); digit.textContent = String(n); track.append(digit); } outer.append(track); percent.append(outer); return track; });
  percent.append('%'); indicator.append(percent); ruler.append(indicator);
  const ghost = document.createElement('div'); ghost.className = 'chapter-ghost'; ghost.setAttribute('aria-hidden', 'true'); ruler.append(ghost);
  document.body.append(ruler);
  document.documentElement.classList.add('has-chapter-nav');
  let docHeight = 1, height = 1, navTop = 76, raf = 0, last = performance.now(), lastScroll = scrollY, velocity = 0;
  let zoom = 0, zoomTarget = 0, dragging = false, pointerY = 0, active = -1, oldPct = -1;
  let movingUntil = 0;
  function jump(heading) {
    const offset = desktop.matches ? 112 : 145;
    scrollTo({ top: Math.max(0, heading.getBoundingClientRect().top + scrollY - offset), behavior: reduced.matches ? 'instant' : 'smooth' });
    history.replaceState(null, '', '#' + encodeURIComponent(heading.id));
    movingUntil = performance.now() + 1200; schedule();
  }
  function dimensions() {
    height = innerHeight; navTop = desktop.matches ? 76 : document.querySelector('.topbar').getBoundingClientRect().height;
    docHeight = document.documentElement.scrollHeight;
    sections.forEach(section => { section.anchor = section.heading.getBoundingClientRect().top + scrollY; });
    schedule();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(update); }
  function update(now) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
    const y = scrollY, range = Math.max(1, docHeight - height), progress = clamp(y / range), paneH = height - navTop;
    velocity += ((y - lastScroll) / dt - velocity) * (1 - Math.exp(-6 * dt)); lastScroll = y;
    const desiredZoom = desktop.matches && !reduced.matches ? zoomTarget : 0;
    zoom += (desiredZoom - zoom) * (1 - Math.exp(-dt / 0.15));
    if (Math.abs(zoom - desiredZoom) < 0.001) zoom = desiredZoom;
    const pad = 30, span = Math.max(1, paneH - pad * 2);
    const threshold = navTop + Math.min(175, paneH * 0.23);
    let nextActive = 0;
    for (let i = 0; i < sections.length; i++) if (sections[i].anchor <= y + threshold) nextActive = i;
    if (progress > 0.995) nextActive = sections.length - 1;
    if (nextActive !== active) {
      active = nextActive;
      sections.forEach((section, i) => { if (i === active) section.link.setAttribute('aria-current', 'location'); else section.link.removeAttribute('aria-current'); });
      select.value = String(active);
    }
    const pct = Math.round(progress * 100);
    if (oldPct !== pct) {
      ruler.setAttribute('aria-valuenow', String(pct)); ruler.setAttribute('aria-valuetext', `${pct}% · ${sections[active].heading.textContent.trim()}`);
      const text = String(pct).padStart(3, '0'); digits.forEach((digit, i) => { digit.style.transform = `translateY(-${text[i]}em)`; });
      mobilePercent.textContent = `${pct}%`; oldPct = pct;
    }
    mobileBar.style.transform = `scaleX(${progress})`;
    if (desktop.matches) {
      summary.style.opacity = String(1 - zoom * 0.7);
      const row = 26, top = 38, bottom = paneH - 50, mapK = ease(zoom);
      sections.forEach((section, index) => {
        const isCurrent = index === active;
        const queueY = bottom - (sections.length - 1 - index) * 24;
        const rideY = section.anchor - y - navTop;
        const rideScale = 0.68, small = 0.56;
        const flip = index === 0 ? 1 : clamp((top + 150 - rideY) / 110);
        const detach = index === 0 ? 1 : clamp((queueY + 75 - (rideY + section.total * rideScale)) / 95);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        section.letters.forEach((letter, i) => {
          const advance = section.before[i] + section.advances[i] / 2;
          let x, py, rot, scale, opacity;
          if (reduced.matches) {
            scale = isCurrent ? 0.8 : small; x = 252 - 75 - (section.total - advance) * scale; py = top + index * 34; rot = 0; opacity = isCurrent ? 1 : 0.55;
          } else if (flip > 0) {
            const stagger = 0.06, t = ease(clamp(flip * (1 + (section.letters.length - 1) * stagger) - (section.letters.length - 1 - i) * stagger));
            const finalScale = isCurrent ? 0.9 : small;
            const fromX = 252 - 80, fromY = rideY + (section.total - advance) * rideScale;
            const toX = 252 - 75 - (section.total - advance) * finalScale;
            const toY = top + index * row + (index === active ? 10 : 0);
            const inverse = 1 - t;
            x = inverse * inverse * fromX + 2 * inverse * t * (fromX - 50) + t * t * toX;
            py = inverse * inverse * fromY + 2 * inverse * t * ((fromY + toY) / 2) + t * t * toY;
            rot = -90 * (1 - t); scale = rideScale + (finalScale - rideScale) * t; opacity = isCurrent ? 1 : 0.4;
          } else {
            const t = ease(detach);
            const queuedX = 252 - 75 - (section.total - advance) * small;
            const ridingY = rideY + (section.total - advance) * rideScale;
            x = queuedX + (252 - 80 - queuedX) * t;
            py = queueY + (ridingY - queueY) * t;
            rot = -90 * t; scale = small + (rideScale - small) * t; opacity = 0.48 + 0.18 * t;
          }
          const mapY = pad + section.anchor / docHeight * span;
          const mapX = 252 - 75 - (section.total - advance) * small;
          x += (mapX - x) * mapK; py += (mapY - py) * mapK; rot *= 1 - mapK; scale += (small - scale) * mapK;
          letter.style.transform = `translate3d(${x.toFixed(2)}px,${py.toFixed(2)}px,0) translate(-50%,-50%) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
          letter.style.opacity = String(isCurrent ? 1 : opacity + (0.75 - opacity) * mapK);
          const horizontal = Math.abs(rot) < 45, halfWidth = horizontal ? section.advances[i] * scale / 2 : 11 * scale;
          const halfHeight = horizontal ? 11 * scale : section.advances[i] * scale / 2;
          minX = Math.min(minX, x - halfWidth); maxX = Math.max(maxX, x + halfWidth); minY = Math.min(minY, py - halfHeight); maxY = Math.max(maxY, py + halfHeight);
        });
        section.hit.style.transform = `translate3d(${minX - 6}px,${minY - 8}px,0)`; section.hit.style.width = `${maxX - minX + 12}px`; section.hit.style.height = `${maxY - minY + 16}px`;
      });
      const currentY = pad + progress * span;
      indicator.style.transform = `translate3d(0,${currentY}px,0)`;
      ticks.forEach(({ tick, line, pct: value }) => {
        const normalY = docHeight * value / 100 - y + pad - 2 * pad * progress;
        const mapY = pad + span * value / 100;
        const py = normalY + (mapY - normalY) * mapK;
        tick.style.transform = `translate3d(0,${py.toFixed(2)}px,0)`;
        const proximity = Math.max(0, 1 - Math.abs(py - currentY) / 170);
        const stretch = reduced.matches ? 1 : 1 + Math.min(1, Math.abs(velocity) / 2800) * proximity * 1.3;
        line.style.transform = `scaleX(${stretch.toFixed(3)})`;
        line.style.opacity = String(value % 5 === 0 ? 0.65 : 0.27 + 0.25 * proximity);
        tick.style.visibility = py < -20 || py > paneH + 20 ? 'hidden' : 'visible';
      });
      ghost.style.transform = `translate3d(0,${pointerY - navTop}px,0)`; ghost.style.opacity = String(zoomTarget ? 0.6 : 0);
    }
    if (Math.abs(zoom - desiredZoom) > 0.001 || Math.abs(velocity) > 5 || now < movingUntil) schedule();
  }
  function scrub(clientY, smooth) {
    const paneH = height - navTop, fraction = clamp((clientY - navTop - 30) / Math.max(1, paneH - 60));
    scrollTo({ top: fraction * Math.max(1, docHeight - height), behavior: smooth && !reduced.matches ? 'smooth' : 'instant' });
    movingUntil = performance.now() + 1200; schedule();
  }
  ruler.addEventListener('pointerenter', () => { zoomTarget = 1; schedule(); });
  ruler.addEventListener('pointerleave', () => { if (!dragging) zoomTarget = 0; schedule(); });
  ruler.addEventListener('pointermove', event => { pointerY = event.clientY; if (dragging) scrub(event.clientY, false); schedule(); });
  ruler.addEventListener('pointerdown', event => { event.preventDefault(); dragging = true; zoomTarget = 1; pointerY = event.clientY; ruler.setPointerCapture(event.pointerId); scrub(event.clientY, false); });
  function release(event) { dragging = false; if (ruler.hasPointerCapture(event.pointerId)) ruler.releasePointerCapture(event.pointerId); zoomTarget = ruler.matches(':hover') ? 1 : 0; schedule(); }
  ruler.addEventListener('pointerup', release); ruler.addEventListener('pointercancel', release);
  ruler.addEventListener('keydown', event => {
    const actions = { ArrowDown: scrollY + 90, ArrowUp: scrollY - 90, PageDown: scrollY + height * 0.8, PageUp: scrollY - height * 0.8, Home: 0, End: docHeight - height };
    if (event.key in actions) { event.preventDefault(); scrollTo({ top: actions[event.key], behavior: 'instant' }); schedule(); }
  });
  addEventListener('scroll', schedule, { passive: true }); addEventListener('resize', dimensions);
  reduced.addEventListener('change', dimensions); desktop.addEventListener('change', dimensions);
  const observer = new ResizeObserver(dimensions); observer.observe(document.querySelector('main'));
  document.fonts.ready.then(dimensions);
  for (const image of document.images) if (!image.complete) image.addEventListener('load', dimensions, { once: true });
  addEventListener('pageshow', dimensions);
  dimensions();
})();
