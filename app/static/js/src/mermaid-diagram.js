export async function renderMermaid(target, source, mermaidModuleUrl) {
  const mermaidModule = await import(mermaidModuleUrl);
  const mermaid = mermaidModule.default;
  mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
  const { svg } = await mermaid.render("happy-path-diagram", source.trim());
  target.innerHTML = svg;
}
