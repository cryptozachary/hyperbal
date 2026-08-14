// Hand-rolled canvas chart. No library, per the project's stated constraint.

export function createChart(canvas) {
  let points = [];
  let opts = { series: 'equity' };

  function draw() {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = 220;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const pts = points
      .map((p) => (opts.series === 'equity' ? p.equity : (p.unrealized_pnl ?? 0)))
      .map((v) => (v == null ? 0 : v));
    if (pts.length < 2) {
      ctx.fillStyle = '#8a97b1';
      ctx.fillText('Not enough history yet.', 12, 24);
      return;
    }
    const min = Math.min(...pts), max = Math.max(...pts), pad = 24;
    const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
    const y = (v) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - pad * 2));
    ctx.strokeStyle = '#222b3d';
    ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
    ctx.strokeStyle = pts[pts.length - 1] >= pts[0] ? '#1fd09a' : '#ff5d6c';
    ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    ctx.fillStyle = '#e6ebf5';
    ctx.fillText(
      (opts.series === 'equity' ? '$' : '') + pts[pts.length - 1].toFixed(2),
      w - pad - 60,
      y(pts[pts.length - 1]) - 6,
    );
  }

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  return {
    render(nextPoints, nextOpts = {}) {
      points = nextPoints || [];
      opts = { ...opts, ...nextOpts };
      draw();
    },
    destroy() { window.removeEventListener('resize', onResize); },
  };
}
