// ============================================================
// GlobalVisions — micro-interactions powered by anime.js
// ============================================================

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

document.getElementById("year").textContent = new Date().getFullYear();

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch = window.matchMedia("(hover: none)").matches;

// ---------- Background grid canvas ----------
(() => {
  const canvas = document.getElementById("grid-canvas");
  const ctx = canvas.getContext("2d");
  let w, h, cols, rows;
  const gap = 42;
  const mouse = { x: -9999, y: -9999 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = window.innerWidth * dpr;
    h = canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.scale(dpr, dpr);
    cols = Math.ceil(window.innerWidth / gap) + 1;
    rows = Math.ceil(window.innerHeight / gap) + 1;
  }
  resize();
  window.addEventListener("resize", resize);

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = i * gap;
        const y = j * gap;
        const dx = x - mouse.x;
        const dy = y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = dist < 160 ? 2.4 - dist / 160 * 1.6 : 0.8;
        const alpha = dist < 220 ? 0.55 - dist / 220 * 0.4 : 0.15;
        const orange = dist < 140;
        ctx.beginPath();
        ctx.fillStyle = orange
          ? `rgba(255, 93, 46, ${0.7 - dist / 140 * 0.5})`
          : `rgba(245, 243, 238, ${alpha})`;
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }
  if (!prefersReduced) draw();
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
            duration: 1600,
            delay: 300,
            easing: "easeOutExpo",
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
