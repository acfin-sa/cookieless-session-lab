import { renderMermaid } from "./mermaid-diagram.js";

const target = document.getElementById("mermaid-target");
const sourceNode = document.getElementById("mermaid-source");
const mermaidModuleUrlNode = document.getElementById("mermaid-module-url");
if (!target || !sourceNode || !mermaidModuleUrlNode) {
  throw new Error("Missing mermaid target, source, or module URL on sequence.html");
}

const mermaidSource = JSON.parse(sourceNode.textContent);
const MERMAID_MODULE_URL = JSON.parse(mermaidModuleUrlNode.textContent);
if (!MERMAID_MODULE_URL) {
  throw new Error("MERMAID_MODULE_URL is empty");
}

renderMermaid(target, mermaidSource, MERMAID_MODULE_URL).catch((error) => {
  target.textContent = error.message;
});
