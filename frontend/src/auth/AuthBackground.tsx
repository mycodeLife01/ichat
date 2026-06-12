import { useEffect, useRef } from "react";

// Designed background for the auth screen: soft drifting blobs, a masked grid,
// animated wavy ribbons and a grain overlay. Ported from the demo design.
const RIBBONS = [
  { y: 0.22, amp: 28, k: 1.5, speed: 0.00018, op: 0.08, w: 1.0 },
  { y: 0.46, amp: 56, k: 0.9, speed: 0.00014, op: 0.05, w: 1.4 },
  { y: 0.78, amp: 34, k: 1.7, speed: 0.00022, op: 0.08, w: 1.1 },
];

export function AuthBackground() {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof requestAnimationFrame !== "function") return;

    const SVG_NS = "http://www.w3.org/2000/svg";
    const paths = RIBBONS.map((r) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("stroke-opacity", String(r.op));
      p.setAttribute("stroke-width", String(r.w));
      svg.appendChild(p);
      return p;
    });

    let W = 0;
    let H = 0;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      W = rect.width;
      H = rect.height;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    };
    measure();
    window.addEventListener("resize", measure);

    const build = (r: (typeof RIBBONS)[number], t: number) => {
      const baseY = H * r.y;
      const steps = 56;
      const dx = W / steps;
      let d = `M -20 ${baseY.toFixed(1)}`;
      for (let i = 0; i <= steps; i++) {
        const x = i * dx;
        const phase = t * r.speed + i * 0.08 * r.k;
        const y =
          baseY +
          Math.sin(phase) * r.amp +
          Math.sin(phase * 1.6 + i * 0.04) * r.amp * 0.32;
        d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      d += ` L ${(W + 20).toFixed(1)} ${baseY.toFixed(1)}`;
      return d;
    };

    let raf = 0;
    const tick = () => {
      const t = performance.now();
      for (let i = 0; i < RIBBONS.length; i++) {
        paths[i].setAttribute("d", build(RIBBONS[i], t));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      paths.forEach((p) => p.remove());
    };
  }, []);

  const blob = "absolute rounded-full bg-fg blur-[100px] will-change-transform";

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="auth-grid" />
      <div
        className={`${blob} -top-[140px] -left-20 h-[480px] w-[480px] animate-auth-drift-1 opacity-[0.07]`}
      />
      <div
        className={`${blob} -right-[120px] -bottom-[200px] h-[600px] w-[600px] animate-auth-drift-2 opacity-[0.05]`}
      />
      <div
        className={`${blob} top-[40%] right-[18%] h-[280px] w-[280px] animate-auth-drift-3 opacity-[0.04]`}
      />
      <svg
        className="absolute inset-0 h-full w-full fill-none stroke-fg [stroke-linecap:round]"
        ref={svgRef}
        preserveAspectRatio="none"
      />
      <div className="auth-grain" />
    </div>
  );
}
