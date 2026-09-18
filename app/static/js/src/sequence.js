import { renderMermaid } from "./mermaid-diagram.js";

const target = document.getElementById("mermaid-target");
const sourceNode = document.getElementById("mermaid-source");
const mermaidModuleUrlNode = document.getElementById("mermaid-module-url");
if (!target) {
  throw new Error("Missing mermaid target on sequence.html");
}
if (!sourceNode) {
  target.textContent = "Missing mermaid source on sequence.html";
}
if (!mermaidModuleUrlNode) {
  target.textContent = "Missing mermaid module URL on sequence.html";
}

try {
  const mermaidSource = JSON.parse(sourceNode.textContent);
  renderMermaid(target, mermaidSource).catch((error) => {
    target.textContent = error.message;
  });
} catch (error) {
  target.textContent = error instanceof Error ? error.message : "Failed to parse mermaid source";
}
