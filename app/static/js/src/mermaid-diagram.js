export async function renderMermaid(target, source) {
  const mermaidModule = await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
  const mermaid = mermaidModule.default;
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
  const { svg } = await mermaid.render("happy-path-diagram", source.trim());
  target.innerHTML = svg;
}
