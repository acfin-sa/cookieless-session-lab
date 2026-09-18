let mermaidInitialized = false;
let diagramSeq = 0;

export async function renderMermaid(target, source, mermaidModuleUrl) {
  const mermaidModule = await import(mermaidModuleUrl);
  const mermaid = mermaidModule.default;

  if (!mermaidInitialized) {
    mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    mermaidInitialized = true;
  }
  diagramSeq += 1;
  const { svg } = await mermaid.render(`happy-path-diagram-${diagramSeq}`, source.trim());

  target.innerHTML = svg;
}
