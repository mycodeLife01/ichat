import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { scenes, getScene } from "../scenarios/registry";
import { proposals } from "../proposals/registry";
import "./workbench.css";
import { designFingerprint } from "../../catalog/baseline.json";
function Workbench() {
  const query = new URLSearchParams(location.search);
  const [id, setId] = useState(getScene(query.get("scene")).id);
  const [proposal, setProposal] = useState(
    proposals.some((p) => p.id === query.get("proposal"))
      ? query.get("proposal")!
      : "current",
  );
  const [revision, setRevision] = useState(0);
  const [width, setWidth] = useState(Number(query.get("width")) || 390);
  const [height, setHeight] = useState(Number(query.get("height")) || 844);
  const deskRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(true);
  const [available, setAvailable] = useState({ width: 1000, height: 700 });
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setAvailable({
        width: el.clientWidth - 64,
        height: el.clientHeight - 96,
      }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const zoom = fit
    ? Math.max(
        0.1,
        Math.min(1, available.width / width, available.height / height),
      )
    : 1;
  const [filter, setFilter] = useState("");
  const [notes, setNotes] = useState(true);
  const scene = getScene(id);
  const url = `/canvas.html?scene=${id}&proposal=${proposal}`;
  function select(next: string) {
    setId(next);
  }
  useEffect(() => {
    const p = new URLSearchParams({
      scene: id,
      proposal,
      width: String(width),
      height: String(height),
    });
    history.replaceState(null, "", `?${p}`);
  }, [id, proposal, width, height]);
  function control(action: string) {
    document
      .querySelector("iframe")
      ?.contentWindow?.postMessage(
        { type: "design:control", action },
        location.origin,
      );
  }
  function download() {
    const record = {
      proposalId: proposal,
      designStatus: "draft",
      implementationStatus: "not-started",
      sceneIds: [id],
      viewport: { width, height },
      sourceCommit: "7d01cfa6b542f98ee67d8a54a437748a60f4c190",
      designCommit: null,
      designFingerprint,
      approvedBy: null,
      approvedAt: null,
      notes: "",
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${proposal}-${id}.review.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="workbench">
      <aside className="catalog">
        <header>
          <a href="/" className="brand">
            Piko<span>Design</span>
          </a>
          <p>页面 · 状态 · 交互</p>
        </header>
        <input
          className="filter"
          aria-label="筛选设计场景"
          placeholder="查找页面或状态"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <nav>
          {[...new Set(scenes.map((s) => s.group))].map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {scenes
                .filter(
                  (s) =>
                    s.group === group &&
                    `${s.name}${s.id}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                )
                .map((s) => (
                  <button
                    key={s.id}
                    aria-current={id === s.id ? "page" : undefined}
                    onClick={() => select(s.id)}
                  >
                    {s.name}
                    {s.outcome && <span className="state-dot" />}
                  </button>
                ))}
            </section>
          ))}
        </nav>
        <footer>基线 7d01cfa · 独立 UI 设计册</footer>
      </aside>
      <main className="studio">
        <header className="toolbar">
          <div className="heading">
            <span>{scene.group}</span>
            <h1>{scene.name}</h1>
          </div>
          <select
            aria-label="设计版本"
            value={proposal}
            onChange={(e) => {
              setProposal(e.target.value);
              history.replaceState(
                null,
                "",
                `?scene=${id}&proposal=${e.target.value}`,
              );
            }}
          >
            {proposals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              localStorage.removeItem("piko-design.shared-snapshots.v1");
              setRevision((v) => v + 1);
            }}
          >
            重置
          </button>
          <button onClick={() => setNotes((n) => !n)} aria-pressed={notes}>
            说明
          </button>
          <a href={url} target="_blank" rel="noreferrer">
            独立打开 ↗
          </a>
        </header>
        <div className="viewportbar">
          <div className="presets">
            <button
              onClick={() => {
                setWidth(1440);
                setHeight(900);
              }}
            >
              桌面
            </button>
            <button
              onClick={() => {
                setWidth(390);
                setHeight(844);
              }}
            >
              移动
            </button>
            <label>
              <input
                aria-label="画布宽度"
                type="number"
                min="280"
                max="2560"
                value={width}
                onChange={(e) =>
                  setWidth(Math.max(280, Number(e.target.value)))
                }
              />{" "}
              ×{" "}
              <input
                aria-label="画布高度"
                type="number"
                min="320"
                max="1600"
                value={height}
                onChange={(e) =>
                  setHeight(Math.max(320, Number(e.target.value)))
                }
              />
              <span>px</span>
            </label>
          </div>
          <div className="timeline">
            <button aria-pressed={fit} onClick={() => setFit((v) => !v)}>
              {fit ? "100%" : "适应窗口"}
            </button>
            <button onClick={() => control("play")}>播放生成</button>
            <button onClick={() => control("pause")}>暂停</button>
            <button onClick={() => control("step")}>下一步</button>
            {scene.outcome === "loading" && (
              <button onClick={() => control("release")}>完成等待</button>
            )}
          </div>
        </div>
        <div className="desk" ref={deskRef}>
          <div className="frame-label">
            <span>{proposal === "current" ? "当前基线" : "候选草稿"}</span>
            <span>
              {width} × {height} · {Math.round(zoom * 100)}%
            </span>
          </div>
          <div
            className="frame-wrap"
            style={{ width: width * zoom, height: height * zoom }}
          >
            <iframe
              key={`${url}-${revision}`}
              title="产品设计画布"
              src={url}
              style={{
                width,
                height,
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
              allow="clipboard-read; clipboard-write"
            />
          </div>
        </div>
        {notes && (
          <aside className="inspector">
            <div>
              <strong>场景说明</strong>
              <p>{scene.note}</p>
            </div>
            <div>
              <strong>设计参照</strong>
              <p>{proposals.find((p) => p.id === proposal)?.description}</p>
              <code>{scene.source}</code>
            </div>
            <div>
              <strong>交互检查</strong>
              <p>
                可直接点击页面内入口。失败场景首次操作失败，再试可成功；等待场景可点击“完成等待”。管理入口可输入
                design-demo。
              </p>
            </div>
            <button onClick={download}>导出待确认记录</button>
          </aside>
        )}
      </main>
    </div>
  );
}
if (location.pathname.startsWith("/share/"))
  location.replace(
    `/canvas.html?scene=share&token=${encodeURIComponent(location.pathname.split("/")[2])}`,
  );
else createRoot(document.getElementById("root")!).render(<Workbench />);
