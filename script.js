// ============================================================
// GlobalVisions — micro-interactions powered by anime.js
// ============================================================

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

document.getElementById("year").textContent = new Date().getFullYear();

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch = window.matchMedia("(hover: none)").matches;

// ---------- Hero particle network ----------
(() => {
  const canvas = document.getElementById("grid-canvas");
  const ctx = canvas.getContext("2d");

  const CONNECTION_DIST = 190;
  const CURSOR_RADIUS_BASE = 220;
  const FRICTION = 0.96;
  const REACH_MULTIPLIER = 3.6; // energized particles reach up to ~4x further to form new structures
  const GROW_DURATION = 500;  // ms — speed at which the web weaves itself in
  const GROW_START = 0.45;    // fraction of CONNECTION_DIST already active at t=0

  // Cursor energy — fast inhale on activity, slow exhale when the cursor leaves
  const ENERGY_RISE = 0.08;   // ~200ms to full
  const ENERGY_FALL = 0.005;  // ~3.3s back to zero
  let cursorEnergy = 0;
  let active = false;

  const startTime = performance.now();
  function currentConnectionDist() {
    const elapsed = performance.now() - startTime;
    if (elapsed >= GROW_DURATION) return CONNECTION_DIST;
    const t = elapsed / GROW_DURATION;
    const eased = 1 - Math.pow(1 - t, 2); // easeOutQuad
    return CONNECTION_DIST * (GROW_START + (1 - GROW_START) * eased);
  }

  let particles = [];
  let w = 0, h = 0;
  const mouse = { x: -9999, y: -9999 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const target = Math.round((w * h) / 10500);
    const count = Math.min(220, Math.max(60, target));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.1 + 0.5,
      drift: Math.random() * Math.PI * 2,
    }));
  }
  resize();
  window.addEventListener("resize", resize);

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    active = true;
  });
  window.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) active = false;
  });

  window.addEventListener("scroll", () => {
    const fade = Math.max(0.18, 1 - (window.scrollY / window.innerHeight) * 0.85);
    canvas.style.opacity = String(0.65 * fade);
  }, { passive: true });

  function frame() {
    // Energy: fast inhale, slow exhale — the cluster breathes on hover and
    // disperses gradually when the cursor leaves.
    cursorEnergy = active
      ? Math.min(1, cursorEnergy + ENERGY_RISE)
      : Math.max(0, cursorEnergy - ENERGY_FALL);

    // Field of influence: a local zone around the cursor that energizes the particles inside it
    const effRadius = CURSOR_RADIUS_BASE * (0.55 + cursorEnergy * 0.9);
    const effRadius2 = effRadius * effRadius;

    ctx.clearRect(0, 0, w, h);

    // Update — organic drift, plus a gentle outward push on energized particles
    // so the spacing inside the hovered cluster widens.
    for (const p of particles) {
      p.drift += 0.008;
      p.vx += Math.cos(p.drift + p.y * 0.003) * 0.014;
      p.vy += Math.sin(p.drift + p.x * 0.003) * 0.014;

      // Per-particle energy from cursor proximity, plus radial widening force
      if (cursorEnergy > 0) {
        const dx = mouse.x - p.x;
        const dy = mouse.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < effRadius2) {
          const d = Math.sqrt(d2) || 1;
          p.influence = (1 - d / effRadius) * cursorEnergy;
          const push = p.influence * 0.05;
          p.vx -= (dx / d) * push;
          p.vy -= (dy / d) * push;
        } else {
          p.influence = 0;
        }
      } else {
        p.influence = 0;
      }

      p.vx *= FRICTION;
      p.vy *= FRICTION;
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < -20) p.x = w + 20;
      else if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      else if (p.y > h + 20) p.y = -20;
    }

    // Connections — distance grows in over GROW_DURATION, and energized particles
    // stretch their reach by REACH_MULTIPLIER, sprouting new edges to distant nodes.
    const cd = currentConnectionDist();
    const connDist2 = cd * cd;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;

        const maxInf = a.influence > b.influence ? a.influence : b.influence;
        if (maxInf > 0) {
          // Energized branch: extended reach so the cluster's edges sprout long lines
          const reach = cd * (1 + maxInf * REACH_MULTIPLIER);
          if (d2 >= reach * reach) continue;
          const d = Math.sqrt(d2);
          const fade = 1 - d / reach;
          ctx.strokeStyle = `rgba(255, 93, 46, ${fade * (0.5 * maxInf + 0.08)})`;
          ctx.lineWidth = 0.6 + maxInf * 0.9;
        } else {
          if (d2 >= connDist2) continue;
          const d = Math.sqrt(d2);
          const fade = 1 - d / cd;
          ctx.strokeStyle = `rgba(245, 243, 238, ${fade * 0.12})`;
          ctx.lineWidth = 0.6;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Particles — energized ones grow and glow accent
    for (const p of particles) {
      let radius = p.r;
      let color = `rgba(245, 243, 238, 0.45)`;
      if (p.influence > 0) {
        radius = p.r * (1 + p.influence * 2.6);
        color = `rgba(255, 93, 46, ${0.5 + p.influence * 0.5})`;
      }
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(frame);
  }

  if (!prefersReduced) {
    frame();
  } else {
    for (const p of particles) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(245, 243, 238, 0.35)`;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
})();

// ---------- Custom cursor ----------
(() => {
  if (isTouch) return;
  const cursor = document.querySelector(".cursor");
  const dot = document.querySelector(".cursor-dot");
  let mx = 0, my = 0;
  let cx = 0, cy = 0;
  window.addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; });
  function loop() {
    cx += (mx - cx) * 0.18;
    cy += (my - cy) * 0.18;
    cursor.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
    dot.style.transform = `translate(${mx}px, ${my}px) translate(-50%, -50%)`;
    requestAnimationFrame(loop);
  }
  loop();

  document.querySelectorAll("a, button, [data-magnetic]").forEach((el) => {
    el.addEventListener("mouseenter", () => cursor.classList.add("is-hover"));
    el.addEventListener("mouseleave", () => cursor.classList.remove("is-hover"));
  });
})();

// ---------- Magnetic hover on buttons / cta ----------
(() => {
  if (isTouch || prefersReduced) return;
  document.querySelectorAll("[data-magnetic]").forEach((el) => {
    const strength = 18;
    el.addEventListener("mousemove", (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - (rect.left + rect.width / 2);
      const y = e.clientY - (rect.top + rect.height / 2);
      anime({
        targets: el,
        translateX: (x / rect.width) * strength,
        translateY: (y / rect.height) * strength,
        duration: 400,
        easing: "easeOutQuad",
      });
    });
    el.addEventListener("mouseleave", () => {
      anime({
        targets: el,
        translateX: 0,
        translateY: 0,
        duration: 700,
        easing: "easeOutElastic(1, 0.5)",
      });
    });
  });
})();

// ---------- Initial hero reveal ----------
(() => {
  const heroSplits = document.querySelectorAll(".hero [data-split]");
  const tl = anime.timeline({
    easing: "cubicBezier(0.22, 1, 0.36, 1)",
    complete: () => {
      document.querySelectorAll(".hero .line").forEach((l) => (l.style.overflow = "visible"));
    },
  });

  tl.add({
    targets: ".hero [data-reveal]",
    opacity: [0, 1],
    translateY: [16, 0],
    duration: 700,
    delay: 100,
  })
  .add({
    targets: heroSplits,
    translateY: ["110%", "0%"],
    duration: 1100,
    delay: anime.stagger(90),
  }, "-=500")
  .add({
    targets: ".hero [data-fade]",
    opacity: [0, 1],
    translateY: [20, 0],
    duration: 800,
    delay: anime.stagger(120),
  }, "-=700");
})();

// ---------- Scroll-triggered reveals ----------
(() => {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;

      const splits = el.querySelectorAll("[data-split]");
      if (splits.length) {
        anime({
          targets: splits,
          translateY: ["110%", "0%"],
          duration: 1000,
          delay: anime.stagger(80),
          easing: "cubicBezier(0.22, 1, 0.36, 1)",
          complete: () => {
            el.querySelectorAll(".line").forEach((l) => (l.style.overflow = "visible"));
          },
        });
      }

      const reveals = el.querySelectorAll("[data-reveal]");
      if (reveals.length) {
        anime({
          targets: reveals,
          opacity: [0, 1],
          translateY: [16, 0],
          duration: 800,
          delay: anime.stagger(80),
          easing: "cubicBezier(0.22, 1, 0.36, 1)",
        });
      }

      const fades = el.querySelectorAll("[data-fade]");
      if (fades.length) {
        anime({
          targets: fades,
          opacity: [0, 1],
          translateY: [20, 0],
          duration: 900,
          delay: anime.stagger(100, { start: 200 }),
          easing: "cubicBezier(0.22, 1, 0.36, 1)",
        });
      }

      const cards = el.querySelectorAll("[data-card]");
      if (cards.length) {
        anime({
          targets: cards,
          opacity: [0, 1],
          translateY: [40, 0],
          duration: 900,
          delay: anime.stagger(120, { start: 200 }),
          easing: "cubicBezier(0.22, 1, 0.36, 1)",
        });
      }

      const metrics = el.querySelectorAll("[data-metric]");
      if (metrics.length) {
        anime({
          targets: metrics,
          opacity: [0, 1],
          translateY: [30, 0],
          duration: 800,
          delay: anime.stagger(120, { start: 200 }),
          easing: "cubicBezier(0.22, 1, 0.36, 1)",
        });
        // Animate counters
        metrics.forEach((m) => {
          const counter = m.querySelector(".counter");
          if (!counter) return;
          const target = parseInt(counter.dataset.to, 10);
          const obj = { val: 0 };
          anime({
            targets: obj,
            val: target,
            round: 1,
            duration: 4500,
            delay: 400,
            easing: "cubicBezier(0.22, 1, 0.36, 1)",
            update: () => (counter.textContent = obj.val),
          });
        });
      }

      io.unobserve(el);
    });
  }, { threshold: 0.18 });

  // Observe each section (skip hero — already animated)
  document.querySelectorAll(".section, .cta, .trust").forEach((s) => io.observe(s));
})();

// ---------- Subtle parallax on hero title ----------
(() => {
  if (prefersReduced || isTouch) return;
  const title = document.querySelector(".hero__title");
  if (!title) return;
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    if (y > window.innerHeight) return;
    title.style.transform = `translateY(${y * 0.15}px)`;
    title.style.opacity = Math.max(0, 1 - y / (window.innerHeight * 0.8));
  }, { passive: true });
})();
