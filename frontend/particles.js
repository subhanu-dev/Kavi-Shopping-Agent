/**
 * Particles — Subtle floating dots in the background
 * Adds depth and a premium dynamic feel to the UI.
 */
(function () {
  const canvas = document.getElementById("particles-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  let particles = [];
  let animId = null;
  let w, h;

  const CONFIG = {
    count: 40,
    minRadius: 1.5,
    maxRadius: 3.5,
    speed: 0.15,
    colors: [
      "rgba(64, 41, 112, 0.12)",
      "rgba(91, 61, 153, 0.1)",
      "rgba(248, 218, 8, 0.1)",
      "rgba(139, 92, 246, 0.08)",
    ],
    lineDistance: 120,
    lineOpacity: 0.04,
  };

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }

  function createParticle() {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      r: CONFIG.minRadius + Math.random() * (CONFIG.maxRadius - CONFIG.minRadius),
      dx: (Math.random() - 0.5) * CONFIG.speed,
      dy: (Math.random() - 0.5) * CONFIG.speed,
      color: CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)],
      phase: Math.random() * Math.PI * 2,
    };
  }

  function init() {
    resize();
    particles = [];
    for (let i = 0; i < CONFIG.count; i++) {
      particles.push(createParticle());
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);

    // Draw connection lines between nearby particles
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONFIG.lineDistance) {
          const opacity = CONFIG.lineOpacity * (1 - dist / CONFIG.lineDistance);
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(64, 41, 112, ${opacity})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // Draw particles
    const time = Date.now() * 0.001;
    for (const p of particles) {
      // Gentle breathing effect
      const breathe = 1 + 0.2 * Math.sin(time * 0.8 + p.phase);
      const radius = p.r * breathe;

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();

      // Move
      p.x += p.dx;
      p.y += p.dy;

      // Wrap around edges
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;
    }

    animId = requestAnimationFrame(draw);
  }

  window.addEventListener("resize", () => {
    resize();
  });

  // Reduce animation when tab is hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(animId);
    } else {
      draw();
    }
  });

  init();
  draw();
})();
