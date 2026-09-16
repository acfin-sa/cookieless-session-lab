import { renderMermaid } from "./mermaid-diagram.js";

const target = document.getElementById("mermaid-target");
const sourceNode = document.getElementById("mermaid-source");
if (!target || !sourceNode) {
  throw new Error("Missing mermaid target or source on sequence.html");
}

const mermaidSource = JSON.parse(sourceNode.textContent);
renderMermaid(target, mermaidSource).catch((error) => {
  target.textContent = error.message;
});
