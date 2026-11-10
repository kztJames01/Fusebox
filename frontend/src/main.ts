import { initHeroScene } from "./heroScene.js";

document.documentElement.classList.add("js");

function initTabs(): void {
  const groups = new Map<string, HTMLButtonElement[]>();
  for (const tab of document.querySelectorAll<HTMLButtonElement>("[role=tab][data-tabgroup]")) {
    const key = tab.dataset.tabgroup ?? "";
    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }

  for (const tabs of groups.values()) {
    const select = (target: HTMLButtonElement, focus: boolean): void => {
      for (const tab of tabs) {
        const active = tab === target;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
        if (panel) panel.hidden = !active;
      }
      if (focus) target.focus();
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        let next = -1;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        const target = next >= 0 ? tabs[next] : undefined;
        if (target) {
          event.preventDefault();
          select(target, true);
        }
      });
    });
  }
}

function initCopy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset.copy ?? "");
      const text = (source?.textContent ?? "").trim().replace(/^\$\s+/, "");
      const status = button.closest("section")?.querySelector<HTMLElement>(".status");
      if (text.length === 0 || !status) return;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        status.textContent = "Copied to clipboard.";
      } catch {
        status.textContent = "Select the command and copy it manually.";
      }
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1800);
    });
  }
}

function initHeader(): void {
  const header = document.querySelector<HTMLElement>(".top");
  if (!header) return;
  let scheduled = false;
  const update = (): void => {
    const available = document.documentElement.scrollHeight - window.innerHeight;
    const progress = available > 0 ? Math.min(window.scrollY / available, 1) : 0;
    header.classList.toggle("scrolled", window.scrollY > 8);
    header.style.setProperty("--scroll-progress", progress.toFixed(4));
    scheduled = false;
  };
  const requestUpdate = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  };
  update();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", requestUpdate, { passive: true });
}

function initReveals(): void {
  const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  const timeline = document.querySelector<HTMLElement>(".timeline");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    for (const element of elements) element.classList.add("is-visible");
    timeline?.style.setProperty("--timeline-progress", "1");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        element.classList.add("is-visible");
        observer.unobserve(element);
        if (element.dataset.reveal === "step" && timeline) {
          const steps = Array.from(timeline.querySelectorAll<HTMLElement>("[data-reveal=step]"));
          const active = steps.filter((step) => step.classList.contains("is-visible")).length;
          timeline.style.setProperty("--timeline-progress", String(active / steps.length));
        }
      }
    },
    { threshold: 0.08, rootMargin: "0px 0px -8% 0px" },
  );
  for (const element of elements) observer.observe(element);
}

function initHero(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#hero-canvas");
  const visual = canvas?.closest<HTMLElement>(".hero-visual");
  if (!canvas || !visual) return;
  const showFallback = (): void => visual.classList.add("is-fallback");
  canvas.addEventListener("webglcontextlost", showFallback, { once: true });
  try {
    initHeroScene(canvas);
  } catch {
    showFallback();
  }
}

initTabs();
initCopy();
initHeader();
initReveals();
initHero();
