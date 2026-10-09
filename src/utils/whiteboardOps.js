// Validation for the richer whiteboard items (equations, mind maps, images). Returns the extra
// fields to store with the board operation; throws an AppError for anything malformed.
const AppError = require('./AppError');

function validateExtra(o) {
  if (o.type === 'math') {
    const latex = String(o.text || '').trim();
    if (!latex || latex.length > 500) throw new AppError('Write the equation (LaTeX, up to 500 characters).', 422);
    return {};
  }
  if (o.type === 'image') {
    if (!/^https:\/\//.test(String(o.url || '')) || String(o.url).length > 3000) throw new AppError('Board images must be an https:// link.', 422);
    return { url: String(o.url) };
  }
  if (o.type === 'mindmap') {
    const nodes = Array.isArray(o.nodes) ? o.nodes : [];
    if (nodes.length < 2 || nodes.length > 40) throw new AppError('A mind map needs 2 to 40 ideas.', 422);
    const ids = new Set();
    const clean = nodes.map((n) => {
      const id = String(n?.id || '').slice(0, 12);
      const label = String(n?.label || '').trim().slice(0, 80);
      if (!id || !label || ids.has(id)) throw new AppError('Every mind-map idea needs a unique id and a label.', 422);
      ids.add(id);
      return { id, label, parent: n.parent == null ? null : String(n.parent).slice(0, 12) };
    });
    const roots = clean.filter((n) => n.parent === null);
    if (roots.length !== 1) throw new AppError('A mind map has exactly one central idea.', 422);
    if (clean.some((n) => n.parent !== null && !ids.has(n.parent))) throw new AppError('Every idea must hang off another idea in the map.', 422);
    return { nodes: clean };
  }
  return {};
}

module.exports = { validateExtra };
