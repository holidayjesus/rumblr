const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  applyOptions(node, options);
  appendChildren(node, children);
  return node;
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  });
  appendChildren(node, children);
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
}

function applyOptions(node, options) {
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style") Object.assign(node.style, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  });
}

function appendChildren(node, children) {
  const list = Array.isArray(children) ? children : [children];
  list.forEach((child) => {
    if (child === undefined || child === null || child === false) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
}
